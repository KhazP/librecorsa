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
 * - C5.12.4 to C5.12.7: when the control unit takes power away with the driver flat out above 210 km/h, entering Power
 *   Limited Pending (PLP) on fresh full throttle caps the initial drop at 150 kW held fixed for 1 s (larger in FIA
 *   Power Reduction sectors), after which Power Limited (PL) ramps ERS-K power down at no faster than 100 kW/s
 *   (50 kW/s on circuits over 3.5 km power-limited) while above 100 kW, then drops freely below 100 kW; not below
 *   210 km/h, in a gearshift, with the driver off the throttle, or where the speed limit above takes it. None of it is
 *   given back in the same period except by the driver's Boost.
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
import type { ErsCurveSet } from '../f1-energy-circuits';

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
  /** C5.12.4: how long the initial drop stays fixed before ramping down (s) */
  limitHoldS: 1,
  /** C5.12.6 b: the ERS-K power's rate of drop after it (W/s); 50 kW/s where the FIA finds over 3.5 km power-limited */
  limitRateWps: 100_000,
  /** C5.12.7: the rate holds only while the ERS-K's power is over this (W) and the car over this speed (km/h) */
  limitFreeBelowW: 100_000,
  limitFreeBelowKmh: 210,
} as const;

/** Harvest at full throttle (superclipping): 350 kW since the Miami 2026 changes, 250 before (DC, W) */
export const SUPERCLIP_DC_W = 350_000;

/**
 * Slew rate into full-throttle superclipping (DC W/s): ramps 0 → 350 kW over ~0.65 s so superclipping builds
 * progressively instead of slamming the drivetrain with an instant single-step torque reversal
 */
export const SUPERCLIP_RAMP_WPS = 540_000;

/**
 * Slew rate when Boost recovers power after a cut or superclipping (DC W/s): 0 → 350 kW in 0.175 s (0 → 150 kW in
 * 0.075 s) so pressing Boost feels immediate without snapping the halfshafts on a 700 kW reversal
 */
export const BOOST_RAMP_WPS = 2_000_000;

/**
 * Minimum throttle above which normal positive MGU-K deployment blends in (0..1): below this threshold, part-throttle
 * torque arbitration uses surplus ICE torque to harvest into the MGU-K transparently without altering net wheel torque;
 * above it, MGU-K deployment ramps smoothly to 100 % at full throttle (Boost deploys from any positive pedal)
 */
export const DEPLOY_THROTTLE_START = 0.6;

/** Energy margin kept at the bottom of the store so the battery never snaps to 0 J under power (J; 0.5 % of 4 MJ) */
export const CUT_ENERGY_MARGIN_J = 20_000;

/**
 * Minimum speed to start normal energy-management superclipping (km/h): keeps full-throttle harvest to the top end of
 * straights and gives hysteresis above the 210 km/h release floor (Charge mode still harvests from 210 km/h)
 */
const SUPERCLIP_ENTRY_KMH = 245;

/**
 * The driver's Boost in a race since the Miami 2026 changes: the power when pressed, or this much if that is less; it
 * gives no more ("capped at +150 kW, or the car's current power level at activation if higher": the FIA, 20 Apr 2026).
 * Uncapped outside races (DC, W)
 */
export const BOOST_RACE_FLOOR_W = 150_000;

/** The pedal travel that, held for `PENDING_S`, puts the car in a power-limited period (the 250 kW curve's) */
const PENDING_THROTTLE = 0.98;
const PENDING_S = 1;

/** The pedal travel the control unit reads as flat out (0..1) */
const FLAT_OUT = 0.95;

/**
 * The energy a power-limited cut (C5.12.6 / C5.12.7) from `fromW` down to 100 kW at `rateWps` (100 or 50 kW/s) takes,
 * under which the rest drops at once; plus `CUT_ENERGY_MARGIN_J` (20 kJ) to spare
 */
export function cutEnergyJ(fromW: number, rateWps: number = F1_2026_ERS.limitRateWps): number {
  const R = F1_2026_ERS;
  if (fromW <= R.limitFreeBelowW) return CUT_ENERGY_MARGIN_J;
  return CUT_ENERGY_MARGIN_J + (0.5 * (fromW + R.limitFreeBelowW) * (fromW - R.limitFreeBelowW)) / rateWps;
}

/**
 * Inverse of `cutEnergyJ`: the highest DC deploy power (W) from which the store's remaining `energyJ` can still execute
 * a compliant C5.12.6 ramp down to 100 kW at `rateWps` without emptying. Draining along this ceiling naturally yields
 * dP/dt = −rateWps down to 100 kW at `CUT_ENERGY_MARGIN_J`, then cuts cleanly to 0 W
 */
export function maxSafeDeployW(energyJ: number, rateWps: number = F1_2026_ERS.limitRateWps): number {
  if (energyJ <= CUT_ENERGY_MARGIN_J) return 0;
  const R = F1_2026_ERS;
  const p0 = R.limitFreeBelowW;
  return Math.min(R.maxDcW, Math.sqrt(p0 * p0 + 2 * rateWps * (energyJ - CUT_ENERGY_MARGIN_J)));
}

/**
 * C5.2.8: the ERS-K's DC power that may propel the car at a road speed (W), with Overtake active or not, on the event's
 * curves: the base pair (i, ii), Monaco's lower "Rev 1" pair (350 kW to 200 km/h, nothing from 300 km/h, or 310 with
 * Overtake: the FIA's Power Unit Information for Monaco 2026), or, in a race's 250 kW sector in a power-limited
 * period without Overtake, the "Alt 1" curve (iii)
 */
export function ersKDeployLimitW(speedKmh: number, overtake: boolean, curves: ErsCurveSet = 'base', alt1 = false): number {
  const v = Math.max(0, speedKmh);
  let kw: number;
  if (curves === 'rev1') {
    if (overtake) kw = v >= 310 ? 0 : v >= 300 ? 4650 - 15 * v : 750 - 2 * v;
    else kw = v >= 300 ? 0 : 1050 - 3.5 * v;
  } else if (overtake) kw = v >= 355 ? 0 : 7100 - 20 * v;
  else if (alt1) {
    kw = v >= 345 ? 0 : v >= 340 ? 6900 - 20 * v : v >= 310 ? 1800 - 5 * v : 250;
  } else if (v >= 345) kw = 0;
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
  /** The share of Overtake's power over the normal curve that is used (1; less for the game's Automatic Overtake) */
  overtakeShare: number;
  /** The event's speed curves */
  curves: ErsCurveSet;
  /** In a race, in a sector of the 250 kW curve (C5.2.8 iii): it applies once a power-limited period is under way */
  alt1Sector: boolean;
  /**
   * How much a power-limited period may cut at its start (W; C5.12.4: 150 kW, more in the sectors the FIA names).
   * There the management's cut takes all the power at once, which meets the rule's least cut of 250 kW in Low Grip
   * Conditions in a race
   */
  cutStepW: number;
  /** The cuts' rate (W/s, C5.12.6) */
  cutRateWps: number;
  /** In a sector where a cut may be reset (C5.12.5) */
  resetSector: boolean;
  /**
   * The driver's Boost, held: maintains or raises the motor's power whatever the management wants, and gives back a cut
   * (C5.12.5); never less than without it. `boostCapped` (a race): it raises it to no more than the power when
   * pressed, or 150 kW if that was less. `boostHoldOnly` (Low Grip Conditions, any session; Section B7.2.1 g i): it
   * only stops the power dropping (no cut while held), and raises and gives back nothing
   */
  boost: boolean;
  boostCapped: boolean;
  boostHoldOnly: boolean;
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
  /** Flat out above 210 km/h (in either Power Limited Pending or Power Limited) */
  private inPeriod = false;
  /** Power has been reduced below full demand or superclipping is active inside this period */
  private limited = false;
  /** Remaining mandatory 1 s fixed hold for the Power Limited Pending (PLP) initial reduction (C5.12.4) */
  private holdS = 0;
  /** Whether the previous step was flat out (`throttle >= FLAT_OUT`), to detect entering PLP at >= 210 km/h */
  private prevFlatOut = false;
  /** Harvesting flat out in this power-limited period */
  private superclipping = false;
  /** Ramped superclipping harvest power (DC W, 0..SUPERCLIP_DC_W) */
  private superclipW = 0;
  /** Latched when speed drops below 210 km/h during superclipping, cleared on lift/reset/boost to stop 210 km/h chatter */
  private superclipInhibited = false;
  /** Holding the deployment back after a standing start (C5.2.12) */
  private standingStart = false;
  /** The DC power the store gave the motor last step (W, + deploy): a cut runs from it */
  public lastDcW = 0;
  /** The driver's Boost held since this press, and the power it was pressed at (DC W) */
  private boostHeld = false;
  private boostFromW = 0;
  /** Time flat out at >= PENDING_THROTTLE (s), towards Alt 1 power-limited period */
  private flatS = 0;
  /** The deployment ceiling this step, the rules' and the control unit's (DC W) */
  public deployCeilingW = 0;
  /** What the motor may fill the turbo's lag with this step (DC W): the rules' limit where the management deploys */
  public fillCeilingW = 0;

  /** A standing start from the grid: no deployment until 50 km/h */
  armStandingStart(): void {
    this.standingStart = true;
  }

  /** Standing-start 50 km/h lockout still active (C5.2.12) */
  get isStandingStart(): boolean {
    return this.standingStart;
  }

  reset(): void {
    this.levelW = 0;
    this.inPeriod = this.limited = this.superclipping = this.superclipInhibited = this.standingStart = this.boostHeld = this.prevFlatOut = false;
    this.holdS = this.superclipW = this.lastDcW = this.deployCeilingW = this.fillCeilingW = this.boostFromW = this.flatS = 0;
  }

  /** A step the control did not run: the driver lifting or braking, or the drive out. Any power-limited period ends */
  release(): void {
    this.inPeriod = this.limited = this.superclipping = this.superclipInhibited = this.prevFlatOut = false;
    this.holdS = this.superclipW = this.deployCeilingW = this.fillCeilingW = this.boostFromW = this.flatS = 0;
  }

  /** The driver's Boost under way */
  get boosting(): boolean {
    return this.boostHeld;
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
    const flatOut = i.throttle >= FLAT_OUT;
    const wasFlatOut = this.prevFlatOut;
    this.prevFlatOut = flatOut;
    this.flatS = i.throttle >= PENDING_THROTTLE ? this.flatS + i.h : 0;
    const alt1 = i.alt1Sector && this.flatS >= PENDING_S;
    let capW = ersKDeployLimitW(i.speedKmh, i.overtake, i.curves, alt1);
    if (i.overtake && i.overtakeShare < 1) {
      const normalW = ersKDeployLimitW(i.speedKmh, false, i.curves, alt1);
      capW = normalW + Math.max(0, i.overtakeShare) * (capW - normalW);
    }
    // What the management wants of the motor: all of it where a joule buys enough time, none where it does not. The
    // Boost never asks for less than that: it raises the want to the whole curve (in a race to its power when pressed,
    // or 150 kW). While Boost is held before a managed cut begins, boostFromW tracks upward with deployment so holding
    // Space/B out of a slow corner does not latch a stale 0 kW.
    const fullW = R.maxDcW * share;
    const managed = !Number.isNaN(i.deployAboveSPerMJ);
    const managedCut = managed && !(i.valueSPerMJ > i.deployAboveSPerMJ);
    if (i.boost && !this.boostHeld) this.boostFromW = Math.max(0, this.lastDcW);
    else if (i.boost && !managedCut && !this.limited) this.boostFromW = Math.max(this.boostFromW, Math.max(0, this.lastDcW));
    this.boostHeld = i.boost;
    // In Low Grip Conditions it only stops the power dropping: no cut while it is held, and nothing raised or given back
    const boostRaises = this.boostHeld && !i.boostHoldOnly;
    const boostHolds = this.boostHeld && i.boostHoldOnly;

    const slow = i.speedKmh < R.limitFreeBelowKmh;
    const liftedOrSlow = !flatOut || slow;
    if (!flatOut) this.superclipInhibited = false;

    // The store is never run empty under power: `maxSafeDeployW` caps deploy along the exact C5.12.6 deceleration
    // parabola so draining at full throttle always ramps down at cutRateWps to 100 kW at 20 kJ (0.5 % SOC) and cuts
    // cleanly to 0 W without ever snapping to 0 J or stranding usable charge above 0.5 % SOC.
    const energyJ = i.soc * R.storeJ;
    const safeW = this.standingStart ? 0 : maxSafeDeployW(energyJ, i.cutRateWps);

    let wantW = fullW;
    if (managedCut && !boostRaises) wantW = 0;
    else if (boostRaises && managedCut && i.boostCapped) wantW = Math.min(fullW, Math.max(this.boostFromW, BOOST_RACE_FLOOR_W));
    wantW = Math.min(wantW, safeW);
    const allowed = wantW > 0;

    if (liftedOrSlow || i.resetSector) {
      // Off the throttle, below 210 km/h, or in an FIA reset sector (C5.12.5): no active power-limited period. If
      // speed dipped below 210 km/h while flat-out superclipping, inhibit re-entry until the driver lifts so we never
      // chatter around 210 km/h.
      if (slow && flatOut && this.superclipping) this.superclipInhibited = true;
      if (i.resetSector) this.superclipInhibited = false;
      this.inPeriod = this.limited = this.superclipping = false;
      this.holdS = 0;
      this.superclipW = 0;
      this.levelW = wantW;
    } else if (boostRaises && wantW >= this.levelW - 1) {
      // Driver Boost recovers or holds power inside a power-limited period (C5.12.5), ramping up cleanly at 2000 kW/s
      // when recovering from a cut or superclipping so releasing/pressing never bangs the driveline.
      this.superclipInhibited = false;
      this.limited = this.superclipping = false;
      this.holdS = 0;
      this.superclipW = 0;
      this.inPeriod = true;
      this.levelW = wantW > this.levelW ? Math.min(wantW, this.levelW + BOOST_RAMP_WPS * i.h) : wantW;
    } else if (i.shifting) {
      // C5.12.7: rate limit is suspended during a gearshift so a cut may take effect at once,
      // without ending an active power-limited period (C5.12.5) or breaking a Low Grip Boost hold
      this.inPeriod = true;
      if (wantW < this.levelW && !(boostHolds && this.levelW <= safeW + 1)) {
        this.levelW = wantW;
        this.limited = true;
        this.holdS = 0;
      }
      this.superclipping = false;
      this.superclipW = 0;
    } else if (!this.inPeriod) {
      // Entering flat-out above 210 km/h: distinguish starting Power Limited Pending (PLP, C5.12.4) on fresh full
      // throttle vs crossing 210 km/h after already accelerating flat out through PLP.
      this.inPeriod = true;
      const bigCut = i.cutStepW > R.limitStepW;
      if (!wasFlatOut && wantW < Math.min(capW * share, safeW) - 1) {
        // C5.12.4: at the start of PLP, initial reduction cannot exceed 150 kW (min 200 kW from 350 kW) and stays
        // fixed for 1 s, except in FIA Power Reduction sectors (`bigCut`) where a larger initial cut is permitted.
        const startW = Math.min(capW * share, safeW);
        this.levelW = Math.max(wantW, startW - i.cutStepW);
        this.limited = true;
        this.holdS = bigCut ? 0 : R.limitHoldS;
        if (this.holdS <= 0 && this.levelW < R.limitFreeBelowW) this.levelW = wantW;
      } else if (wantW < this.levelW - 1 && !(boostHolds && this.levelW <= safeW + 1)) {
        const from = Math.min(this.levelW, Math.max(0, this.lastDcW));
        this.levelW = Math.max(wantW, from - i.cutRateWps * i.h);
        if (this.levelW < R.limitFreeBelowW) this.levelW = wantW;
        this.limited = true;
        this.holdS = 0;
      } else {
        this.levelW = wantW;
      }
    } else if (boostHolds && this.levelW <= safeW + 1 && wantW < this.levelW) {
      // A Low Grip Boost (B7.2.1 g i): holds the deployment ceiling fixed while the store can sustain it
    } else if (wantW < this.levelW - 1) {
      // Inside an active period: honor any remaining C5.12.4 1 s PLP hold (while battery can sustain it); once in
      // Power Limited (PL), ramp down purely at C5.12.6's rate (100 or 50 kW/s) with no mid-straight 150 kW cliff,
      // dropping freely to wantW once under 100 kW (C5.12.7). In FIA-designated Power Reduction sectors
      // (`cutStepW > 150 kW`), C5.12.4 permits an immediate drop up to `cutStepW` when the cut begins.
      const bigCut = i.cutStepW > R.limitStepW;
      if (!this.limited && bigCut) {
        const from = Math.min(this.levelW, Math.max(0, this.lastDcW));
        this.levelW = Math.max(wantW, from - i.cutStepW);
        if (this.levelW < R.limitFreeBelowW) this.levelW = wantW;
        this.limited = true;
        this.holdS = 0;
      } else if (this.holdS > 0 && this.levelW <= safeW + 1) {
        this.holdS = Math.max(0, this.holdS - i.h);
      } else {
        this.holdS = 0;
        const from = this.limited ? this.levelW : Math.min(this.levelW, Math.max(0, this.lastDcW));
        this.levelW = Math.max(wantW, from - i.cutRateWps * i.h);
        if (this.levelW < R.limitFreeBelowW) this.levelW = wantW;
        this.limited = true;
      }
    } else if (!this.limited) {
      this.levelW = wantW;
    }
    // (inside a power-limited period nothing cut is given back: the ceiling holds; a Low Grip Boost holds it too)

    this.deployCeilingW = Math.min(this.levelW, capW * share);
    const fillCapW = Math.min(capW * Math.max(0, i.fillShare), safeW);
    const cappedFill = safeW < capW || (boostRaises && managedCut && i.boostCapped);
    const deployPedal = boostRaises
      ? Math.min(1, i.throttle)
      : Math.max(0, Math.min(1, (i.throttle - DEPLOY_THROTTLE_START) / (1 - DEPLOY_THROTTLE_START)));
    this.fillCeilingW =
      allowed && !this.limited && (boostRaises || i.throttle > DEPLOY_THROTTLE_START)
        ? cappedFill
          ? Math.min(fillCapW, this.levelW)
          : fillCapW
        : this.deployCeilingW * (boostRaises || i.throttle > DEPLOY_THROTTLE_START ? 1 : 0);
    const deployW = this.deployCeilingW * deployPedal;
    if (deployW > 0) {
      this.superclipping = false;
      this.superclipW = 0;
      return deployW;
    }

    // The cut done and a joule worth little here: ramp smoothly into full-throttle harvesting (superclipping) up to the
    // lap's recharge room or a full store. Under Low Grip Boost (B7.2.1 g i), inhibit entering or deepening harvest
    // without cancelling already-active harvest (which would increase power).
    if (!liftedOrSlow && !i.shifting && managed && !boostRaises && this.levelW <= 0 && !this.superclipInhibited) {
      const minEntryKmh = i.superclipBelowSPerMJ >= 1e6 ? R.limitFreeBelowKmh : SUPERCLIP_ENTRY_KMH;
      if (!this.superclipping && !boostHolds && i.speedKmh >= minEntryKmh && i.valueSPerMJ < i.superclipBelowSPerMJ) {
        this.superclipping = this.limited = true;
      }
      if (this.superclipping && i.superclipRoomJ > 0 && i.soc < 1) {
        if (!boostHolds) {
          this.superclipW = Math.min(SUPERCLIP_DC_W, this.superclipW + SUPERCLIP_RAMP_WPS * i.h);
        }
        if (this.superclipW > 0) {
          return -Math.min(this.superclipW, i.superclipRoomJ / Math.max(i.h, 1e-6));
        }
      }
    }
    this.superclipping = false;
    this.superclipW = 0;
    return 0;
  }
}
