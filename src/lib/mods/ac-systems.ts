import type { AeroData, ERSData, PerformanceModeName, WingData } from '@/lib/sim/f12026-car/F12026CarConfig';
import type { ImportedControllerData, ImportedControllerInput } from '@/lib/sim/f12026-car/imported-controller';
import type { LutPoints } from '@/lib/sim/lut';
import type { AcModData } from './ac-data-decrypt';

const INPUTS = new Set<string>(['GAS', 'BRAKE', 'STEER', 'SPEED_KMH', 'GEAR', 'RPM', 'CONST']);
const ZERO_TORQUE: LutPoints = [[0, 0]];

function sections(mod: AcModData, file: string, prefix: string): string[] {
  return mod.sections(file)
    .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
}

function controller(mod: AcModData, file: string, section: string): ImportedControllerData | undefined {
  const text = (key: string) => mod.text(file, section, key)?.toUpperCase();
  const num = (key: string, fallback: number) => mod.num(file, section, key, fallback);
  const input = text('INPUT')?.replace(/^SPEEDKMH$/, 'SPEED_KMH');
  const operation = text('COMBINATOR');
  if (!input || !INPUTS.has(input) || (operation !== 'ADD' && operation !== 'MULT')) return;
  const min = num('DOWN_LIMIT', -Number.MAX_VALUE);
  const max = num('UP_LIMIT', Number.MAX_VALUE);
  const filter = num('FILTER', 0);
  const constant = num('CONST_VALUE', NaN);
  const lut = input === 'CONST' && Number.isFinite(constant)
    ? [[0, constant]] as const : mod.lutOf(file, section, 'LUT');
  if (!lut.length || min > max || filter < 0 || filter > 1) return;
  return { input: input as ImportedControllerInput, operation, lut, min, max, filter };
}

export function mapAcAeroSystems(mod: AcModData, wingSections: readonly string[], wings: WingData[]): AeroData['importedDrs'] {
  const byNumber = new Map(wingSections.map((section, i) => [Number(section.slice('WING_'.length)), wings[i]]));
  for (const section of sections(mod, 'aero.ini', 'DYNAMIC_CONTROLLER_')) {
    const index = mod.num('aero.ini', section, 'WING');
    const wing = byNumber.get(index);
    const spec = wing && controller(mod, 'aero.ini', section);
    if (wing && spec) (wing.activeControllers ??= []).push(spec);
  }
  for (const section of sections(mod, 'drs.ini', 'WING_')) {
    const wing = byNumber.get(Number(section.slice('WING_'.length)));
    if (!wing) continue;
    const mode = mod.text('drs.ini', section, 'MODE')?.toUpperCase();
    const angleDeg = mod.num('drs.ini', section, 'ANGLE');
    const effect = mod.num('drs.ini', section, 'EFFECT');
    if ((mode === 'ANGLE' || !mode) && Number.isFinite(angleDeg)) wing.importedDrs = { angleDeg };
    else if ((mode === 'EFFECT' || !mode) && Number.isFinite(effect)) wing.importedDrs = { effect };
  }
  if (!wings.some((wing) => wing.importedDrs)) return;
  const limit = mod.num('drs.ini', 'DEACTIVATION', 'LIMIT_G');
  return {
    ignoreZones: mod.num('drs.ini', 'DRS_ZONES', 'IGNORE_ZONES') === 1,
    ...(limit > 0 ? { lateralLimitG: limit } : {}),
  };
}

const peakWatts = (curve: LutPoints) => curve.reduce((peak, [rpm, torque]) => Math.max(peak, rpm * torque * Math.PI / 30), 0);

export function mapAcHeatRecovery(mod: AcModData): NonNullable<ERSData['importedDrive']>['heat'] {
  const chargeK = mod.num('ers.ini', 'HEAT', 'CHARGE_K');
  const torquePercent = mod.num('ers.ini', 'HEAT', 'TORQUE_PERC');
  if (!Number.isFinite(chargeK) || chargeK <= 0 || !(torquePercent > 0 && torquePercent <= 100)) return;
  return { chargeK, torqueFraction: torquePercent / 100 };
}

export function mapAcKineticDrive(mod: AcModData, authoredIceTorque: LutPoints): ERSData | undefined {
  const file = 'ers.ini';
  const num = (key: string, fallback = NaN) => mod.num(file, 'KINETIC', key, fallback);
  const torqueLut = mod.lutOf(file, 'KINETIC', 'TORQUE_CURVE');
  const coastLut = mod.lutOf(file, 'KINETIC', 'COAST_CURVE').map(([rpm, nm]) => [rpm, Math.abs(nm)] as const);
  const deployW = peakWatts(torqueLut);
  if (!(deployW > 0 && Number.isFinite(deployW))) return;

  // AC EV mods can put the entire drive curve in ERS and leave only a stub at zero rpm in power.lut.
  // Never infer this from a missing power.lut (an incomplete ordinary hybrid may be missing it).
  const electric = authoredIceTorque.some(([rpm]) => rpm >= 500)
    && authoredIceTorque.every(([rpm, torque]) => rpm < 500 || torque === 0);
  const defaultIndex = num('DEFAULT_CONTROLLER', 1);
  const modes: Partial<Record<PerformanceModeName, ImportedControllerData[]>> = {};
  const readMode = (index: number): ImportedControllerData[] => {
    const name = `ctrl_ers_${index}.ini`;
    const rows = sections(mod, name, 'CONTROLLER_');
    const parsed = rows.map((section) => controller(mod, name, section));
    // An incomplete multiplication chain can expose full deployment at the wrong time.
    return parsed.every((stage) => stage !== undefined) ? parsed : [];
  };
  const balanced = readMode(defaultIndex);
  if (balanced.length) modes.BAL = balanced;
  for (const [mode, index] of [['CHR', 0], ['RAC', 2], ['PSH', 4], ['LIC', 5]] as const) {
    const authored = readMode(index);
    if (authored.length || balanced.length) modes[mode] = authored.length ? authored : balanced;
  }

  const lapJ = num('MAX_KJ_PER_LAP') * 1000;
  const explicitCapacityJ = num('MAX_KJ') * 1000;
  const durationS = num('DISCHARGE_TIME', 30_000) / 1000;
  const durationCapacityJ = deployW * durationS;
  const lapLimit = Number.isFinite(lapJ) && lapJ > 0 ? lapJ : undefined;
  const capacityJ = Number.isFinite(explicitCapacityJ) && explicitCapacityJ > 0 ? explicitCapacityJ
    : (lapLimit ?? durationCapacityJ);
  if (!(capacityJ > 0 && Number.isFinite(capacityJ))) return;
  const harvestW = peakWatts(coastLut);
  const regenerative = num('CHARGE_K', 0) > 0 && harvestW > 0 && Number.isFinite(harvestW);
  return {
    torqueLut,
    coastLut: regenerative ? coastLut : ZERO_TORQUE,
    ERS_MAX_DEPLOY: deployW,
    maxHarvestW: regenerative ? harvestW : 0,
    ERS_MAX_CHARGE: capacityJ,
    deployPerLapJ: electric ? Number.MAX_VALUE : (lapLimit ?? Number.MAX_VALUE),
    harvestPerLapJ: Number.MAX_VALUE,
    deployEfficiency: 1,
    harvestEfficiency: 1,
    liftThrottle: 0,
    topGearLiftHarvestW: 0,
    importedDrive: { electric, buttonOverride: !electric && num('HAS_BUTTON_OVERRIDE') === 1, regenerative, maps: modes },
  };
}
