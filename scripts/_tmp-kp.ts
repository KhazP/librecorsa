import { buildDoubleWishboneHardpoints, solveCornerKinematics3D } from '../src/lib/sim/suspension-kinematics';
import { F12026_CAR_CONFIG } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { LC26_CAR_CONFIG } from '../src/lib/sim/f12026-car/Lc26Config';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { LC_LMDH_CONFIG } from '../src/lib/sim/proto/LcLmdhConfig';
import { MTR_496R_CONFIG } from '../src/lib/sim/proto/Mtr496rConfig';
import { SUZUKI_LIANA_CONFIG } from '../src/lib/sim/road/SuzukiLianaConfig';
import { NISSAN_R33_CONFIG } from '../src/lib/sim/classic/NissanR33Config';
import { NISSAN_R32_CONFIG } from '../src/lib/sim/classic/NissanR32Config';
const R = 180 / Math.PI;
const cars: any = { f1: F12026_CAR_CONFIG, lc26: LC26_CAR_CONFIG, gt3: AMG_GT3_CONFIG, lmdh: LC_LMDH_CONFIG, mtr: MTR_496R_CONFIG, liana: SUZUKI_LIANA_CONFIG, r33: NISSAN_R33_CONFIG, r32: NISSAN_R32_CONFIG };
const hpArg = process.argv[2] ? JSON.parse(process.argv[2]) : null;
for (const [id, cfg] of Object.entries(cars) as any) {
  const susp = cfg.suspensions.front;
  const rF = cfg.tyreCompounds[cfg.compoundSlots.soft].front.radius;
  const opts = { geometry: susp.actuation === 'pull_rod' ? 'f1' : 'gt3', staticCasterTrailM: cfg.chassis.ffbMechanicalTrailM ?? 0.012 } as any;
  const hp = hpArg?.[id] ? susp.hardpoints.map((p: any, i: number) => hpArg[id][i] ?? p) : susp.hardpoints;
  const b = buildDoubleWishboneHardpoints(hp, true, susp.actuation, opts);
  const k = solveCornerKinematics3D(b, 0, 0, true, rF);
  const kb = solveCornerKinematics3D(b, 0.01, 0, true, rF);
  const kl = solveCornerKinematics3D(b, 0, 0.3, true, rF);
  const kr = solveCornerKinematics3D(b, 0, 0.3, false, rF);
  console.log(id.padEnd(6), `rF ${rF.toFixed(3)} kpi ${(k.kpiRad * R).toFixed(2)} caster ${(k.casterRad * R).toFixed(2)} scrub ${(k.kingpinScrubM * 1000).toFixed(1)} trail ${(k.kingpinTrailM * 1000).toFixed(1)} camberGain ${(((kb.uprightCamberRad - k.uprightCamberRad) / 0.01) * R).toFixed(1)} lev0 ${k.tieRodLeverageNorm.toFixed(3)} levL ${kl.tieRodLeverageNorm.toFixed(3)} levR ${kr.tieRodLeverageNorm.toFixed(3)} hp ${!!susp.hardpoints}`);
}
