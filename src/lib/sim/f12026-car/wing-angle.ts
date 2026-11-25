import type { WingData } from './F12026CarConfig';

/**
 * Built-in floors read absolute rake; AC-imported elements use their authored setup
 * angle plus the body's pitch change, just like the other wing elements.
 */
export function wingAngleOfAttack(
  wing: Pick<WingData, 'name' | 'angleDeg' | 'aoaReference'>,
  rakeDeg: number,
  staticRakeDeg: number,
): number {
  return wing.name === 'VENTURI_FLOOR' && wing.aoaReference !== 'setup'
    ? rakeDeg
    : wing.angleDeg + (rakeDeg - staticRakeDeg);
}
