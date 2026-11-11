/**
 * The track surface table (src/lib/sim/track-surfaces.ts): the ripple a surface puts under a tyre, as a sinusoid or as
 * a kerb's blocks, and a circuit's overrides.
 *
 *   npx tsx scripts/verify-track-surfaces.ts
 */
import { DEFAULT_SURFACE_TABLE, MAX_BUMP_RISE, resolveSurfaceTable, surfaceRippleM, type SurfaceProps } from '../src/lib/sim/track-surfaces';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(86)} ${detail}`);
  if (!ok) failures.push(name);
};
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;
const mm = (v: number) => `${(v * 1000).toFixed(2)} mm`;

// ---- The sinusoid, as every circuit without blocks has it
const kerb = DEFAULT_SURFACE_TABLE.kerb;
check('no surface has blocks unless a circuit asks for them', Object.values(DEFAULT_SURFACE_TABLE).every((p) => p.bumpRise === 0));
check('a kerb is a 2 mm sinusoid every 0.65 m, either side of its surface',
  near(surfaceRippleM(kerb, 0), 0) && near(surfaceRippleM(kerb, 0.65 / 4), 0.002) && near(surfaceRippleM(kerb, (3 * 0.65) / 4), -0.002) && near(surfaceRippleM(kerb, 0.65), 0, 1e-12),
  `${mm(surfaceRippleM(kerb, 0.65 / 4))} / ${mm(surfaceRippleM(kerb, (3 * 0.65) / 4))}`);
check('it fades across the kerb', near(surfaceRippleM(kerb, 0.65 / 4, 0.5), 0.001) && surfaceRippleM(kerb, 0.65 / 4, 0) === 0);
check('a surface without a ripple has none', surfaceRippleM(DEFAULT_SURFACE_TABLE.road, 0.3) === 0 && surfaceRippleM({ ...kerb, bumpLengthM: 0 }, 0.3) === 0);

// ---- Blocks: a 0.8 m block 16 mm high, climbed over 0.65 m and come down from over 0.15 m
const blocks: SurfaceProps = { ...kerb, bumpHeightM: 0.016, bumpLengthM: 0.8, bumpRise: 0.8125 };
check('a block starts on the surface, is half up half way up its climb and full height at its crest',
  near(surfaceRippleM(blocks, 0), 0) && near(surfaceRippleM(blocks, 0.325), 0.008) && near(surfaceRippleM(blocks, 0.65), 0.016),
  `${mm(surfaceRippleM(blocks, 0.325))} / ${mm(surfaceRippleM(blocks, 0.65))}`);
check('it comes back down to the next block over the rest of its length, without a step',
  near(surfaceRippleM(blocks, 0.725), 0.008) && near(surfaceRippleM(blocks, 0.8 - 1e-9), 0, 1e-6) && near(surfaceRippleM(blocks, 0.8), 0, 1e-9) &&
    near(surfaceRippleM(blocks, 0.65 - 1e-9), surfaceRippleM(blocks, 0.65 + 1e-9), 1e-6),
  `${mm(surfaceRippleM(blocks, 0.725))}`);
{
  let lo = Infinity;
  let hi = -Infinity;
  let jump = 0;
  let up = 0;
  let last = surfaceRippleM(blocks, -2);
  const n = 40000;
  for (let i = 1; i <= n; i++) {
    const h = surfaceRippleM(blocks, -2 + (4 * i) / n);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
    jump = Math.max(jump, Math.abs(h - last));
    if (h > last) up++;
    last = h;
  }
  check('the blocks stand on the surface, never under it, and repeat every length both ways along',
    lo >= 0 && near(hi, 0.016, 1e-5) && near(surfaceRippleM(blocks, -0.15), 0.016) && near(surfaceRippleM(blocks, 8.325), 0.008),
    `${mm(lo)} to ${mm(hi)}`);
  check('the way down is no steeper than 16 mm in 0.15 m, and the climb takes 81 % of the way',
    jump <= (0.016 / 0.15) * (4 / n) * 1.001 && near(up / n, 0.8125, 0.002), `${((100 * up) / n).toFixed(1)} % climbing`);
}
check('the blocks fade across the kerb as the sinusoid does', near(surfaceRippleM(blocks, 0.65, 0.5), 0.008) && surfaceRippleM(blocks, 0.65, 0) === 0);
check('a climb cannot take the whole block: the way down keeps a twentieth of it',
  MAX_BUMP_RISE === 0.95 && near(surfaceRippleM({ ...blocks, bumpRise: 1 }, 0.76), 0.016) && near(surfaceRippleM({ ...blocks, bumpRise: 1 }, 0.78), 0.008));

// ---- A circuit's overrides
const table = resolveSurfaceTable({ kerb: { bumpHeightM: 0.016, bumpLengthM: 0.8, bumpRise: 0.8125 } });
check("a circuit's blocks replace the kerb's ripple and nothing else",
  table.kerb.bumpRise === 0.8125 && table.kerb.bumpHeightM === 0.016 && table.kerb.bumpLengthM === 0.8 && table.kerb.friction === kerb.friction &&
    table.kerb.wetFriction === kerb.wetFriction && table.kerb.vibration === kerb.vibration && table.gravel.bumpRise === 0 && table.grass.bumpHeightM === 0.01);
check('an override of the wrong kind is ignored',
  resolveSurfaceTable({ kerb: { bumpRise: 'saw' as unknown as number } }).kerb.bumpRise === 0 && resolveSurfaceTable(null).kerb.bumpRise === 0);

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll track surface checks passed.');
process.exit(failures.length ? 1 : 0);
