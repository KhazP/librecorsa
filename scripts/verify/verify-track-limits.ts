/**
 * Track limits rebalance verification:
 *   node --disable-warning=THREE_CJS_DEPRECATED --import tsx scripts/verify/verify-track-limits.ts
 *
 * Verifies:
 *  1. Corner-side classification (`cornerLimitSide`) on standalone corners, corner exits, straights, and
 *     tight alternating chicanes (inside apexes always take priority over outgoing corner exits).
 *  2. Physics `offTrack` detection (`F12026CarSim` rigid-body & `F1Physics2026` classic) on bundled RISE
 *     Motordrome (GLB colliders + sample ground):
 *     - Clean apex kerb-straddling (2 wheels on road, 2 on inside kerb) stays legal.
 *     - Inside corner cuts (all 4 wheels past white line onto kerb/runoff/grass) are caught & invalidate strict laps.
 *     - Marginal corner-exit run-wide (within `EXIT_OUTER_MARGIN_M`) does NOT instantly delete laps.
 *     - Genuine corner-exit off-track excursions (past `EXIT_OUTER_MARGIN_M`) ARE caught & invalidate laps.
 *     - Straight off-track excursions receive no exit margin and are caught immediately.
 *  3. Race-control `TrackLimitsMonitor` tightened inside-cut judging (shorter minimum duration, tighter gain
 *     threshold, and geometric shortcut enforcement across all scoring ladders) vs. wide exits.
 *  4. Circuit de la Sarthe 1982 (`le_mans_82`) Ford Chicanes (Virage Ford T14/T15 & Virage du Raccordement
 *     T16/T17), Mulsanne, and Arnage: behind-kerb aprons reclassified to runoff, inside cuts reliably caught,
 *     marginal exits tolerated, genuine exit excursions caught, and LC-LMDH autopilot stays clean through all
 *     four Ford Chicanes (skipped gracefully when hosted `le_mans_82` assets are absent).
 */
import fs from "node:fs";
import path from "node:path";
import {
  cornerLimitSide,
  EXIT_OUTER_MARGIN_M,
  isInsideCornerSurfaceValid,
} from "../../src/lib/sim/course-limits";
import { TrackLimitsMonitor, type TrackLimitsEvent, type TrackLimitsFrame } from "../../src/lib/sim/track-limits";
import { createGroundHit } from "../../src/lib/sim/f12026-car/TrackColliderQuery";
import { createLc26Sim } from "../../src/lib/sim/f12026-car/Lc26Sim";
import { createLcLmdhSim } from "../../src/lib/sim/proto/LcLmdhSim";
import { F1Physics2026 } from "../../src/lib/f1-physics-2026";
import { trackColliders } from "../../src/lib/sim/track-colliders";
import { getActiveTrackData, setActiveTrack } from "../../src/lib/track-data";
import { loadGlbGeometry } from "../lib/glb-geometry";
import { noteSkip } from "../lib/hosted-files";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL  ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? ` (${detail})` : ""}`);
}

const DT = 1 / 60;
let clock = 0;

function driveMonitor(m: TrackLimitsMonitor, seconds: number, f: Partial<TrackLimitsFrame>): TrackLimitsEvent[] {
  const events: TrackLimitsEvent[] = [];
  const n = Math.max(1, Math.round(seconds / DT));
  for (let i = 0; i < n; i++) {
    clock += DT;
    const ev = m.update({
      nowMs: clock * 1000,
      dtS: DT,
      lapCount: 1,
      distM: 1000,
      offTrack: false,
      throttle: 1,
      brake: 0,
      lateralM: 0,
      curvature: 0,
      deltaS: 0,
      active: true,
      ...f,
    });
    if (ev) events.push(ev);
  }
  return events;
}

async function main() {
  // 1. Corner-side classification on standalone corner, exit straight, and synthetic Ford-style chicane
  console.log("Corner-side classification");
  {
    const L = 1000;
    // Left apex [200..240] (k = -0.012), transition [240..250] (k = 0), right apex [250..290] (k = +0.014), exit straight [290..450]
    const chicaneK = (s: number) => {
      const w = ((s % L) + L) % L;
      if (w >= 200 && w <= 240) return -0.012;
      if (w >= 250 && w <= 290) return 0.014;
      return 0;
    };

    check("left apex inside (-lat) classified as inside", cornerLimitSide(chicaneK, 220, -4.0, L) === "inside");
    check("left apex outside (+lat) away from next apex classified as outside", cornerLimitSide(chicaneK, 220, 4.0, L) === "outside");
    check(
      "chicane inflection approaching right apex treats +lat as inside (takes priority over T1 exit)",
      cornerLimitSide(chicaneK, 244, 3.5, L) === "inside"
    );
    check("right apex inside (+lat) classified as inside", cornerLimitSide(chicaneK, 270, 4.0, L) === "inside");
    check("right apex outside (-lat) classified as outside", cornerLimitSide(chicaneK, 270, -4.0, L) === "outside");
    check("exit straight 20 m past right apex gives -lat outside margin", cornerLimitSide(chicaneK, 310, -4.5, L) === "outside");
    check("exit straight 20 m past right apex keeps +lat neutral", cornerLimitSide(chicaneK, 310, 4.5, L) === "neutral");
    check("long straight 100 m past corner is neutral on both sides", cornerLimitSide(chicaneK, 390, -5.0, L) === "neutral" && cornerLimitSide(chicaneK, 390, 5.0, L) === "neutral");
    check("inside surface validity allows road/pitlane only, not kerb", isInsideCornerSurfaceValid("road") && isInsideCornerSurfaceValid("pitlane") && !isInsideCornerSurfaceValid("kerb") && !isInsideCornerSurfaceValid("runoff"));
  }

  // 2. Bundled RISE Motordrome physics checks (GLB colliders + both physics engines)
  console.log("Physics track limits · RISE Motordrome (bundled)");
  {
    const rawRwanda = JSON.parse(fs.readFileSync("public/tracks/rwanda_official/track_data.json", "utf8"));
    setActiveTrack("rwanda_official", rawRwanda);
    const track = getActiveTrackData(1200);
    const root = await loadGlbGeometry("public/tracks/rwanda_official/rwanda_official.glb");
    const { ground } = trackColliders(root);
    if (!ground) throw new Error("Missing rwanda_official collider ground");
    const hit = createGroundHit();

    // Find a clear corner sample on RISE Motordrome with an inside kerb and an outside runoff
    // s=1720 is a tight left-hander (k ≈ -0.035, hw ≈ 6.0, inside kerb on left -6.0..-7.5, outside runoff on right > 5.5)
    const spCorner = track.getSampleAtDistance(1720);
    const cornerSideIn = Math.sign(spCorner.curvature); // -1 (left)
    const cornerSideOut = -cornerSideIn; // +1 (right)
    const bl = Math.hypot(spCorner.binormal.x, spCorner.binormal.z) || 1;
    const bx = spCorner.binormal.x / bl;
    const bz = spCorner.binormal.z / bl;

    // Measure exact collider road & validTrack extents at s=1720
    let insideRoadEdge = 0;
    let insideKerbOuter = 0;
    let outsideValidEdge = 0;
    for (let d = 0; d <= 10; d += 0.1) {
      if (ground.query(spCorner.position.x + bx * cornerSideIn * d, spCorner.position.z + bz * cornerSideIn * d, spCorner.position.y + 3, hit)) {
        if (hit.surface === "road") insideRoadEdge = d;
        if (hit.props.validTrack) insideKerbOuter = d;
      }
      if (ground.query(spCorner.position.x + bx * cornerSideOut * d, spCorner.position.z + bz * cornerSideOut * d, spCorner.position.y + 3, hit)) {
        if (hit.props.validTrack) outsideValidEdge = d;
      }
    }

    const car = createLc26Sim(track);
    car.attachTrackRoot(root);
    const halfTrack = 0.5 * Math.max(car.profile.config.chassis.trackWidthFront, car.profile.config.chassis.trackWidthRear);

    const probeRigid = (s: number, lat: number) => {
      car.trackLimitsMode = "strict";
      car.aiAutopilot = false;
      car.teleportToDistance(s, 0, lat);
      (car as unknown as { lapValid: boolean }).lapValid = true;
      car.telemetry.lapInvalid = false;
      car.step(DT, { brake: 1 });
      return { off: car.telemetry.offTrack, invalid: car.telemetry.lapInvalid, wheels: [...car.telemetry.wheelSurfaces] };
    };

    // Legal apex clip: inside wheels on kerb, outside wheels on road
    const legalApex = probeRigid(1720, cornerSideIn * (insideRoadEdge - 0.1));
    check(
      "rigid-body: straddling inside apex kerb (2 wheels on road, 2 on kerb) stays legal",
      !legalApex.off && !legalApex.invalid,
      `wheels=${legalApex.wheels.join(",")}`
    );

    // Inside corner cut: outside wheels cross past road edge onto inside kerb while inside wheels are in grass/runoff
    const insideCutLat = cornerSideIn * (insideRoadEdge + halfTrack + 0.25);
    const insideCut = probeRigid(1720, insideCutLat);
    check(
      "rigid-body: cutting inside apex (all 4 wheels over white line onto kerb/grass) is caught & invalidates strict lap",
      insideCut.off && insideCut.invalid === true && Math.abs(insideCutLat) - halfTrack < insideKerbOuter,
      `lat=${insideCutLat.toFixed(2)}, wheels=${insideCut.wheels.join(",")}`
    );

    // Corner exit slightly wide: inside-side wheels ~0.30 m past outer edge (within EXIT_OUTER_MARGIN_M = 0.55 m)
    const slightWideLat = cornerSideOut * (outsideValidEdge + halfTrack + 0.30);
    const slightWide = probeRigid(1720, slightWideLat);
    check(
      "rigid-body: running marginally wide on corner exit (+0.30 m past outer edge) does NOT delete lap",
      !slightWide.off && !slightWide.invalid,
      `lat=${slightWideLat.toFixed(2)}, wheels=${slightWide.wheels.join(",")}`
    );

    // Corner exit genuinely off-track: inside-side wheels ~0.95 m past outer edge (> EXIT_OUTER_MARGIN_M)
    const genuineWideLat = cornerSideOut * (outsideValidEdge + halfTrack + EXIT_OUTER_MARGIN_M + 0.40);
    const genuineWide = probeRigid(1720, genuineWideLat);
    check(
      "rigid-body: genuine wide off-track excursion on corner exit (+0.95 m past outer edge) IS caught & invalidates lap",
      genuineWide.off && genuineWide.invalid === true,
      `lat=${genuineWideLat.toFixed(2)}, wheels=${genuineWide.wheels.join(",")}`
    );

    // Straight section (s=2200 is middle of the 1 km back straight): NO exit margin
    const spStr = track.getSampleAtDistance(2200);
    const blStr = Math.hypot(spStr.binormal.x, spStr.binormal.z) || 1;
    let strValidEdge = 0;
    for (let d = 0; d <= 12; d += 0.1) {
      if (ground.query(spStr.position.x + (spStr.binormal.x / blStr) * d, spStr.position.z + (spStr.binormal.z / blStr) * d, spStr.position.y + 3, hit) && hit.props.validTrack) {
        strValidEdge = d;
      }
    }
    const straightOff = probeRigid(2200, strValidEdge + halfTrack + 0.30);
    check(
      "rigid-body: neutral straight gets no exit margin (+0.30 m past edge is off-track)",
      straightOff.off && straightOff.invalid === true,
      `wheels=${straightOff.wheels.join(",")}`
    );

    // Classic F1Physics2026 engine parity check
    const classic = new F1Physics2026(track);
    const probeClassic = (s: number, lat: number) => {
      classic.trackLimitsMode = "strict";
      classic.aiAutopilot = false;
      classic.teleportToDistance(s, 0, lat);
      (classic as unknown as { lapValid: boolean }).lapValid = true;
      classic.telemetry.lapInvalid = false;
      classic.step(DT, { brake: 1 });
      return { off: classic.telemetry.offTrack, invalid: classic.telemetry.lapInvalid, wheels: [...classic.telemetry.wheelSurfaces] };
    };
    const hwClassic = spCorner.width / 2;
    const classicHalfTrack = 0.8;
    const cLegal = probeClassic(1720, cornerSideIn * (hwClassic - 0.5));
    const cCut = probeClassic(1720, cornerSideIn * (hwClassic + classicHalfTrack + 0.15));
    const cExitSlight = probeClassic(1720, cornerSideOut * (hwClassic + classicHalfTrack + 0.30));
    const cExitWide = probeClassic(1720, cornerSideOut * (hwClassic + classicHalfTrack + EXIT_OUTER_MARGIN_M + 0.45));
    check("classic engine: legal inside apex clip stays on-track", !cLegal.off && !cLegal.invalid, cLegal.wheels.join(","));
    check("classic engine: inside apex cut past white line is caught", cCut.off && cCut.invalid === true, cCut.wheels.join(","));
    check("classic engine: slight corner exit run-wide (+0.30 m) does NOT delete lap", !cExitSlight.off && !cExitSlight.invalid, cExitSlight.wheels.join(","));
    check("classic engine: genuine wide exit excursion (+1.00 m) IS caught", cExitWide.off && cExitWide.invalid === true, cExitWide.wheels.join(","));
  }

  // 3. Race-control TrackLimitsMonitor tightened inside cuts vs wide exits
  console.log("Race control · TrackLimitsMonitor inside cuts vs exit run-wide");
  {
    // Brief 0.07 s inside chicane cut is NOT ignored (< 0.12 s general touch threshold, >= 0.05 s inside threshold)
    const m = new TrackLimitsMonitor();
    m.reset("race", { scoring: "weighted_pts", pointsAllowed: 5 });
    const crispInside = [
      ...driveMonitor(m, 0.2, { deltaS: 0, cornerSide: "inside" }),
      ...driveMonitor(m, 0.07, { offTrack: true, deltaS: 0, lateralM: 5, curvature: 0, cornerSide: "inside" }),
      ...driveMonitor(m, 1.5, { deltaS: -0.05, cornerSide: "neutral" }),
      ...driveMonitor(m, 6.5, { deltaS: -0.05, cornerSide: "neutral" }),
    ];
    check(
      "crisp 0.07 s inside chicane cut (even at local curvature=0 via cornerSide) is judged & penalized",
      crispInside.length === 1 && crispInside[0].kind === "warning" && crispInside[0].reason === "corner_cut",
      JSON.stringify(crispInside)
    );

    // Same 0.07 s brush on outside exit IS ignored as a harmless touch
    const mOut = new TrackLimitsMonitor();
    mOut.reset("race", { scoring: "weighted_pts", pointsAllowed: 5 });
    const briefOutside = [
      ...driveMonitor(mOut, 0.2, { deltaS: 0, cornerSide: "outside" }),
      ...driveMonitor(mOut, 0.07, { offTrack: true, deltaS: 0, lateralM: -6, curvature: 1 / 80, cornerSide: "outside" }),
      ...driveMonitor(mOut, 2.0, { deltaS: -0.05, cornerSide: "neutral" }),
    ];
    check("brief 0.07 s outside exit touch is ignored", briefOutside.length === 0 && !mOut.judging, JSON.stringify(briefOutside));

    // Inside cut gaining 0.02 s (> 0.01 s) triggers give-back / warning
    const mSmallGain = new TrackLimitsMonitor();
    mSmallGain.reset("race");
    const smallGain = [
      ...driveMonitor(mSmallGain, 0.2, { deltaS: 0 }),
      ...driveMonitor(mSmallGain, 0.25, { offTrack: true, deltaS: 0, lateralM: 5, curvature: 1 / 40, cornerSide: "inside" }),
      ...driveMonitor(mSmallGain, 1.5, { deltaS: -0.02 }),
      ...driveMonitor(mSmallGain, 6.5, { deltaS: -0.02 }),
    ];
    check(
      "inside cut gaining 0.02 s triggers corner_cut warning when not given back",
      smallGain.length === 1 && smallGain[0].kind === "warning" && smallGain[0].reason === "corner_cut",
      JSON.stringify(smallGain)
    );

    // Inside geometric shortcut >= 1.0 m with 0 s gain (e.g. worn tyres) is caught on four_strike AND legacy AND weighted_pts
    for (const [label, rules] of [
      ["legacy", { scoring: "legacy" as const, pointsAllowed: 3 }],
      ["four_strike", { scoring: "four_strike" as const, pointsAllowed: 4 }],
      ["weighted_pts", { scoring: "weighted_pts" as const, pointsAllowed: 5 }],
    ] as const) {
      const mc = new TrackLimitsMonitor();
      mc.reset("race", rules);
      const R = 35;
      const evs: TrackLimitsEvent[] = [];
      evs.push(...driveMonitor(mc, 0.2, { distM: 1000, posX: R - 5, posZ: 0, curvature: 1 / R, lateralM: 5, halfWidthM: 5, deltaS: 0, cornerSide: "inside" }));
      const steps = 18;
      // Straight chord cutting across 45° inside apex: arc at R-5 is 30*(pi/4)=23.56 m, chord is 2*30*sin(pi/8)=22.96 m -> wait use 70° for > 2 m shortcut
      const span = (70 * Math.PI) / 180;
      const rIn = R - 5;
      const x0 = rIn, z0 = 0;
      const x1 = rIn * Math.cos(span), z1 = rIn * Math.sin(span);
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        evs.push(
          ...driveMonitor(mc, DT, {
            offTrack: true,
            distM: 1000 + R * span * u,
            posX: x0 + (x1 - x0) * u,
            posZ: z0 + (z1 - z0) * u,
            curvature: 1 / R,
            lateralM: 6,
            halfWidthM: 5,
            deltaS: 0,
            cornerSide: "inside",
          })
        );
      }
      evs.push(...driveMonitor(mc, 2.0, { distM: 1000 + R * span, posX: x1, posZ: z1, curvature: 0, lateralM: 0, halfWidthM: 5, deltaS: 0, cornerSide: "neutral" }));
      check(
        `${label}: inside apex shortcut (>= 1 m cut, 0 s gain) draws corner_cut strike`,
        evs.some((e) => e.kind === "warning" && e.reason === "corner_cut"),
        JSON.stringify(evs)
      );
    }
  }

  // 4. Circuit de la Sarthe 1982 (Ford Chicanes T14-T17, Mulsanne, Arnage) — hosted assets
  const tracksRoot = process.env.TRACKS_DIR || "public/tracks";
  const sartheData = path.join(tracksRoot, "le_mans_82/track_data.json");
  const sartheGlb = path.join(tracksRoot, "le_mans_82/le_mans_82.glb");
  if (fs.existsSync(sartheData) && fs.existsSync(sartheGlb)) {
    console.log("Circuit de la Sarthe 1982 · Ford Chicanes, Mulsanne & Arnage");
    const raw = JSON.parse(fs.readFileSync(sartheData, "utf8"));
    setActiveTrack("le_mans_82", raw);
    const track = getActiveTrackData(1200);
    const root = await loadGlbGeometry(sartheGlb);
    const { ground } = trackColliders(root);
    if (!ground) throw new Error("Missing le_mans_82 collider ground");
    const hit = createGroundHit();

    // Verify ZERO road remains behind inside apex kerbs at Mulsanne, Arnage, Virage Ford (T14/T15), and Raccordement (T16/T17)
    const apexProbes = [7750, 7760, 10240, 13353, 13356, 13374, 13377, 13380, 13485, 13491, 13518, 13521, 13524, 13527, 13530, 13533];
    const leaked: string[] = [];
    for (const s of apexProbes) {
      const sp = track.getSampleAtDistance(s);
      const side = Math.sign(sp.curvature) || 1;
      const bl = Math.hypot(sp.binormal.x, sp.binormal.z) || 1;
      const bx = sp.binormal.x / bl;
      const bz = sp.binormal.z / bl;
      let sawKerb = false;
      for (let d = 0; d <= 10; d += 0.25) {
        if (!ground.query(sp.position.x + bx * side * d, sp.position.z + bz * side * d, sp.position.y + 3, hit)) continue;
        if (hit.surface === "kerb") sawKerb = true;
        else if (sawKerb && hit.surface === "road") {
          leaked.push(`s=${s}@d=${d.toFixed(2)}`);
          break;
        }
      }
    }
    check("no valid road remains behind inside apex kerbs at Ford Chicanes, Mulsanne, or Arnage", leaked.length === 0, leaked.join(", "));

    // LC-LMDH through Ford Chicanes
    const car = createLcLmdhSim(track);
    car.attachTrackRoot(root);
    const probeSarthe = (s: number, lat: number) => {
      car.trackLimitsMode = "strict";
      car.aiAutopilot = false;
      car.teleportToDistance(s, 0, lat);
      // Clear lapValid after teleporting onto target test spot so we test strictly this spot
      (car as unknown as { lapValid: boolean }).lapValid = true;
      car.telemetry.lapInvalid = false;
      car.step(DT, { brake: 1 });
      return { off: car.telemetry.offTrack, invalid: car.telemetry.lapInvalid, wheels: [...car.telemetry.wheelSurfaces] };
    };

    // Virage du Raccordement T17 (s=13524, right turn: inside kerb +2.75..+3.50, outside road ends -5.00)
    const t17Legal = probeSarthe(13524, 2.0);
    const t17Cut = probeSarthe(13524, 3.8);
    const t17ExitSlight = probeSarthe(13524, -6.1);
    const t17ExitWide = probeSarthe(13524, -6.6);
    check("Sarthe T17 Raccordement: clean apex clip (lat=+2.0 m) stays legal", !t17Legal.off && !t17Legal.invalid, t17Legal.wheels.join(","));
    check("Sarthe T17 Raccordement: inside chicane cut (lat=+3.8 m over kerb into apron) IS caught", t17Cut.off && t17Cut.invalid === true, t17Cut.wheels.join(","));
    check("Sarthe T17 Raccordement: marginally wide exit (lat=-6.1 m) does NOT delete lap", !t17ExitSlight.off && !t17ExitSlight.invalid, t17ExitSlight.wheels.join(","));
    check("Sarthe T17 Raccordement: genuine wide exit excursion (lat=-6.6 m) IS caught", t17ExitWide.off && t17ExitWide.invalid === true, t17ExitWide.wheels.join(","));

    // Virage Ford T15 (s=13385, right turn: inside kerb +4.00..+5.00, outside road ends -4.25 with no exit kerb)
    const t15Legal = probeSarthe(13385, 3.0);
    const t15Cut = probeSarthe(13385, 5.4);
    const t15ExitSlight = probeSarthe(13385, -5.3);
    const t15ExitWide = probeSarthe(13385, -5.85);
    check("Sarthe T15 Virage Ford: clean apex clip (lat=+3.0 m) stays legal", !t15Legal.off && !t15Legal.invalid, t15Legal.wheels.join(","));
    check("Sarthe T15 Virage Ford: inside chicane cut (lat=+5.4 m past white line) IS caught", t15Cut.off && t15Cut.invalid === true, t15Cut.wheels.join(","));
    check("Sarthe T15 Virage Ford: marginally wide exit (lat=-5.3 m) does NOT delete lap", !t15ExitSlight.off && !t15ExitSlight.invalid, t15ExitSlight.wheels.join(","));
    check("Sarthe T15 Virage Ford: genuine wide exit excursion (lat=-5.85 m) IS caught", t15ExitWide.off && t15ExitWide.invalid === true, t15ExitWide.wheels.join(","));

    // Virage Ford T14 (s=13354, left turn: inside kerb -3.50..-4.25)
    const t14Cut = probeSarthe(13354, -4.5);
    check("Sarthe T14 Virage Ford: inside chicane cut (lat=-4.5 m) IS caught", t14Cut.off && t14Cut.invalid === true, t14Cut.wheels.join(","));

    // Virage du Raccordement T16 (s=13486, left turn: inside kerb -3.75..-4.25)
    const t16Cut = probeSarthe(13486, -4.8);
    check("Sarthe T16 Raccordement: inside chicane cut (lat=-4.8 m) IS caught", t16Cut.off && t16Cut.invalid === true, t16Cut.wheels.join(","));

    // LC-LMDH autopilot drives cleanly through all four Ford Chicanes with 0 off-track frames
    car.aiAutopilot = true;
    car.teleportToDistance(13220, 45);
    let apOff = 0;
    let apFrames = 0;
    for (let i = 0; i < 60 * 14; i++) {
      car.step(DT, {});
      if (car.sMeters < 13200) break;
      apFrames++;
      if (car.telemetry.offTrack) apOff++;
    }
    check("Sarthe Ford Chicanes: LC-LMDH autopilot completes T14-T17 with 0 off-track frames", apFrames > 400 && apOff === 0, `${apOff}/${apFrames} off-track`);
  } else {
    noteSkip("Sarthe 1982 Ford Chicanes checks", sartheData);
  }

  console.log(`\nAll ${passed} track-limits checks passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
