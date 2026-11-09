# Race AI foundation: design and status

**Status (2026-11-07, branch `claude/race-ai`):** phases 0–2 built, phase 4's planner built but off by default,
phase 5's first tuner run done (defaults kept). Approved decisions: §8.

## Where it stands

| Piece | State | Measured |
|---|---|---|
| D8 tooling | `scripts/ai/line-report.ts` (per corner, vs OpenF1 and `fast_lane.ai`), `measure-ggv.ts`, `check-lines.ts` | OpenF1 fit at Spielberg 3.2 m rms |
| D2 AI grid | `src/lib/sim/ai/ai-track.ts` | 2 m spacing, 3D (slope, crests, banking) |
| g-g-v | `src/lib/sim/ai/ggv.ts`, measured per car on its own physics | compression grip per car (VF26 0.15: its floor stalls), steering-lock curvature |
| D1 tracker | pure pursuit + integral on the plan, in the f12026-car / GT3 autopilot; the VF26's driver takes the plan as its profile | physics lap within ~0.1 s of plan on most circuits (f12026-car, GT3); VF26 2–6 % under plan, mostly on exits: at Spielberg its plan expects ~10–15 % more acceleration than the car delivers over a lap (ERS / power), so most of the gap is an optimistic plan, not lost pace. Its braking zones still lose 0.1–0.15 s each |
| D3 lines | lap-time optimised on the car's limits, bounded by its usable road, the steering lock and barrier clearance, accepted only on a clean physics lap | Spielberg F1 75.3 → 70.1 s physics; line 2.3 m from the real 2026 line, corner speeds 6 % low |
| Line check | `metadata.aiPlans` per car and circuit; the field drives plans only where it passed | 51 of 60 pass (20 circuits × 3 cars). Fails: Monaco and Spielberg inner (all cars), Silverstone and Yas Marina (f12026-car), Daytona road (GT3) |
| VF26 field on plans | 8-car headless races | Rwanda best 1:33.2 → 1:31.9, Spielberg 1:13.7 → 1:12.3, same or fewer incidents |
| Grip ceiling | `check-lines.ts --ceiling 1,1.04,1.08`: the highest plan grip each car drives cleanly (2.5 m off the line at most), `aiPlans[car].maxGrip`. Alien plans to one step (0.04) under it | VF26 1.04–1.08 on most circuits, but 0.95 at Spielberg and the Daytona oval. Alien, 6 races: VF26 Okayama −2.1 s, Rwanda −1.8 s; f12026-car Okayama −0.4 s, Spielberg −0.3 s; about one more car spinning per race in the VF26 at Okayama |
| Starts | per-driver reaction (0.17–0.30 s by skill, now and then a bogged launch); the launch clutch reads the AI's wanted pedal; the f12026-car / GT3 autopilot floors it from rest | AI within 2–7 % of a flat-out launch after its reaction (verify-race-craft) |
| D4 planner | `src/lib/sim/ai/local-planner.ts`, Frenet quintics, cars ahead as hard obstacles | more passes, more incidents: off by default |
| D7 tuning | `scripts/ai/tune-racecraft.ts`, cross-entropy over the racecraft knobs | VF26 run done (30 generations, Spielberg + Okayama, 2 seeds). On 10 held-out seeds per track the best candidate scored 2.5 ± 1.5 worse than the defaults, with more spins and contacts; the distribution mean tied (−0.1 ± 1.0). Defaults kept: the search fitted seed noise. A useful next run needs more seeds per candidate. |

**Open problems**

- **Monaco:** every car hits the barriers on the plan even at 80 % grip: slow corners cut ~0.5–1 m inside the
  line and the nose finds the apex walls, and fast sweeps (the swimming pool) run wide. The field keeps its own
  drivers there.
- **Spielberg inner:** no line is trackable yet.
- **Pile-ups (fixed):** a car stranded in the gravel drew every car behind it to the road edge and off; and a car
  without the corner eased off too little to tuck in. Six VF26 races at Okayama and Spielberg: wall hits 62 → 0,
  spins 24 → 3, retirements 8 → 0.
- **Lap-1 contact:** the VF26's bog off the line is fixed (its auto-clutch read the feathered pedal). A turn-1
  collision at Okayama still happens now and then.
- **Spielberg for the VF26:** its grip ceiling is 0.95 (2.6 m off the line at 1.0), so Alien gains little there.
  Next: re-optimise the line at a higher grip, or win back the braking-zone losses.
- **Start defence in the tuner (run done, defaults kept):** `--mode defence` tuned the five defence knobs (look-back,
  closing speed, reach, room, start lane) on a reversed grid, f12026, Spielberg + Okayama, 6 seeds, 15 generations.
  It settled on an earlier, roomier move (look 37 m, room 1.1 s; reach, closing and lane near the defaults). On 10
  fresh seeds at Spielberg, Okayama and Rwanda (held out), against the defaults: the mean +6.0 ± 5.9 (12 wins, 15
  losses), the best candidate +2.4 ± 6.7. Lap-1 places won barely moved (2.43 → 2.30, the quickest car's 1.03 →
  1.03). These thresholds are not what limits start defence. Next: the move itself (how often a driver defends,
  `defend` × skill, and one move per straight), measured against a real launch from behind.
- **Late apex** at Spielberg s ≈ 2624 is 38 m early against the real line.
- **GT3** has no real reference data.

The four research reports behind it are kept locally, not in the repo, in
`~/Documents/GitHub/_realism-ref/reports/race-ai/`:

- `00`: audit of our current code
- `01`: racing lines
- `02`: overtaking planners
- `03`: commercial sims

Each claim below is tagged with how much I trust it:

- **[R]** the source itself was read: code, the full paper, or the actual rules text.
- **[A]** only the abstract was read.
- **[M]** measured here in our own sim.
- **[I]** my own inference.

## 1. Why the current AI isn't good enough

Measured on Silverstone, F1 2026 car on the full physics model, AI at full pace, against the real 2026 pole lap (OpenF1 data):

| | Sim AI | Real pole |
|---|---|---|
| Lap time | 101.3 s | 88.1 s |
| Top speed | 316.5 km/h | 316.8 km/h |
| Corner minimum speed (average gap) | 28 % lower | |
| Peak cornering load | 2.4–3.5 g | 3.1–5.2 g |

Straight-line speed matches the real car. The time is lost in the corners. **[M]**

A trace through Maggotts/Becketts shows how:

- The stored racing line swings from 5.8 m left to 6.4 m right of centre within about 100 m, on a road 14.6 m wide.
- The AI car never gets further right than about 3.5 m. It holds there for 40 m while the line is at 6 m.
- The path it actually drives is far tighter than the one it planned for, so it brakes fully at s = 2920.
- It comes out at 190 km/h. The real car does 282 km/h. **[M]**

Two causes are possible: the autopilot's lateral clamp, or its pure-pursuit look-ahead (0.55 × speed, about 35 m) cutting the S-bend. I haven't yet pinned down which.

So there are three separate problems, in this order:

1. **The AI can't follow a line.** The f12026 autopilot rebuilds its own path: it clamps the line by about 1.2 m, smooths it over ±10 m and re-reads the curvature. It also plans speed from a hand-set braking envelope rather than the car model. The VF26 driver has no track-edge clamp at all. A perfect line would be distorted on the way to the wheels. **[R audit, M trace]**
2. **The stored lines aren't realistic.**
   - 8 tracks only have a smoothed "elastic band" line. Those are the 8 sim-grade circuits.
   - The 12 optimised tracks use a quasi-steady lap-time model, which is already the right kind of objective. Its gaps are no slope or crest effects, a coarse derivative-free search, no limit on how fast curvature changes, constant edge margins, and kernel sizes that depend on how many samples a track has (spacing runs from 0.78 to 5.83 m between tracks). **[R audit, R line report §0, I]**
3. **The racecraft is hand-written rules on one fixed line.**
   - The only interface to the car is a single sideways offset. There is no path input.
   - Off the racing line there's no speed plan: only fixed slow-downs per metre off-line.
   - The traffic thresholds read curvature that blends the racing line with the centreline, so changing a line changes how the AI races. **[R audit]**

## 2. Goals and non-goals

**Goals:**

- Lines a real driver would recognise. Checked by numbers against real telemetry and against human-recorded reference lines, not by eye.
- AI cars that go off the racing line to pass and defend, at believable speeds on those lines.
- Racing side by side that follows the FIA driving standards.
- Character and difficulty without rubber-banding.
- Everything tunable headlessly and repeatably, overnight.

**Non-goals for now:**

- Training a neural network with reinforcement learning. GT Sophy needed 10–21 PlayStations for days per car and track, plus hand-built scenarios. **[R Nature Methods]**
- Pit stops and race strategy.
- The 11 Sketchfab tracks.

## 3. Scope

| Group | Tracks |
|---|---|
| **Build and tune** | Rwanda; the 8 sim-grade circuits: Chang, Okayama, Okayama Piper, Okayama Drift, Spielberg, Spielberg South, Spielberg Inner, Monaco |
| **Validation only** | Silverstone. The Maggotts evidence and real telemetry are there. |
| **Later** | The other Sketchfab tracks. Their edges and widths are generated from the mesh, so a precise line would rest on unreliable geometry. |

Reference data, local only and never shipped:

- **Real F1 2026 pole laps (OpenF1):** Monaco, Spielberg and Silverstone. Skipping the Sketchfab tracks drops the other 5 tracks that have real data.
- **Original Assetto Corsa `fast_lane.ai` lines:** a recorded human line with speeds, for all 8 sim-grade circuits. They are in `~/Downloads/<track>/…/ai/`. **[M]**
- **No real GT3 data.** GT3 lines are checked against the `fast_lane.ai` lines and physics lap times only.

## 4. Decisions

### D1. The autopilot becomes a tracker

Both autopilots stop deriving their own path and speed plan. They follow a supplied target:

- a lateral offset n(s) and speed v(s), evaluated at the current point and at the look-ahead point;
- curvature feed-forward taken from that path;
- the friction-limit guards they already have.

The track-edge clamp lives in one shared place, which also fixes the VF26 having none.

This is the standard split in the commercial titles that document their AI, and in the Indy Autonomous Challenge stacks: a planner produces the trajectory, a controller tracks it. Examples:

- **Game AI Pro chapters 38–40** (Codemasters authors): a target speed and line per node, tracked by PID. **[R]**
- **Kunos, Assetto Corsa AI** (conference talk slides): PID toward a target point offset from the line. **[R]**
- **TII EuroRacing, Indy Autonomous Challenge:** a 20 Hz planner feeding a 100 Hz MPC. **[R]**

What this replaces:

- the autopilots' hand-set braking envelopes;
- their ±10 m re-smoothing;
- the fixed off-line slow-downs: −4 % per metre off-line, −1.2 % pace per metre, and the VF26 `wideScale`.

**Consequence:** all per-track tuning files in `public/ai/*.json` become obsolete. They mostly correct for line and edge problems, for example Silverstone's 1.2–1.6 m `extMarginM`. **[R audit]** Skill and per-driver errors move to D6.

**Acceptance:** on a track, the car follows its supplied path within ±0.3 m and its speed plan within 3 %, with no hidden slow-downs. That includes Maggotts at the path's own curvature.

### D2. Track representation for the AI

A separate data structure, built once per track at load:

- Flat typed arrays at a **fixed 2 m spacing**: centreline x/y/z, heading, curvature, slope, banking, vertical curvature, left/right width, kerb/grass/wall distances, surface grip.
- Mapping between Frenet coordinates (distance along the track, sideways offset) and world coordinates, with no allocation per call.

Today `getSampleAtDistance` allocates about 5 vectors per call, the f12026 autopilot makes about 63 such calls per 1/240 s slice, and the resampling to 1200 samples per track makes every kernel a different length on every track. **[R audit]**

Lines get their own schema, `lines: { id, class, n[], v[], brakeZones[] }`. The traffic logic stops reading line-blended curvature.

### D3. Line generation (offline, per track × car class)

1. **A speed model matched to the car.** Generate a g-g-v table per car class from our own physics: maximum braking and acceleration, and maximum lateral acceleration, as functions of speed and effective vertical load.
   - Source: TUM's racing-line repo works from such a table **[R]**; TUM's 3D race-track paper makes it depend on vertical load **[R]**.
   - Today the line model and the autopilot each use different simplified models. That is one reason the model said 122 s for GT3 at Sepang while the physics car lapped in 160 s. **[R audit]**
2. **3D effects.** Slope and vertical curvature enter as effective gravity: g̃ = g·cosθ·cosφ − v²·κ_vertical, with θ the slope and φ the banking.
   - The TUM 3D paper finds that leaving the vertical-curvature term out is a large error (123.2 s vs 119.9 s, with large limit violations), and that a flat 2D line laps 4–5 s slower at Bathurst and the Las Vegas oval. **[R]**
   - Spielberg, Okayama and Rwanda have real elevation changes.
3. **Starting line:** minimum curvature solved as a box-constrained quadratic problem with projected gradient, iterated (TUM IQP: at least 3 iterations, stop at 0.01 rad/m, plus an iteration cap). **[R]** A K1999-style coarse-to-fine version is the fallback. **[R]**
4. **Lap-time refinement:** gradient descent on the offsets, minimising Σ Δs/v from the speed model. Includes:
   - a penalty on curvature change rate, the role of TUM's steering-rate penalty **[R]**;
   - denser control points in braking and turn-in zones **[R Jain & Morari; TUM]**.
   - Kapania et al. (Stanford) converge in 4–5 iterations of a similar loop. **[R]**
5. **Kerbs:** kerbs are usable, with lower grip and a curvature-dependent inside margin, starting from Speed Dreams simplix's 0.5 + clamp(50|κ| − 1, 0, 1) m. **[R]** A study in Scientific Reports (2025) puts the value of kerb use at up to 0.84 s. **[R]**
6. **Full-physics refinement (the hours):** drive the 500 Hz car on the line repeatedly. Adjust braking points, apex speeds and local line shape per corner until the physics lap stops improving, rejecting any change that puts a wheel off the track.
   - This is the "AI laps overnight" step Codemasters describes for GRID Autosport **[R interview]**. Forza Motorsport 2023 ran 26,000 laps per track **[R forza.net]**.
7. **Alternative lines, each optimised on its own with its own speed profile.** Not offsets of the main line:
   - **inside / defend:** held at least 0.5–1.25 m inside centre in every corner;
   - **outside:** the mirror image;
   - **left / right lanes** for running side by side.
   - Precedents: Speed Dreams simplix computes left and right lanes with their own reduced grip and braking **[R]**; rFactor 2 bakes fastest, left, right and block paths **[R]**; the TUM 3D paper shows the best continuation after a forced offset is often a different line **[R]**.

**Acceptance per track and class:**

- The full-physics lap improves over the current line.
- Zero off-tracks over 10 laps.
- Against real data where it exists (Monaco, Spielberg, Silverstone validation), per corner:
  - lateral error of n(s) ≤ 1.0 m on average;
  - apex position within 10 m;
  - apex speed within 5 %.
- Against `fast_lane.ai`: the same metrics, more loosely, since those are hobbyist recordings.

### D4. Local planner: sampling in Frenet coordinates around the lines

Per car, replanning at **10 Hz**, staggered across cars. Up to 20 Hz when within 30 m of another car, if the budget allows.

- **Sources for the rates:**
  - TII EuroRacing, Indy Autonomous Challenge: 20 Hz.
  - TUM graph planner: 16.8 Hz.
  - GT Sophy: no gain above 10 Hz.
- **Horizon:** 3 s at 20 points.
- **Candidates:** about 150.
  - 9–11 lateral end offsets. They always include the racing line, each alternative line, and the points beside the target car (ETH Zurich F1TENTH "Spliner").
  - 6–8 end speeds.
  - Two curve types for each.
  - Generated **relative to the line** (TUM 3D planner, 2024): with no traffic, a candidate *is* the line and its speed, exactly. **[R]**
- **Feasibility:** track bounds, then lateral acceleration against the D3 g-g-v table with a 10 % margin (TUM 3D planner). If nothing passes, take the least-bad candidate. **[R]**
- **Cost** (starting weights taken from the papers, then tuned by D7):
  - distance from the line, speed error, and a proximity term (an ellipse in Frenet coordinates around each predicted car: TUM 3D planner, weights 0.1 / 100 / 5000);
  - a soft margin on top of the hard one (TII EuroRacing);
  - a consistency bonus for staying close to the last plan (TUM graph planner);
  - places gained and lost, rear-end impact speed, and any contact (GT Sophy's passing and collision rewards, 0.5 / 0.1 / 5 relative to progress = 1). **[R]**
- **Hard vetoes from the FIA driving standards:**
  - no second direction change when defending;
  - on returning to the line, leave a car's width to the edge (Appendix L, Art. 2b) **[R]**;
  - no direction change once braking has started, except to follow the racing line (F1 Driving Standards Guidelines 2026, section H) **[R]**;
  - leave room when the other car has priority under sections A/B: front axle at least alongside the mirror on the inside, or front axle ahead on the outside, at the apex **[R]**.
- **Prediction:**
  - **AI cars:** planned **in race order, leader first**. Each follower treats the committed plans of cars ahead as exact. This is the sequential game from Liniger & Lygeros, and TUM's "the rear car reacts to the leader" rule. **[R]**
  - **The player:** constant speed in Frenet coordinates, holding their offset, blended with a table of the player's own recent n(s) and v(s), as in ETH Zurich's Predictive Spliner. **[R]**
- **Output:** n(t) and v(t) handed to the D1 tracker. Off the line, a forward-backward speed pass over the chosen path for about 200 m, so the car can always still make the next corner (TUM graph planner). **[R]**

### D5. Behaviour layer

A small state machine per car, with minimum dwell times and separate enter/exit thresholds. The states are Free, Follow, Attack(side), Defend, SideBySide and Yield (blue flag). Base: ETH Zurich F1TENTH stack **[R]**; Game AI Pro utility scoring with hysteresis **[R]**.

- **Attack** is chosen only if the car can get alongside before the next corner, the same rule Studio 397 published in its 2023 rFactor 2 AI rewrite. **[R]**
- **Where to pass:** found by rolling both cars forward to the region where they would overlap. The pass is aimed there, not at the other car's current position (ETH Predictive Spliner, 84.5 % pass success). **[R]**
- **Commit gate:** the pass must finish within 6 s using at most 80 % of available acceleration (KAIST, Indy Autonomous Challenge). **[R]**
- **Each state sets the planner's cost weights.** For example, Defend adds a bonus for still being ahead at the end of the horizon (Liniger & Lygeros' blocking game). **[R]**

### D6. Character and difficulty

- **Skill:** a multiplier on the grip each driver believes it has, kept in a narrow band (about 98–100 %). This follows the Game AI Pro guidance, which notes a 1 % change compounds over laps. **[R]**
- **Traits** change decisions, not raw pace:
  - **aggression:** how much overlap it needs before it commits (rFactor 2's 2023 definition) and its following gap;
  - **optimism:** braking point bias;
  - **smoothness:** steering and throttle rates;
  - **composure:** mistake rate;
  - **courtesy:** how quickly it yields to blue flags.
  - Sources: rFactor 2 driver files, iRacing AI rosters. **[R]**
- **Lap-to-lap variety:** each lap and segment blends between the main line and an alternative line by a random amount. This is Microsoft's Drivatar patent US 7,358,973, with an "experience" value pulling toward the ideal line. **[R]**
- **No rubber-banding.** Forza Motorsport 2023, GRID and Pure all reject it explicitly. **[R]**

### D7. Tuning: the overnight jobs

1. **Lines:** step 6 of D3, run per track and class.
2. **Planner weights (about 12):** tuned with CMA-ES in headless races. The fitness is the GT Sophy reward plus a few racing targets: passes per lap, contacts, gaps when overlapped, lap-time spread.
   - Scenarios: 1 v 1, 1 v 3 and 1 v 7 against varied opponents. GT Sophy found that pure self-play produced an agent that rear-ended humans who braked early. **[R]** CMA-ES itself is my suggestion. **[I]**
3. **Human check last.** Every studio source ends with people racing the AI. Lap-time numbers alone don't make a good race (Game AI Pro). **[R]**

### D8. Validation tooling

- **Register OpenF1 data to our tracks:** a similarity transform fitted per lap, then the real line projected to n(s). Today `compare-real-lap.ts` compares speeds only.
- **Read `fast_lane.ai`** into the same n(s), v(s) form.
- **Report per corner:** lateral error, apex position, apex speed, brake point, lap time. Reported for the current line, the new line and the physics lap.
- **Headless race reports:** passes, contacts, at-fault incidents, time spent side by side, and the vetoes that fired.

## 5. Phases and acceptance tests

Each phase ends with a headless check before the next one starts.

| Phase | What | Done when |
|---|---|---|
| 0 | Measurement tooling (D8), baseline report on all 9 tracks plus Silverstone | Per-corner errors for the current lines, saved |
| 1 | Tracker (D1) and AI track arrays (D2) | Path within ±0.3 m and speed within 3 % on all 9 tracks, both autopilots; existing verify suites green |
| 2 | Speed model matched to the car, 3D, minimum curvature plus lap-time refinement (D3 steps 1–5) | Full-physics laps improve on every track; the D3 errors meet target at Monaco and Spielberg |
| 3 | Full-physics refinement plus alternative lines (D3 steps 6–7) | Overnight run completes; inside and outside lines drivable at their own speeds |
| 4 | Planner, prediction, vetoes (D4) plus behaviour (D5) | Scripted 1 v 1 overtake and defence tests pass; no veto breaks in 50 races |
| 5 | Character (D6) plus weight tuning (D7) | Targets met per track; your drive test |

Phases 1 and 2 also bring the biggest single-player improvement: the AI's own pace.

## 6. Compute budget

**Live, in the browser** (estimate from the planner report, not yet measured):

- About 150 candidates × 20 points is about 3,000 point checks per plan, roughly 0.5–1 ms in JS.
- 10 cars × 10 Hz is about 50–100 ms of CPU per second, 5–10 % of one core, alongside ten 500 Hz physics cars.
- No per-plan allocation.
- If the main thread can't absorb it, move the planner to a Web Worker that receives car states and returns plans.

**Offline:**

- The current optimiser takes about 30 s per track and class. Spielberg F1 went from a 75.08 s to a 74.42 s full-physics lap. **[M]**
- Full-physics refinement: hours per track. The headless sim runs at roughly 4–7× real time per 8-car race, so about 30–60 car-laps per minute per core.
- CMA-ES at 12 weights, about 50 races per generation, 40 generations: about 2,000 short races per track, overnight on several cores. **[I]**

## 7. Risks

- **The tracker change touches the physics-side autopilots** and invalidates the current tuning files. Mitigation: phase it in behind a flag, and keep the old path until Phase 2 passes.
- **Registering real telemetry is noisy:** OpenF1 positions are coarse (about 3.8 Hz) and drift along the lap by about ±10 m (FastF1 docs). **[R]** Mitigation: align by curvature cross-correlation and average several laps.
- **`fast_lane.ai` lines are hobbyist recordings** and only a loose target.
- **GT3 has no real data.**
- **Cost-based planners can still clip a car** when prediction is wrong. Mitigation: hard collision checks inside about 1.5 s **[I]**, the existing follow cap as a final guard, and contact handling as built.
- **Scope:** phases 0–5 are a multi-week effort, not a night.

## 8. Decisions for you

1. **Autopilot as tracker (D1):** both autopilots stop planning their own path and speed; the per-track tuning files are retired. Yes or no?
2. **Validation targets:** real F1 data at Monaco, Spielberg and Silverstone; `fast_lane.ai` for every sim-grade track; GT3 only against `fast_lane.ai` and physics laps. Acceptable?
3. **Web Worker** for the planner if the budget needs it. OK?
4. **Order:** Phases 0–2 first (lines and pace, no racecraft change), then 3–5. Or racecraft earlier?
