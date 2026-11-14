/**
 * The one flag shape on the 24 grid, shared by the monochrome `chequered` symbol and the coloured `FlagIcon`: a pole
 * at x = 4 and a cloth with one gentle sine wave. Every edge is built from the same wave, so a pattern (chequers, a
 * diagonal split) follows the cloth exactly without a clip path.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ClothFrame {
  /** Pole and left edge of the cloth */
  x0: number;
  /** Right edge of the cloth */
  x1: number;
  /** Top edge where the wave is level */
  top: number;
  /** Cloth height */
  h: number;
  /** Wave height (up at the first quarter, down at the third) */
  amp: number;
}

export const CLOTH: ClothFrame = { x0: 4, x1: 20, top: 4.5, h: 9.5, amp: 1.1 };

/** The wave's offset at x (one full sine period across the cloth) */
const wave = (f: ClothFrame, x: number) => -f.amp * Math.sin((2 * Math.PI * (x - f.x0)) / (f.x1 - f.x0));
const slope = (f: ClothFrame, x: number) =>
  ((-f.amp * 2 * Math.PI) / (f.x1 - f.x0)) * Math.cos((2 * Math.PI * (x - f.x0)) / (f.x1 - f.x0));

/** A point on the line `t` of the way down the cloth (0 top edge, 1 bottom edge) at x */
const at = (f: ClothFrame, x: number, t: number): [number, number] => [r2(x), r2(f.top + t * f.h + wave(f, x))];

/** Cubic segments along the wave from xa to xb at depth t (Hermite, exact slopes, split at quarter periods) */
function waveCurve(f: ClothFrame, xa: number, xb: number, t: number): string {
  const q = (f.x1 - f.x0) / 4;
  const stops: number[] = [xa];
  const dir = xb > xa ? 1 : -1;
  for (let k = 1; k < 8; k++) {
    const s = f.x0 + k * q;
    if ((s - xa) * dir > 1e-6 && (xb - s) * dir > 1e-6) stops.push(s);
  }
  stops.sort((a, b) => (a - b) * dir);
  stops.push(xb);
  let d = "";
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    const dx = (b - a) / 3;
    const [ax, ay] = at(f, a, t);
    const [bx, by] = at(f, b, t);
    d += `C${r2(ax + dx)} ${r2(ay + slope(f, a) * dx)} ${r2(bx - dx)} ${r2(by - slope(f, b) * dx)} ${bx} ${by}`;
  }
  return d;
}

/** A patch of the cloth between columns xa..xb and depths ta..tb (0 top, 1 bottom) */
export function clothPatch(f: ClothFrame, xa: number, xb: number, ta: number, tb: number): string {
  const [sx, sy] = at(f, xa, ta);
  const [ex, ey] = at(f, xb, tb);
  return `M${sx} ${sy}${waveCurve(f, xa, xb, ta)}L${ex} ${ey}${waveCurve(f, xb, xa, tb)}Z`;
}

/** The whole cloth outline */
export const clothPath = (f: ClothFrame = CLOTH) => clothPatch(f, f.x0, f.x1, 0, 1);

/** The half of the cloth on the pole side of the diagonal that runs from the fly's top corner to the pole's foot */
export function clothDiagonalHoist(f: ClothFrame = CLOTH): string {
  const [sx, sy] = at(f, f.x0, 0);
  const [bx, by] = at(f, f.x0, 1);
  return `M${sx} ${sy}${waveCurve(f, f.x0, f.x1, 0)}L${bx} ${by}Z`;
}

/** A band along that same diagonal, `w` wide (a stripe across the cloth) */
export function clothDiagonalBand(f: ClothFrame = CLOTH, w = 3.2): string {
  const [ax, ay] = at(f, f.x1 - w, 0);
  const [bx, by] = at(f, f.x1, 0);
  const [cx, cy] = at(f, f.x0 + w, 1);
  const [dx, dy] = at(f, f.x0, 1);
  return `M${ax} ${ay}${waveCurve(f, f.x1 - w, f.x1, 0)}L${r2(bx)} ${r2(by + w * 0.9)}L${cx} ${cy}${waveCurve(f, f.x0 + w, f.x0, 1)}L${dx} ${r2(dy - w * 0.9)}Z`;
}

/** Chequer cells (cols x rows), those whose (col + row) is even, as one path */
export function chequerCells(f: ClothFrame = CLOTH, cols = 4, rows = 3): string {
  const w = (f.x1 - f.x0) / cols;
  let d = "";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r + c) % 2) continue;
      d += clothPatch(f, f.x0 + c * w, f.x0 + (c + 1) * w, r / rows, (r + 1) / rows);
    }
  }
  return d;
}

/** The pole, from just above the cloth to the ground */
export const polePath = (f: ClothFrame = CLOTH) => `M${f.x0} 21.5V${r2(f.top - 1)}`;
