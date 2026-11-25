/**
 * Dynamic vehicle simulation and registry for imported Assetto Corsa car mods.
 * Connects custom CarPhysicsConfig objects into LibreCorsa's F12026CarSim and runtime registries.
 */

import { F12026CarSim, type CarSimProfile } from '@/lib/sim/f12026-car/F12026CarSim';
import type { CarPhysicsConfig } from '@/lib/sim/f12026-car/F12026CarConfig';
import {
  registerDynamicVehicleModel,
  unregisterDynamicVehicleModel,
  type VehicleModel,
} from '@/lib/cars/vehicle-models';
import {
  registerDynamicCar,
  unregisterDynamicCar,
  type CarClassId,
  type CarDefinition,
  type CarId,
} from '@/lib/cars/car-registry';
import { carSkinFor } from '@/lib/cars/car-skins';
import { SUZUKI_LIANA_SOUND } from '@/lib/sim/road/SuzukiLianaSim';
import { LC26_SOUND } from '@/lib/sim/CarAudio';
import { HOSTED_CONTENT } from '@/lib/hosted-content';
import type { CustomCarRecord, CustomCarSkin } from './mod-store';
import { getAllCustomCars, saveCustomCar } from './mod-store';
import type { VehicleModelId } from '@/types/f1';
import { parseKn5, buildKn5SceneAsync, createTextureAsync, type Kn5Model } from './kn5-loader';
import { planKn5Appearance } from './kn5-appearance';
import { bindKn5Liveries } from './kn5-liveries';
import { isCspProtectedKn5Blob } from './kn5-protection';
import {
  deterministicSkinSwatch,
  isColorAchromatic,
  isMonochromeName,
} from './mod-extractor';
import { registerPortedCarTemplate, unregisterPortedCarTemplate } from '@/lib/ported-car-model';
import { OPEN_WHEEL_KEYBOARD_STEER } from '@/lib/input/keyboard-steer';
import { registerDynamicCarWheelLock } from '@/lib/input/device-input';
import { registerCarRevRange, unregisterCarRevRange } from '@/lib/sim/rev-range';
import { migrateAcTurbo } from './ac-turbo';
import { peakDriveSlipRatio } from './ac-tyre-shape';

/**
 * Calibrates and sanitizes car physics to remove double-counted body drag and calibrate rev ranges.
 * Modifies `config` in-place and returns `true` if any adjustments were made.
 */
export function sanitizeCarPhysics(id: string, config: CarPhysicsConfig): boolean {
  let changed = migrateAcTurbo(config.engine);

  // Records saved before imported floors kept their authored angle must use the
  // same reference as newly imported AC elements. Built-in cars do not pass here.
  for (const wing of config.aero.wings ?? []) {
    if (wing.name === 'VENTURI_FLOOR' && wing.aoaReference !== 'setup') {
      wing.aoaReference = 'setup';
      changed = true;
    }
  }

  // 1. Rev range calibration
  const redline = config.gearbox?.gears?.redline_rpm ?? (config.engine as any)?.redline_rpm ?? 7000;
  if (!config.revRange) {
    config.revRange = id.includes('rss_formula_rss_4')
      ? [5456, 6349]
      : [Math.round((redline - 150) * 0.82), redline - 150];
    changed = true;
  }

  // 2. Assetto Corsa Formula RSS 4 specific calibration
  if (id.includes('rss_formula_rss_4')) {
    if (config.aero.drag !== 0) {
      config.aero.drag = 0;
      changed = true;
    }
    if (config.aero.wings && config.aero.wings.length >= 7) {
      // Diffuser wings (2..5): zero out drag in case older import gave them dummy values
      for (let i = 2; i <= Math.min(5, config.aero.wings.length - 1); i++) {
        const w = config.aero.wings[i];
        if (w) {
          w.lutAOA_CD = [[-10, 0], [10, 0]];
          w.lutGH_CD_mult = [[-10, 0], [10, 0]];
          changed = true;
        }
      }
      // Wing 6: BodyBase (AC body base CD = 0.64)
      if (config.aero.wings[6]) {
        config.aero.wings[6].lutAOA_CD = [[-10, 1], [10, 1]];
        config.aero.wings[6].lutGH_CD_mult = [[-10, 0.64], [10, 0.64]];
        changed = true;
      }
      // Wing 7: BodyGH (AC ride-height ground drag 0..0.16)
      if (config.aero.wings[7]) {
        config.aero.wings[7].lutAOA_CD = [[-10, 1], [10, 1]];
        config.aero.wings[7].lutGH_CD_mult = [
          [0, 0],
          [0.05, 0.04],
          [0.10, 0.08],
          [0.20, 0.16],
        ];
        changed = true;
      }
      // Wing 8: BodyAOA (pitch drag 0.0)
      if (config.aero.wings[8]) {
        config.aero.wings[8].lutAOA_CD = [[-10, 0], [10, 0]];
        config.aero.wings[8].lutGH_CD_mult = [[-10, 1], [10, 1]];
        changed = true;
      }
    }
  }

  // 3. General aerodynamic sanity check for any mod:
  // If wings are present and total static drag area exceeds sensible limits, eliminate double-counted body drag.
  if (config.aero.wings && config.aero.wings.length > 0) {
    let wingDragSum = 0;
    for (const w of config.aero.wings) {
      const aoaMid = w.lutAOA_CD ? w.lutAOA_CD[Math.floor(w.lutAOA_CD.length / 2)]?.[1] ?? 0 : 0;
      const ghMid = w.lutGH_CD_mult ? w.lutGH_CD_mult[Math.floor(w.lutGH_CD_mult.length / 2)]?.[1] ?? 1 : 1;
      wingDragSum += aoaMid * ghMid * w.area;
    }
    const isFormula = config.chassis.totalMassKg < 950;
    const maxSaneTotalCdA = isFormula ? 1.05 : 1.6;
    if (config.aero.drag + wingDragSum > maxSaneTotalCdA && config.aero.drag > 0.4) {
      config.aero.drag = 0;
      changed = true;
    }
  }

  // 4. Formula RSS 4 tyre calibration for older records
  const softKey = config.compoundSlots?.soft;
  const comp = softKey ? config.tyreCompounds?.[softKey] : undefined;
  if (comp?.modelData) {
    if (id.includes('rss_formula_rss_4')) {
      comp.modelData.brakeDxMod = 0.06;
      if (!comp.rearOverride) {
        comp.rearOverride = {
          modelData: {
            friction_limit_angle: 6.34,
            Fz0: 2995,
            lsExpY: 0.76,
            lsExpX: 0.766,
            Dy0: 1.61,
            Dx0: 1.61,
            falloff_level: 0.85,
            falloff_slope: 3.0,
            slip_ratio_limit: 0.25,
            speedSensitivity: 0.002848,
            relaxationLengthX: 0.096,
            relaxationLengthY: 0.096,
            rollingResistance: 0.008,
            brakeDxMod: 0.06,
            longStiffnessMult: 1.02,
          },
          pressureData: {
            optimalPsi: 25,
          },
        };
        changed = true;
      }
    }
  }

  // 5. Hardpoints sanity check: purge any hardpoints containing NaN or incomplete arrays
  for (const axle of ['front', 'rear'] as const) {
    const susp = config.suspensions?.[axle];
    if (susp?.hardpoints) {
      const isBad =
        susp.hardpoints.length < 6 ||
        susp.hardpoints.some((p) => !p || p.length < 3 || p.some((v) => !Number.isFinite(v)));
      if (isBad) {
        susp.hardpoints = undefined;
        changed = true;
      }
    }
  }

  // 6. Formula / single-seater aerodynamic balance and diffuser stall protection:
  // For formula cars (mass < 950kg or open-wheel), ensure:
  // a) lutGH_CL_mult minimum is clamped to at least 0.85 to prevent diffuser stall under downhill / compression loads
  // b) Aerodynamic Center of Pressure balance is calibrated to target ~41.5% front share (58.5% rear)
  // c) Bumpstops have progressive cushions (progression: 1.5, min range: 0.015m, rate >= 250,000 N/m)
  // d) Steering road wheel angle is capped at 16.5° and tyre grip plateau is stabilized
  const isFormula = config.chassis.totalMassKg < 950;
  if (isFormula && config.aero.wings && config.aero.wings.length > 0) {
    // a) Diffuser stall clamp
    for (const w of config.aero.wings) {
      if (w.lutGH_CL_mult) {
        for (const pt of w.lutGH_CL_mult) {
          if (pt[1] < 0.85) {
            (pt as [number, number])[1] = 0.85;
            changed = true;
          }
        }
      }
    }

    // b) Aero CoP balance
    const wheelbase = config.chassis.wheelbase || 3.6;
    const frontShare = config.chassis.frontWeightFraction || 0.46;
    const cgToRear = wheelbase * frontShare;

    let frontDownSum = 0;
    let rearDownSum = 0;
    for (const w of config.aero.wings) {
      const aoaMid = w.lutAOA_CL ? w.lutAOA_CL[Math.floor(w.lutAOA_CL.length / 2)]?.[1] ?? 0 : 0;
      const ghMid = w.lutGH_CL_mult ? w.lutGH_CL_mult[Math.floor(w.lutGH_CL_mult.length / 2)]?.[1] ?? 1 : 1;
      const fd = Math.max(0, aoaMid * ghMid * w.area);
      const armShare = (w.positionZ + cgToRear) / wheelbase;
      frontDownSum += fd * armShare;
      rearDownSum += fd * (1 - armShare);
    }

    const totalDown = frontDownSum + rearDownSum;
    const currentFrontShare = totalDown > 0 ? frontDownSum / totalDown : 0.5;
    const targetFrontShare = 0.415;

    if (currentFrontShare > 0.44 && totalDown > 0) {
      const frontScale = (targetFrontShare / (1 - targetFrontShare)) / (currentFrontShare / (1 - currentFrontShare));
      if (frontScale > 0.1 && frontScale < 0.95) {
        for (const w of config.aero.wings) {
          if (w.name === 'FRONT_WING' || (w.positionZ > 1.2 && !w.name.includes('FLOOR'))) {
            w.area *= frontScale;
            changed = true;
          }
        }
      }
    }

    // c) Skid-block plank & floor coordinates: eliminate catastrophic pitch-up lever arm when bottoming
    const cgHeight = config.chassis.cgHeight || 0.28;
    if (!config.aero.plank || Math.abs(config.aero.plank.frontZ) > 1.5) {
      config.aero.plank = {
        y: -cgHeight + 0.038,
        frontZ: Math.min(1.4, wheelbase * frontShare * 0.75),
        rearZ: -Math.min(1.2, wheelbase * (1 - frontShare) * 0.75),
      };
      config.aero.floorOffsetY = -cgHeight + 0.025;
      changed = true;
    }

    // d) Bumpstop cushions: progressive resistance halts chassis travel before the floor strikes asphalt
    for (const axle of ['front', 'rear'] as const) {
      const bs = config.suspensions?.[axle]?.bumpStop;
      if (bs) {
        if (!bs.progression || bs.progression < 5_000_000) {
          bs.progression = 8_000_000;
          changed = true;
        }
        if (bs.range > 0.028) {
          bs.range = 0.028;
          changed = true;
        }
        if (bs.rate < 160_000) {
          bs.rate = 160_000;
          changed = true;
        }
      }
    }

    // e) Steering road wheel angle limit
    if (config.chassis.maxRoadWheelDeg > 16.5) {
      config.chassis.maxRoadWheelDeg = 16.5;
      changed = true;
    }

    // f) Tyre friction limit angle and progressive falloff
    if (config.tyreCompounds) {
      for (const comp of Object.values(config.tyreCompounds)) {
        if (comp.modelData) {
          if (!comp.modelData.friction_limit_angle || comp.modelData.friction_limit_angle < 8.5) {
            comp.modelData.friction_limit_angle = 8.5;
            changed = true;
          }
          if (!comp.modelData.falloff_level || comp.modelData.falloff_level < 0.92) {
            comp.modelData.falloff_level = 0.92;
            changed = true;
          }
          if (!comp.modelData.falloff_slope || comp.modelData.falloff_slope > 0.6) {
            comp.modelData.falloff_slope = 0.6;
            changed = true;
          }
        }
        if (comp.rearOverride?.modelData) {
          if (!comp.rearOverride.modelData.friction_limit_angle || comp.rearOverride.modelData.friction_limit_angle < 8.5) {
            comp.rearOverride.modelData.friction_limit_angle = 8.5;
            changed = true;
          }
          if (!comp.rearOverride.modelData.falloff_level || comp.rearOverride.modelData.falloff_level < 0.92) {
            comp.rearOverride.modelData.falloff_level = 0.92;
            changed = true;
          }
          if (!comp.rearOverride.modelData.falloff_slope || comp.rearOverride.modelData.falloff_slope > 0.6) {
            comp.rearOverride.modelData.falloff_slope = 0.6;
            changed = true;
          }
        }
      }
    }
  }

  // Earlier imports stored AC XMU in slip_ratio_limit instead of curveFullness.
  // Move it once and derive the peak slip from the same angle/CX data used by
  // the brush model. Do this after any single-seater tyre safeguards above.
  for (const tyre of Object.values(config.tyreCompounds ?? {})) {
    const front = tyre.modelData;
    if (front.curve !== 'brush') continue;
    const rear = tyre.rearOverride?.modelData;
    if (front.curveFullness === undefined) {
      front.curveFullness = front.slip_ratio_limit;
      front.slip_ratio_limit = peakDriveSlipRatio(front.friction_limit_angle ?? 7.5, front.longStiffnessMult ?? 1);
      changed = true;
    }
    if (rear && rear.curveFullness === undefined && rear.slip_ratio_limit !== undefined) {
      rear.curveFullness = rear.slip_ratio_limit;
      rear.slip_ratio_limit = peakDriveSlipRatio(
        rear.friction_limit_angle ?? front.friction_limit_angle ?? 7.5,
        rear.longStiffnessMult ?? front.longStiffnessMult ?? 1,
      );
      changed = true;
    }
  }

  return changed;
}

/**
 * Creates a CarSimProfile suitable for running a custom car inside F12026CarSim.
 */
export function createCustomSimProfile(
  id: string,
  config: CarPhysicsConfig,
  classId?: CarClassId
): CarSimProfile {
  sanitizeCarPhysics(id, config);

  const softKey = config.compoundSlots.soft;
  const compound = config.tyreCompounds[softKey];
  const isSingleSeater = config.chassis.totalMassKg < 950;
  const rawDy0 = compound?.modelData?.Dy0 ?? 1.25;

  // In Assetto Corsa, racing/formula cars with slicks and downforce achieve 2.0–2.5 G lateral
  const padLateralMu = isSingleSeater
    ? Math.max(1.7, rawDy0 * 1.05)
    : config.chassis.totalMassKg < 1400 && rawDy0 > 1.3
      ? Math.max(1.35, rawDy0)
      : rawDy0;

  // Calibrate braking envelope according to car class, aero downforce and tyre grip
  const braking = isSingleSeater
    ? { lowG: 1.5, aeroG: 0.8, refMs: 60 }
    : config.chassis.totalMassKg < 1400
      ? { lowG: 1.25, aeroG: 0.35, refMs: 65 }
      : { lowG: 0.95, aeroG: 0.15, refMs: 50 };

  const steerLockDeg = (config.chassis as any)?.steerLockDeg ?? 225;
  const steerRatio = (config.chassis as any)?.steerRatio ?? 12.5;

  // Register rev range for HUD rev lights and dashboard
  registerCarRevRange(id, config.revRange!);

  return {
    id,
    classId,
    config,
    hasErs: config.ers.importedDrive !== undefined,
    hasDrs: config.aero.importedDrs !== undefined,
    initialOvertakingRules: config.aero.importedDrs ? 'drs-rear' : 'none',
    turbo: config.engine.turbo !== undefined,
    coldPsiRange: [18, 38],
    frontCamberRange: [-4.5, 0],
    rearCamberRange: [-4.0, 0],
    tcMinSpeedMs: 10 / 3.6,
    aeroPackagesDeg: {
      low_downforce: [0, 0],
      balanced: [0, 0],
      high_downforce: [0, 0],
    },
    padLateralMu,
    braking,
    assistDials: {
      pro: { tcLevel: 0, tc2Level: 0, absLevel: 0 },
      semi_pro: { tcLevel: 4, tc2Level: 4, absLevel: 4 },
      assisted: { tcLevel: 8, tc2Level: 8, absLevel: 8 },
    },
    racingLine: isSingleSeater ? 'f1' : 'gt3',
    keyboardSteer: isSingleSeater ? OPEN_WHEEL_KEYBOARD_STEER : undefined,
    steerRatio,
    understeerRadPerMs2: 0.001,
  };
}

/**
 * Creates a dynamic VehicleModel that instantiates F12026CarSim on demand.
 */
export function createDynamicVehicleModel(
  id: string,
  config: CarPhysicsConfig,
  classId: CarClassId = 'road'
): VehicleModel {
  const profile = createCustomSimProfile(id, config, classId);
  const redline = config.gearbox?.gears?.redline_rpm ?? (config.engine as any)?.redline_rpm ?? 7000;
  const isSingleSeater = config.chassis.totalMassKg < 950;
  let steerLockDeg = 360;
  if (!isSingleSeater) {
    // AC stores steering-wheel degrees per side; input and FFB need lock-to-lock degrees.
    const perSideLock: unknown = (config.chassis as typeof config.chassis & { steerLockDeg?: unknown }).steerLockDeg;
    if (perSideLock === undefined || perSideLock === null) {
      steerLockDeg = 450;
    } else if (typeof perSideLock === 'number' && Number.isFinite(perSideLock) &&
      perSideLock > 0 && Number.isFinite(perSideLock * 2)) {
      steerLockDeg = perSideLock * 2;
    }
  }
  registerDynamicCarWheelLock(id, steerLockDeg);

  return {
    id: id as unknown as VehicleModelId,
    classId,
    createSim: (track, trackRoot, bodyPlan) =>
      new F12026CarSim(track, trackRoot, {
        ...profile,
        ...(bodyPlan ? { bodyPlan } : {}),
      }),
    limiterRpm: redline,
    telemetryMaxRpm: Math.max(redline * 1.15, 8000),
    tyreSetupRanges: {
      coldPsiRange: profile.coldPsiRange,
      frontCamberRange: profile.frontCamberRange,
      rearCamberRange: profile.rearCamberRange,
    },
    rigConfig: { chassis: config.chassis, aero: config.aero },
    gt3Cockpit: false,
    floorSparks: false,
  };
}

/**
 * Sanitizes and cleans custom car skins: removes underscores and unwanted characters from skin names,
 * and fixes duplicate or achromatic swatches across skins.
 */
export function sanitizeCarSkins(record: CustomCarRecord): boolean {
  if (!record.skins || record.skins.length === 0) return false;
  let changed = false;

  const carCtx = `${record.slug || ''} ${record.title} ${record.author || ''}`;

  // 1. Clean names (underscores, non-breaking spaces, extra whitespace)
  for (const s of record.skins) {
    if (s.name) {
      const cleaned = s.name
        .replace(/[\u00a0\s]+/g, ' ')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned && cleaned !== s.name) {
        s.name = cleaned;
        changed = true;
      }
    }
  }

  // 2. Check if all or most skins share the same generic / low-saturation swatch
  const firstKey = record.skins[0]?.swatch ? `${record.skins[0].swatch[0]}_${record.skins[0].swatch[1]}` : '';
  const identicalCount = record.skins.filter((s) => s.swatch && `${s.swatch[0]}_${s.swatch[1]}` === firstKey).length;
  const mostlyIdentical = record.skins.length > 2 && identicalCount >= record.skins.length * 0.6;

  for (let i = 0; i < record.skins.length; i++) {
    const s = record.skins[i];
    if (s.swatchSource === 'authored' && s.swatch) continue;
    const isGeneric =
      !s.swatch ||
      (s.swatch[0] === '#777777' && s.swatch[1] === '#222222') ||
      (s.swatch[0] === '#080808' && s.swatch[1] === '#dee3de') ||
      (s.swatch[0] === '#333333' && s.swatch[1] === '#e0e0e0');
    const isAchromatic =
      s.swatch &&
      isColorAchromatic(s.swatch[0]) &&
      isColorAchromatic(s.swatch[1]) &&
      !isMonochromeName(s.name);

    if (mostlyIdentical || isGeneric || isAchromatic) {
      const newSwatch = deterministicSkinSwatch(s.name, i, carCtx);
      if (!s.swatch || s.swatch[0] !== newSwatch[0] || s.swatch[1] !== newSwatch[1]) {
        s.swatch = newSwatch;
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * Converts a CustomCarRecord and its model URL into a CarDefinition.
 */
export function createCustomCarDefinition(
  record: CustomCarRecord,
  modelUrl: string,
  thumbUrl?: string,
  skinFiles?: readonly string[][],
): CarDefinition {
  const carCtx = `${record.slug || ''} ${record.title} ${record.author || ''}`;
  const firstKey = record.skins?.[0]?.swatch ? `${record.skins[0].swatch[0]}_${record.skins[0].swatch[1]}` : '';
  const identicalCount = (record.skins ?? []).filter((s) => s.swatch && `${s.swatch[0]}_${s.swatch[1]}` === firstKey).length;
  const mostlyIdentical = (record.skins?.length ?? 0) > 2 && identicalCount >= (record.skins?.length ?? 0) * 0.6;

  return {
    id: record.id as unknown as CarId,
    classId: record.classId || 'road',
    title: record.title,
    sub: record.subTitle || 'Custom Mod',
    badge: 'MOD',
    quality: 'own',
    credit: {
      title: record.title,
      author: record.author || 'Assetto Corsa Mod',
      url: '',
      license: 'Custom Mod',
      licenseUrl: '',
    },
    physics: record.id as unknown as VehicleModelId,
    year: record.year || 2020,
    modelUrl,
    thumbUrl,
    // A repository-only clone has the LC26 bank, but not the hosted Liana audio files.
    sound: HOSTED_CONTENT ? SUZUKI_LIANA_SOUND : {
      ...LC26_SOUND,
      physicsLimiterRpm: record.physicsConfig.gearbox.gears.redline_rpm,
    },
    skins: record.skins?.map((s, idx) => {
      const isGeneric =
        !s.swatch ||
        (s.swatch[0] === '#777777' && s.swatch[1] === '#222222') ||
        (s.swatch[0] === '#080808' && s.swatch[1] === '#dee3de') ||
        (s.swatch[0] === '#333333' && s.swatch[1] === '#e0e0e0');
      const isAchromatic =
        s.swatch &&
        isColorAchromatic(s.swatch[0]) &&
        isColorAchromatic(s.swatch[1]) &&
        !isMonochromeName(s.name);
      const useSwatch = s.swatch && (s.swatchSource === 'authored' || (!mostlyIdentical && !isGeneric && !isAchromatic));
      return {
        id: `skin_${idx}`,
        name: s.name,
        swatch: useSwatch ? s.swatch! : deterministicSkinSwatch(s.name, idx, carCtx),
        files: skinFiles?.[idx] ?? (s.textures ? Object.keys(s.textures) : undefined),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// In-Memory Registry & Lifecycle Management
// ---------------------------------------------------------------------------

export type CustomCarRegistryChange =
  | { type: 'registered'; id: string }
  | { type: 'unregistered'; id: string };

export type SelectedCustomCarRegistryAction =
  | { type: 'fallback'; carId: 'lc26' }
  | { type: 'reload'; carId: string };

const registeredCustomCars = new Map<string, CarDefinition>();
const activeBlobUrls = new Map<string, string>();
const changeListeners = new Set<(change: CustomCarRegistryChange) => void>();
const customCarSkinsMap = new Map<string, CustomCarSkin[]>();
const kn5Revisions = new Map<string, string>();
let nextRevision = 0;

/** Ignore unrelated library changes; reload a replaced selection or fall back when it was removed. */
export function selectedCustomCarActionForRegistryChange(
  selectedCarId: string,
  change: CustomCarRegistryChange,
): SelectedCustomCarRegistryAction | null {
  if (change.id !== selectedCarId) return null;
  return change.type === 'unregistered'
    ? { type: 'fallback', carId: 'lc26' }
    : { type: 'reload', carId: change.id };
}

export function getCustomCarSkinRecord(carId: string): CustomCarSkin[] | undefined {
  return customCarSkinsMap.get(carId) ?? customCarSkinsMap.get(carId.replace(/^custom[_:]/, ''));
}

function setSkinRecords(id: string, skins?: CustomCarSkin[]): void {
  for (const key of new Set([id, id.replace(/^custom[_:]/, '')])) {
    if (skins?.length) customCarSkinsMap.set(key, skins);
    else customCarSkinsMap.delete(key);
  }
}

function notifyListeners(change: CustomCarRegistryChange): void {
  for (const listener of changeListeners) {
    try {
      listener(change);
    } catch (e) {
      console.error('Error in custom mod change listener:', e);
    }
  }
}

/**
 * Registers an imported custom car into memory, creates its 3D model template and thumbnails,
 * and attaches it to vehicle models and car registries.
 */
export function registerCustomCarMod(record: CustomCarRecord, parsedModel?: Kn5Model): CarDefinition {
  sanitizeCarSkins(record);

  // Revoke existing URLs if re-registering
  if (activeBlobUrls.has(record.id)) {
    URL.revokeObjectURL(activeBlobUrls.get(record.id)!);
    activeBlobUrls.delete(record.id);
  }
  if (activeBlobUrls.has(`${record.id}_thumb`)) {
    URL.revokeObjectURL(activeBlobUrls.get(`${record.id}_thumb`)!);
    activeBlobUrls.delete(`${record.id}_thumb`);
  }

  setSkinRecords(record.id, record.kn5Blob ? undefined : record.skins);
  let modelUrl = '';
  let files: string[][] | undefined;
  const kn5Blob = record.kn5Blob;
  if (kn5Blob) {
    modelUrl = `custom:${record.id}`;
    const skins = record.skins ?? [];
    // The sim can read a CarSkin before the template completes. Fill these same lists
    // before resolving the template, so even an early rig uses the composed assets.
    const fileLists: string[][] = skins.map(() => []);
    files = fileLists;
    const revision = `${Date.now().toString(36)}-${nextRevision++}`;
    kn5Revisions.set(record.id, revision);
    // Let the definition register first, even when import already parsed the KN5.
    const loadPromise = Promise.resolve().then(async () => {
      try {
        const kn5 = parsedModel ?? parseKn5(await kn5Blob.arrayBuffer());
        if (kn5Revisions.get(record.id) !== revision) return null;
        const appearance = planKn5Appearance(kn5, { skins, appearanceConfig: record.appearanceConfig });
        // On reload a rig can be created before IndexedDB returns. Its template must already
        // wear the saved paint, even when the rig started without a skin selection.
        const car = registeredCustomCars.get(record.id);
        const saved = car ? carSkinFor(car.id) : null;
        const baseSkinIndex = Math.max(0, car?.skins?.findIndex(({ id }) => id === saved?.id) ?? 0);
        const { skinMaps, runtimeSkins } = bindKn5Liveries(appearance, skins, fileLists, revision, createTextureAsync, baseSkinIndex);
        setSkinRecords(record.id, runtimeSkins);
        return await buildKn5SceneAsync(kn5, {
          revLeds: record.physicsConfig.revLeds,
          cameras: record.physicsConfig.cameras,
          appearance,
          skinMaps,
          baseSkinIndex,
        });
      } catch (err) {
        console.error(`Failed to build KN5 scene for ${record.id}:`, err);
        return null;
      }
    });
    registerPortedCarTemplate(modelUrl, loadPromise);
  } else if (record.glbBlob) {
    kn5Revisions.delete(record.id);
    unregisterPortedCarTemplate(`custom:${record.id}`);
    modelUrl = URL.createObjectURL(record.glbBlob);
    activeBlobUrls.set(record.id, modelUrl);
  }

  let thumbUrl: string | undefined;
  if (record.previewBlob) {
    thumbUrl = URL.createObjectURL(record.previewBlob);
    activeBlobUrls.set(`${record.id}_thumb`, thumbUrl);
  } else if (record.badgeBlob) {
    thumbUrl = URL.createObjectURL(record.badgeBlob);
    activeBlobUrls.set(`${record.id}_thumb`, thumbUrl);
  }

  const vehicleModel = createDynamicVehicleModel(record.id, record.physicsConfig, record.classId);
  registerDynamicVehicleModel(vehicleModel);

  const carDef = createCustomCarDefinition(record, modelUrl, thumbUrl, files);
  registerDynamicCar(carDef);

  registeredCustomCars.set(record.id, carDef);
  notifyListeners({ type: 'registered', id: record.id });

  return carDef;
}

/**
 * Unregisters a custom car mod and frees its memory / blob URLs.
 */
export function unregisterCustomCarMod(id: string): void {
  if (activeBlobUrls.has(id)) {
    URL.revokeObjectURL(activeBlobUrls.get(id)!);
    activeBlobUrls.delete(id);
  }
  if (activeBlobUrls.has(`${id}_thumb`)) {
    URL.revokeObjectURL(activeBlobUrls.get(`${id}_thumb`)!);
    activeBlobUrls.delete(`${id}_thumb`);
  }

  unregisterPortedCarTemplate(`custom:${id}`);
  kn5Revisions.delete(id);
  setSkinRecords(id);
  unregisterDynamicCar(id);
  unregisterDynamicVehicleModel(id);
  unregisterCarRevRange(id);
  registeredCustomCars.delete(id);
  notifyListeners({ type: 'unregistered', id });
}

/**
 * Returns all currently registered custom car definitions.
 */
export function getRegisteredCustomCars(): CarDefinition[] {
  return Array.from(registeredCustomCars.values());
}

/**
 * Subscribes to custom cars registration changes (added/removed).
 */
export function subscribeCustomCars(listener: (change: CustomCarRegistryChange) => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

let initialized = false;
let initPromise: Promise<CarDefinition[]> | null = null;

/**
 * Initializes and registers all custom car mods from IndexedDB storage.
 */
export async function initCustomMods(): Promise<CarDefinition[]> {
  if (initialized) return getRegisteredCustomCars();
  if (typeof window === 'undefined') return [];
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const records = await getAllCustomCars();
      const registered: CarDefinition[] = [];
      for (const record of records) {
        try {
          // Leave older imports intact in the library, but don't offer a scrambled model to drive.
          if (await isCspProtectedKn5Blob(record.kn5Blob)) continue;
          const changed = sanitizeCarPhysics(record.id, record.physicsConfig);
          const skinsChanged = sanitizeCarSkins(record);
          if (changed || skinsChanged) {
            try {
              await saveCustomCar(record);
            } catch (saveErr) {
              console.warn(`Failed to update sanitized mod record in IndexedDB for ${record.id}:`, saveErr);
            }
          }
          registered.push(registerCustomCarMod(record));
        } catch (err) {
          console.warn(`Failed to initialize custom mod ${record.id}:`, err);
        }
      }
      initialized = true;
      return registered;
    } catch (err) {
      console.warn('Failed to load custom mods from IndexedDB:', err);
      return [];
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

// Auto-initialize custom mods in browser environments as early as possible
if (typeof window !== 'undefined') {
  void initCustomMods();
}
