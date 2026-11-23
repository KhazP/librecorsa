"""
Minimum-lap-time racing line by optimal control: a single-track (bicycle) car with yaw inertia, longitudinal load
transfer, aero load and a friction ellipse per axle, driven round the track in curvilinear coordinates and solved as
one nonlinear programme with CasADi + IPOPT. The formulation is the one of Perantoni & Limebeer, "Optimal control for
a Formula One car with variable parameters" (Vehicle System Dynamics, 2014) and of TUM's minimum-time planner (Christ,
Wischnewski, Heilmeier, Lohmann, "Time-optimal trajectory planning for a race car considering variable tyre-road
friction coefficients", 2021), with a single-track car in place of their double-track one.

Why it exists: the speed plan behind scripts/ai/optimize-lines.ts is a point mass on the car's measured limits. It
turns for free, so on a slow corner it can rate the short path through the inside above a wide entry. The car here has
to rotate: it carries a yaw rate it can only build with tyre forces at each axle, its front axle gains load under
braking and loses it on power, and its slip angles cost grip. It is one more start for optimize-lines.ts, judged on the
full physics like the others. On Qiddiya (Nov 2026) its line and optimize-lines.ts's own refined line came out the
same shape and within 0.3 s of each other on the physics (both about 10 s quicker than the line of the old pattern
search); the refined one was kept, the solver's being less robust at a higher plan grip.

Calibrated on the car's own measured limits (scripts/ai/measure-ggv.ts, src/lib/sim/ai/ggv.ts), as the point-mass
plan is: with the aero load split between the axles like the weight, the lateral and braking friction against speed
are chosen so a steady corner and a straight-line stop come out at the table's limits (times the plan grip), and the
drive force is the table's acceleration plus the drag. Mass split, wheelbase, CG height and yaw inertia come from the
car's chassis config. Its own lap time runs a couple of seconds under the point-mass plan's of the same line.

    uv run --no-project --python 3.12 --with-requirements scripts/ai/mintime/requirements.txt \\
        python -I scripts/ai/mintime/solve.py problem.json line.json

problem.json (scripts/ai/lib/mintime.ts writes it): the AI grid (`ds`, `kappa` + left, `lo` / `hi` the car centre's
bounds + left, `slope` + uphill, `bank` + raising the left edge, `vcurv` + in a dip), a start (`n0` + left, `v0`),
`step` (grid points per interval), `closed` (a lap) or `finishI` (a hill climb's run from rest), and `car`.
line.json: `n` (+ left) and `v` on the same grid, the solved lap or run time `lapS`, and IPOPT's `status`.
"""
import json
import sys
import time

import casadi as ca
import numpy as np

G = 9.81


def fit_car(car):
    """The model's speed-dependent friction, drive and drag from the measured tables"""
    v = np.asarray(car['speeds'], float)
    grip = float(car.get('grip', 1.0))
    lat = np.asarray(car['latG'], float) * grip
    brk = np.asarray(car['brakeG'], float) * grip
    acc = np.asarray(car['accelG'], float)
    # Aero load per v² (in g): the lateral limit as μ0·(1 + kA·v²), least squares
    A = np.vstack([np.ones_like(v), v ** 2]).T
    a0, a1 = np.linalg.lstsq(A, lat, rcond=None)[0]
    kA = max(0.0, a1 / a0)
    # Drag per mass per v²: the top speeds' acceleration as power-limited, a·g = P/v − D·v²
    hi = v >= np.sort(v)[-3]
    B = np.vstack([1.0 / v[hi], -(v[hi] ** 2)]).T
    _, D = np.linalg.lstsq(B, acc[hi] * G, rcond=None)[0]
    D = float(max(0.0, D))
    # On a fine grid out to past the top speed: friction held at the table's ends, the drive extrapolated linearly
    vv = np.linspace(1.0, max(110.0, v[-1] + 25), 220)
    latv = np.interp(vv, v, lat)
    brkv = np.interp(vv, v, brk)
    slope = (acc[-1] - acc[-2]) / (v[-1] - v[-2])
    accv = np.where(vv > v[-1], acc[-1] + slope * (vv - v[-1]), np.interp(vv, v, acc))
    load = 1.0 + kA * vv ** 2
    muY = latv / load
    muX = np.maximum(0.2, (brkv * G - D * vv ** 2) / (G * load))
    adMax = np.maximum(0.0, accv * G + D * vv ** 2)
    spline = lambda name, y: ca.interpolant(name, 'bspline', [vv], y.tolist())
    return dict(kA=kA, D=D, vmax=float(vv[-1]), muY=spline('muY', muY), muX=spline('muX', muX), adMax=spline('adMax', adMax))


def build(prob):
    car = prob['car']
    fit = fit_car(car)
    L = float(car['wheelbase'])
    wf = float(car['frontWeightFraction'])
    lf, lr = L * (1 - wf), L * wf
    h = float(car['cgHeight'])
    kz = float(car['yawInertia']) / float(car['mass'])
    dmax = float(car['deltaMax'])
    # Lateral tyre curve: F = μ·Fz·sin(C·atan(B·α)), peak at `alphaPeak`
    C = float(car.get('shapeC', 1.6))
    Bt = np.tan(np.pi / (2 * C)) / float(car.get('alphaPeak', 0.1))
    kA, D = fit['kA'], fit['D']

    x = ca.SX.sym('x', 5)  # n, xi, vx, vy, r
    u = ca.SX.sym('u', 4)  # delta, ad (drive), bf, br (brake per axle, ≥ 0), all per mass (m/s²) but delta
    p = ca.SX.sym('p', 4)  # kappa, slope, bank, vcurv
    n, xi, vx, vy, r = x[0], x[1], x[2], x[3], x[4]
    delta, ad, bf, br = u[0], u[1], u[2], u[3]
    kap, th, ph, vc = p[0], p[1], p[2], p[3]
    vcl = ca.fmin(ca.fmax(vx, 1.0), fit['vmax'])
    ax = ad - bf - br - D * vx ** 2
    fz = G * ca.cos(th) * ca.cos(ph) + vx ** 2 * vc + G * kA * vx ** 2
    fzf = fz * lr / L - h / L * ax
    fzr = fz * lf / L + h / L * ax
    aF = delta - ca.atan2(vy + lf * r, vx)
    aR = -ca.atan2(vy - lr * r, vx)
    sF = ca.sin(C * ca.atan(Bt * aF))
    sR = ca.sin(C * ca.atan(Bt * aR))
    muY, muX = fit['muY'](vcl), fit['muX'](vcl)
    fyf, fyr = muY * fzf * sF, muY * fzr * sR
    fxf, fxr = -bf, ad - br
    dvx = vy * r + fxf * ca.cos(delta) - fyf * ca.sin(delta) + fxr - D * vx ** 2 - G * ca.sin(th)
    dvy = -vx * r + fxf * ca.sin(delta) + fyf * ca.cos(delta) + fyr - G * ca.sin(ph)
    dr = (lf * (fxf * ca.sin(delta) + fyf * ca.cos(delta)) - lr * fyr) / kz
    sf = (1 - n * kap) / (vx * ca.cos(xi) - vy * ca.sin(xi))
    rhs = ca.vertcat(sf * (vx * ca.sin(xi) + vy * ca.cos(xi)), sf * r - kap, sf * dvx, sf * dvy, sf * dr, sf)
    f = ca.Function('f', [x, u, p], [rhs])
    # Friction ellipse per axle (≤ 1), the drive limit (≤ 0) and the axle loads, at a node with its interval's controls
    # (the ellipse as fx² ≤ (μx·Fz)²·(1 − (Fy / μy·Fz)²), in g², so a load near zero is no division by it)
    ell = ca.Function('ell', [x, u, p], [ca.vertcat(
        (fxf ** 2 - (muX * fzf) ** 2 * (1 - sF ** 2)) / G ** 2,
        (fxr ** 2 - (muX * fzr) ** 2 * (1 - sR ** 2)) / G ** 2,
        (ad - fit['adMax'](vcl)) / G, fzf / G, fzr / G, aF, aR)])

    # One interval by Radau IIA collocation, degree 3: implicit, so stable where the car's lateral and yaw modes are
    # fast against the step (at 15 m/s they settle within a metre or two, which an explicit 4 m step blows up on).
    # Inputs: the interval's start, its three collocation states, its controls, the road at its ends and its length;
    # outputs: the collocation residuals (0 when the states follow the car), the end state and the time taken
    d = 3
    tau = np.append(0, ca.collocation_points(d, 'radau'))
    Cm, Dm, Bm = np.zeros((d + 1, d + 1)), np.zeros(d + 1), np.zeros(d + 1)
    for j in range(d + 1):
        pl = np.poly1d([1.0])
        for q in range(d + 1):
            if q != j:
                pl *= np.poly1d([1.0, -tau[q]]) / (tau[j] - tau[q])
        Dm[j] = pl(1.0)
        dpl = np.polyder(pl)
        for q in range(d + 1):
            Cm[j, q] = dpl(tau[q])
        Bm[j] = np.polyint(pl)(1.0)
    hs = ca.SX.sym('hs')
    p0, p1 = ca.SX.sym('p0', 4), ca.SX.sym('p1', 4)
    Z = ca.SX.sym('Z', 5, d)
    res, dt = [], 0
    for j in range(1, d + 1):
        xp = Cm[0, j] * x
        for q in range(d):
            xp = xp + Cm[q + 1, j] * Z[:, q]
        fj = f(Z[:, j - 1], u, p0 + tau[j] * (p1 - p0))
        res.append(hs * fj[:5] - xp)
        dt = dt + Bm[j] * hs * fj[5]
    xend = Dm[0] * x
    for q in range(d):
        xend = xend + Dm[q + 1] * Z[:, q]
    F = ca.Function('F', [x, Z, u, p0, p1, hs], [ca.vertcat(*res), xend, dt])
    return dict(F=F, ell=ell, dmax=dmax, L=L, D=D, kA=kA, fit=fit, d=d, tau=tau)


def solve(prob, log=print):
    m = build(prob)
    alpha_peak = float(prob['car'].get('alphaPeak', 0.1))
    ds = float(prob['ds'])
    k = int(prob.get('step', 2))
    closed = bool(prob.get('closed', True))
    npts = len(prob['kappa'])
    end = npts if closed else int(prob['finishI'])
    idx = np.arange(0, end, k)
    if closed:
        # Node grid indices; a lap's last node is its first again
        nodes = np.append(idx, npts)
    else:
        nodes = idx if idx[-1] == end else np.append(idx, end)
    N = len(nodes) - 1
    hs = np.diff(nodes) * ds
    arr = lambda key: np.asarray(prob[key], float)
    kap, slope, bank, vcurv = arr('kappa'), arr('slope'), arr('bank'), arr('vcurv')
    lo, hi, n0, v0 = arr('lo'), arr('hi'), arr('n0'), arr('v0')
    at = lambda a, j: a[j % npts]
    P = np.array([[at(kap, j), at(slope, j), at(bank, j), at(vcurv, j)] for j in nodes]).T  # 4 × (N+1)
    # Each interval's mean centreline curvature, held across it (its ends alone can sit on a kink of the centreline);
    # slope, banking and vertical curvature from its two ends
    km = np.array([np.mean([at(kap, j) for j in range(nodes[c], nodes[c + 1] + 1)]) for c in range(N)])
    P0 = np.vstack([km, P[1:, :N]])
    P1 = np.vstack([km, P[1:, 1:N + 1]])

    xs = np.array([4.0, 0.3, 40.0, 2.0, 1.0])
    us = np.array([0.2, 10.0, 20.0, 20.0])
    opti = ca.Opti()
    d = m['d']
    Xs = opti.variable(5, N + 1)
    Zs = opti.variable(5, d * N)
    Us = opti.variable(4, N)
    X = ca.diag(xs) @ Xs
    Zc = ca.diag(xs) @ Zs
    U = ca.diag(us) @ Us
    Fm = m['F'].map(N)
    R, Xn, dT = Fm(X[:, :N], Zc, U, ca.DM(P0), ca.DM(P1), ca.DM(hs[:N]).T)
    # Residuals in the states' own scales
    opti.subject_to(ca.vec(ca.diag(np.tile(1 / xs, d)) @ R) == 0)
    opti.subject_to(X[:, 1:] == Xn)
    opti.subject_to(Zc[2, :] >= 3.0)
    T = ca.sum2(dT)
    # Smooth controls: the steering and the pedals change over metres, not in a step
    dU = U[:, 1:] - U[:, :-1] if not closed else ca.horzcat(U[:, 1:], U[:, :1]) - U
    hm = float(np.mean(hs))
    reg = 10.0 * ca.sumsqr(dU[0, :] / hm) * hm + 1e-4 * ca.sumsqr(dU[1:, :])
    opti.minimize(T + reg)
    nb = nodes % npts
    # Each node's bounds are the narrowest road from the node before it to the node after, so the line drawn straight
    # between nodes stays inside at every grid point between them
    nlo, nhi = np.empty(N + 1), np.empty(N + 1)
    for c, j in enumerate(nodes):
        a = nodes[c - 1] if c > 0 else (j - k if closed else j)
        b = nodes[c + 1] if c < N else (j + k if closed else j)
        win = [at(lo, q) for q in range(a, b + 1)], [at(hi, q) for q in range(a, b + 1)]
        nlo[c], nhi[c] = max(win[0]), min(win[1])
        if nlo[c] > nhi[c]:
            nlo[c] = nhi[c] = 0.5 * (nlo[c] + nhi[c])
    opti.subject_to(opti.bounded(ca.DM(nlo).T, X[0, :], ca.DM(nhi).T))
    opti.subject_to(opti.bounded(-1.2, X[1, :], 1.2))
    opti.subject_to(X[2, :] >= 3.0)
    opti.subject_to(opti.bounded(-m['dmax'], U[0, :], m['dmax']))
    opti.subject_to(ca.vec(U[1:, :]) >= 0)
    E = m['ell'].map(N)(X[:, :N], U, ca.DM(P0))
    opti.subject_to(E[0, :] <= 0)
    opti.subject_to(E[1, :] <= 0)
    opti.subject_to(E[2, :] <= 0)
    opti.subject_to(E[3, :] >= 0.05)
    opti.subject_to(E[4, :] >= 0.05)
    # Slip angles past the peak cost grip and get no faster; keeping them near it keeps the search out of spins
    opti.subject_to(opti.bounded(-2.5 * alpha_peak, E[5, :], 2.5 * alpha_peak))
    opti.subject_to(opti.bounded(-2.5 * alpha_peak, E[6, :], 2.5 * alpha_peak))
    opti.subject_to(opti.bounded(-4.0, X[3, :], 4.0))
    opti.subject_to(opti.bounded(-2.5, X[4, :], 2.5))
    if closed:
        opti.subject_to(X[:, N] == X[:, 0])
    else:
        opti.subject_to(X[2, 0] == 3.0)
        opti.subject_to(X[3:, 0] == 0)

    # Start: the given line, its heading against the centreline, the given speeds, the kinematic yaw rate and steer
    def smooth(a, w):
        kern = np.ones(w) / w
        return np.convolve(np.concatenate([a[-w:], a, a[:w]]), kern, 'same')[w:-w] if closed else np.convolve(a, kern, 'same')
    sn = np.cumsum(np.append(0, hs))[: N + 1]
    ng = np.clip(n0[nb], nlo, nhi)
    xig = smooth(np.arctan2(np.gradient(ng, sn), 1 - ng * P[0]), 5)
    kp = smooth((np.gradient(xig, sn) + P[0]) / np.maximum(0.2, 1 - ng * P[0]), 5)
    # A little under the point-mass plan: a start the car can follow
    vg = np.maximum(5.0, 0.95 * v0[nb])
    Xg = np.vstack([ng, xig, vg, np.zeros_like(ng), vg * kp])
    acc = np.append(np.diff(vg ** 2) / (2 * hs), 0)[:N]
    Ug = np.vstack([np.clip(m['L'] * kp[:N], -m['dmax'], m['dmax']), np.maximum(acc, 0) + m['D'] * vg[:N] ** 2, 0.6 * np.maximum(-acc, 0), 0.4 * np.maximum(-acc, 0)])
    opti.set_initial(Xs, Xg / xs[:, None])
    # Collocation states on the straight line between their interval's ends
    Zg = np.hstack([Xg[:, c:c + 1] + np.outer(Xg[:, c + 1] - Xg[:, c], m['tau'][1:]) for c in range(N)])
    opti.set_initial(Zs, Zg / xs[:, None])
    opti.set_initial(Us, Ug / us[:, None])
    opti.solver('ipopt', {'expand': True, 'print_time': False}, {
        'max_iter': int(prob.get('maxIter', 3000)), 'tol': 1e-4, 'acceptable_tol': 1e-3, 'acceptable_iter': 10,
        'mu_strategy': 'adaptive', 'print_level': 5 if prob.get('verbose') else 3, 'linear_solver': 'mumps'})
    t0 = time.time()
    try:
        sol = opti.solve()
        status = 'solved'
        val = sol.value
    except RuntimeError as e:
        status = f'not solved: {e}'.splitlines()[0]
        val = opti.debug.value
    Xv = np.array(val(X))
    lapS = float(val(T))
    log(f'mintime: {N} intervals of {hm:.1f} m, {status} in {time.time() - t0:.0f} s, {"lap" if closed else "run"} {lapS:.3f} s '
        f'(kA {m["kA"]:.2e}/m²·s², drag {m["D"]:.2e}/m)')
    # Back onto the full grid (linear between nodes)
    grid = np.arange(npts)
    xn = nodes.astype(float)
    if closed:
        n_out = np.interp(grid, xn, Xv[0])
        v_out = np.interp(grid, xn, Xv[2])
    else:
        # Past the finish (the run-off road and the stretch with no road) the given line, eased into over 50 m
        n_out = np.interp(grid, xn, Xv[0], right=0.0)
        v_out = np.interp(grid, xn, Xv[2], right=float(Xv[2, -1]))
        last, ease = int(xn[-1]), max(1, int(round(50 / ds)))
        for g in range(last + 1, npts):
            w = 0.5 * (1 - np.cos(np.pi * min(1.0, (g - last) / ease)))
            n_out[g] = (1 - w) * Xv[0, -1] + w * n0[g]
            v_out[g] = v0[g]
    # Inside by construction (the nodes' bounds); the clip only absorbs rounding
    n_out = np.clip(n_out, lo, hi)
    return dict(n=n_out.tolist(), v=v_out.tolist(), lapS=lapS, status=status, intervals=N)


if __name__ == '__main__':
    with open(sys.argv[1]) as fh:
        problem = json.load(fh)
    out = solve(problem, log=lambda s: print(s, file=sys.stderr))
    with open(sys.argv[2], 'w') as fh:
        json.dump(out, fh)
