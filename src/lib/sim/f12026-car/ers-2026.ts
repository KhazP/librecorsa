/**
 * The 2026 Formula 1 rules on the car's electrical energy, and the energy management a team's control unit runs
 * inside them, for a car whose `ERSData.regulations` is 'f1-2026'.
 *
 * The rules, from the FIA 2026 F1 Regulations (Section C, Technical, Issue 21 of 19 Oct 2026; Section B, Sporting,
 * Issue 09 of 1 Oct 2026):
 * - C5.2.7 / C5.2.8: the ERS-K's DC power is at most 350 kW. Used to propel the car it is at most 1800 − 5v kW (v in
 *   km/h) below 340 km/h, 6900 − 20v from 340 to 345 and nothing from 345: 350 kW up to 290 km/h, 100 kW at 340. With
 *   Overtake active, 7100 − 20v and nothing from 355: 350 kW up to 337.5 km/h.
 * - C5.2.9: at most 4 MJ between the store's highest and lowest charge.
 * - C5.2.10: at most 8.5 MJ recharged a lap, measured at the CU-K's DC bus; 0.5 MJ more on a race lap begun with
 *   Overtake activated (B7.2.1 b v). Nothing limits the energy deployed in a lap (the energy-flow diagram of C5.2.2).
 * - C5.2.11: at most 500 Nm of MGU-K torque, referred to the crankshaft.
 * - C5.2.12: from a standing start the MGU-K deploys only once the car has reached 50 km/h.
 * - C5.2.21: electrical and mechanical power convert at a fixed 0.97.
 * - C5.12.4 to C5.12.7: when the control unit takes power away with the driver flat out (a power-limited period), the
 *   driver's maximum demand drops by at most 150 kW at once, then the ERS-K's power by at most 100 kW a second while it
 *   is over 100 kW; not below 210 km/h, in a gearshift, with the driver off the throttle, or where the speed limit
 *   above takes it. None of it is given back in the same period except by the driver's Boost.
 * - B7.2.3: in practice and qualifying (lap-time sessions) Overtake is active all the time; in a race it is earned at
 *   the detection line within the detection gap (`overtaking-rules.ts`).
 *
 * Left out: the race's 250 kW curve on the sectors the FIA names for each circuit during a power-limited period
 * (C5.2.8 iii, from the Miami 2026 changes), whose sectors are not published, and the per-event lower recharge limits.
 *
 * The management is each team's own and not public. This one weighs each joule by the lap time it buys where the car
 * is: the speed it adds lasts to the next braking zone, so a joule at speed v with d metres to go is worth about
 * d / (m v³) seconds (`ersValueSPerMJ`): most out of a slow corner onto a long straight, least at the top of a
 * straight just before the brakes. It deploys where that value is over a bar the charge left sets, and cuts the
 * deployment where it falls under it, at the rules' rates; where the value is lowest it harvests flat out
 * (superclipping, up to 350 kW since the Miami 2026 changes), within what the lap's recharge limit leaves after the
 * braking zones still to come. That is the shape of the 2026 cars' speed traces: full power off the corners, the
 * speed flattening and then falling at full throttle at the end of the long straights.
 */
import type { LutPoints } from '../lut';

/** The rules' numbers (Section C) */
export const F1_2026_ERS = {
  /** C5.2.7: the ERS-K's DC power, either way (W) */
  maxDcW: 350_000,
  /** C5.2.11: MGU-K torque at the crank (Nm) */
  maxTorqueNm: 500,
  /** C5.2.9: the store's charge window (J) */
  storeJ: 4_000_000,
  /** C5.2.10: recharge a lap (J), and Overtake's extra on a race lap (C5.2.10 iii, B7.2.1 b v) */
  rechargePerLapJ: 8_500_000,
  overtakeRechargeJ: 500_000,
  /** C5.2.21: mechanical power per watt of DC power */
  mechPerDc: 0.97,
  /** C5.2.12: deployment from a standing start (km/h) */
  standingStartKmh: 50,
  /** C5.12.4: the drop in the driver's maximum demand as a power-limited period starts (W) */
  limitStepW: 150_000,
  /** C5.12.6 b: the ERS-K power's rate of drop after it (W/s); 50 kW/s where the FIA finds over 3.5 km power-limited */
  limitRateWps: 100_000,
  /** C5.12.7: the rate holds only while the ERS-K's power is over this (W) and the car over this speed (km/h) */
  limitFreeBelowW: 100_000,
  limitFreeBelowKmh: 210,
} as const;

/** Harvest at full throttle (superclipping): 350 kW since the Miami 2026 changes, 250 before (DC, W) */
export const SUPERCLIP_DC_W = 350_000;

/** The pedal travel the control unit reads as flat out (0..1) */
const FLAT_OUT = 0.95;

/**
 * The energy a cut from `fromW` of deployment takes at the rules' rates (J): 150 kW at once, then 100 kW a second down
 * to 100 kW, under which it may go at once; with 20 kJ to spare
 */
export function cutEnergyJ(fromW: number): number {
  const R = F1_2026_ERS;
  const after = fromW - R.limitStepW;
  if (after <= R.limitFreeBelowW) return 20_000;
  return 20_000 + (0.5 * (after + R.limitFreeBelowW) * (after - R.limitFreeBelowW)) / R.limitRateWps;
}

/** C5.2.8: the ERS-K's DC power that may propel the car at a road speed (W), with Overtake active or not */
export function ersKDeployLimitW(speedKmh: number, overtake: boolean): number {
  const v = Math.max(0, speedKmh);
  let kw: number;
  if (overtake) kw = v >= 355 ? 0 : 7100 - 20 * v;
  else if (v >= 345) kw = 0;
  else if (v >= 340) kw = 6900 - 20 * v;
  else kw = 1800 - 5 * v;
  return Math.max(0, Math.min(F1_2026_ERS.maxDcW, kw * 1000));
}

/**
 * What a joule deployed (or harvested) is worth in lap time where the car is (s per MJ): the speed it adds, ΔE / (m v),
 * held to the next braking zone `toBrakeM` away, d / v seconds on: about d / (m v³). Infinity with no braking zone known
 */
export function ersValueSPerMJ(speedMs: number, toBrakeM: number, massKg: number): number {
  if (!Number.isFinite(toBrakeM)) return Number.POSITIVE_INFINITY;
  const v = Math.max(5, speedMs);
  return (1e6 * Math.max(0, toBrakeM)) / (massKg * v * v * v);
}

/**
 * A performance mode's energy management (`PerformanceModeData.energyManagement`), each against the store's charge
 * (0..1), in the lap time a joule buys where the car is (`ersValueSPerMJ`, s per MJ). The control unit knows the
 * circuit, as a team's does from its lap-distance maps: how far the next braking zone is
 */
export interface EnergyManagementData {
  /** It deploys where a joule is worth more than this (s per MJ); where less, the deployment is cut */
  deployAboveSPerMJ: LutPoints;
  /** It harvests flat out (superclipping), once the cut is done, where a joule is worth less than this (s per MJ) */
  superclipBelowSPerMJ: LutPoints;
}

/** What the control unit sees in a step */
export interface ErsStepInput {
  /** Step (s) */
  h: number;
  speedKmh: number;
  /** Pedal 0..1, above the lift harvest's threshold */
  throttle: number;
  /** A gearshift under way */
  shifting: boolean;
  /** The store's charge (0..1) */
  soc: number;
  /** Overtake's power curve (C5.2.8 ii) */
  overtake: boolean;
  /** The driver's Boost: deploys to the limit whatever the charge, and may give back a cut */
  boost: boolean;
  /** The mode's and gear's share of the limit: the team's traction maps (0..1) */
  share: number;
  /**
   * The share the motor may fill the turbo's lag with (0..1): the gear's, without the low-speed delivery map, as the
   * fill only makes up torque the engine was asked for
   */
  fillShare: number;
  /** What a joule is worth here (`ersValueSPerMJ`, s per MJ) */
  valueSPerMJ: number;
  /**
   * The mode's management (`EnergyManagementData`) at this charge: the value it deploys above (s per MJ; NaN for a
   * mode without, which deploys to the limit as the Boost does) and the value it superclips below
   */
  deployAboveSPerMJ: number;
  superclipBelowSPerMJ: number;
  /** What the recharge limit leaves this lap for superclipping (J) */
  superclipRoomJ: number;
}

/**
 * The ERS-K's control for one car: what DC power it asks of the store each step (+ deploy, − harvest), under the
 * rules' limits and rates and the mode's management.
 */
export class Ers2026Control {
  /** The control unit's own deployment ceiling (DC W): what its cuts have left of the motor */
  private levelW = 0;
  /** In a power-limited period: flat out above 210 km/h with power taken away (C5.12.4 to 7) */
  private limited = false;
  /** Harvesting flat out in this power-limited period */
  private superclipping = false;
  /** Holding the deployment back after a standing start (C5.2.12) */
  private standingStart = false;
  /** The DC power the store gave the motor last step (W, + deploy): a cut runs from it */
  public lastDcW = 0;
  /** The deployment ceiling this step, the rules' and the control unit's (DC W) */
  public deployCeilingW = 0;
  /** What the motor may fill the turbo's lag with this step (DC W): the rules' limit where the management deploys */
  public fillCeilingW = 0;

  /** A standing start from the grid: no deployment until 50 km/h */
  armStandingStart(): void {
    this.standingStart = true;
  }

  reset(): void {
    this.levelW = 0;
    this.limited = this.superclipping = this.standingStart = false;
    this.lastDcW = this.deployCeilingW = this.fillCeilingW = 0;
  }

  /** A step the control did not run: the driver lifting or braking, or the drive out. Any power-limited period ends */
  release(): void {
    this.limited = this.superclipping = false;
    this.deployCeilingW = this.fillCeilingW = 0;
  }

  /** A power-limited period under way: the deployment cut or the car harvesting flat out */
  get clipping(): boolean {
    return this.limited;
  }

  /** The DC power asked for this step (W, + deploy, − harvest) */
  step(i: ErsStepInput): number {
    const R = F1_2026_ERS;
    if (this.standingStart && i.speedKmh >= R.standingStartKmh) this.standingStart = false;
    const share = Math.max(0, i.share);
    // What the management wants of the motor: all of it up to its speed for the charge left, none above
    let wantW = R.maxDcW * share;
    const managed = !i.boost && !Number.isNaN(i.deployAboveSPerMJ);
    const managedCut = managed && !(i.valueSPerMJ > i.deployAboveSPerMJ);
    // The store is never run empty under power: a cut from the most the motor may deploy here, at the rules' rates,
    // needs this much (an empty store would drop the motor at once, faster than they allow)
    const capW = ersKDeployLimitW(i.speedKmh, i.overtake);
    const mostW = Math.max(this.lastDcW, capW * Math.max(share, i.fillShare));
    const allowed = !managedCut && i.soc * R.storeJ > cutEnergyJ(mostW) && !this.standingStart;
    if (!allowed) wantW = 0;

    const flatOut = i.throttle >= FLAT_OUT;
    const free = !flatOut || i.shifting || i.speedKmh < R.limitFreeBelowKmh;
    if (free || i.boost) {
      // Off the throttle, in a shift or slow, no power-limited period: the ceiling follows the management at once. The
      // Boost ends one, and gives back what it cut (C5.12.5)
      this.limited = this.superclipping = false;
      this.levelW = wantW;
    } else if (wantW < this.levelW - 1) {
      // A cut with the driver flat out: from the power being deployed 150 kW at once, then 100 kW a second while over
      // 100 kW, under which the rest may go at once
      const from = this.limited ? this.levelW : Math.min(this.levelW, Math.max(0, this.lastDcW));
      this.levelW = Math.max(wantW, this.limited ? from - R.limitRateWps * i.h : from - R.limitStepW);
      if (this.levelW < R.limitFreeBelowW) this.levelW = wantW;
      this.limited = true;
    } else if (!this.limited) {
      this.levelW = wantW;
    }
    // (inside a power-limited period nothing cut is given back: the ceiling holds)

    this.deployCeilingW = Math.min(this.levelW, capW * share);
    this.fillCeilingW = allowed && !this.limited ? capW * Math.max(0, i.fillShare) : this.deployCeilingW;
    const deployW = this.deployCeilingW * Math.min(1, i.throttle);
    if (deployW > 0) return deployW;

    // The cut done and a joule worth little here: the engine's power goes on into the store, to the end of the period
    // (it gives none back), or until the lap's recharge limit or a full store stops it
    if (!free && managed && this.levelW <= 0) {
      if (!this.superclipping && i.valueSPerMJ < i.superclipBelowSPerMJ) this.superclipping = this.limited = true;
      if (this.superclipping && i.superclipRoomJ > 0 && i.soc < 1) {
        return -Math.min(SUPERCLIP_DC_W, i.superclipRoomJ / Math.max(i.h, 1e-6));
      }
    }
    return 0;
  }
}
