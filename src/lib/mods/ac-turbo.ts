import type { EngineData } from '@/lib/sim/f12026-car/F12026CarConfig';

/** A zero AC reference means boost from the first rev. Use 1 rpm so the boost
 * law still returns zero with a closed throttle and never has to divide by zero. */
export function acTurboReferenceRpm(rpm: number): number {
  return rpm === 0 ? 1 : rpm;
}

/** Repair imports made before zero-reference turbos were normalized. At every
 * positive (integer) RPM the old curve already has the correct full boost. */
export function migrateAcTurbo(engine: EngineData): boolean {
  const turbo = engine.turbo;
  if (!turbo || turbo.referenceRpm !== 0) return false;

  turbo.referenceRpm = acTurboReferenceRpm(turbo.referenceRpm);
  if (turbo.spoolRefRpm === 0) turbo.spoolRefRpm = turbo.referenceRpm;
  engine.powerCurve = engine.powerCurve.map(([rpm, kw]) => [rpm, rpm === 0 ? 0 : kw]);
  return true;
}
