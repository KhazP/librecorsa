/**
 * A car's box for car-to-car contact (`resolveCarToCarObbCollision`): the rectangle round the outline its barrier
 * probes follow (the body's measured plan and the tyres' corners), so a small car is small to the cars round it too.
 * The outline is not centred on the centre of gravity, so the box carries how far its centre sits ahead of it.
 */
export interface ContactBox {
  /** Half the box's length and width (m) */
  readonly halfLengthM: number;
  readonly halfWidthM: number;
  /** How far the box's centre is ahead of the centre of gravity (m, − behind it) */
  readonly centreAheadM: number;
  /** The farthest the box reaches from the centre of gravity (m): its front corners' or its rear corners' distance */
  readonly reachM: number;
}

const boxOf = (halfLengthM: number, halfWidthM: number, centreAheadM: number): ContactBox => ({
  halfLengthM,
  halfWidthM,
  centreAheadM,
  reachM: Math.hypot(halfLengthM + Math.abs(centreAheadM), halfWidthM),
});

/**
 * The box of a car without a measured outline (the older LC26 engine's, a model without a body plan, another player's
 * car of an unknown model): 5 × 1.95 m, an F1 car's size, centred on the CG
 */
export const DEFAULT_CONTACT_BOX: ContactBox = Object.freeze(boxOf(2.5, 0.975, 0));

/**
 * The box round an outline's points in the car's frame (x left, z forward, from the centre of gravity). Centred
 * across the car (the outlines are mirrored), its length from the frontmost to the rearmost point.
 */
export function contactBoxOfOutline(points: readonly { readonly x: number; readonly z: number }[]): ContactBox {
  if (points.length === 0) return DEFAULT_CONTACT_BOX;
  let halfWidth = 0;
  let front = -Infinity;
  let rear = Infinity;
  for (const p of points) {
    halfWidth = Math.max(halfWidth, Math.abs(p.x));
    front = Math.max(front, p.z);
    rear = Math.min(rear, p.z);
  }
  return boxOf(0.5 * (front - rear), halfWidth, 0.5 * (front + rear));
}
