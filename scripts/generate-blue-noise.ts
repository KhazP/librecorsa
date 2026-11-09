/**
 * Writes `public/sky/blue-noise-128.bin`: a 128 x 128 tileable blue-noise tile (one byte per texel, row-major),
 * made with Ulichney's void-and-cluster method. The volumetric clouds jitter their ray marching with it
 * (`src/lib/render/physical-sky.ts` stacks 64 golden-ratio-shifted copies into the spatiotemporal noise volume
 * they expect). Generated here so the game ships no third-party noise texture.
 *
 *   npx tsx scripts/generate-blue-noise.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const SIZE = 128;
const N = SIZE * SIZE;
const SIGMA = 1.5;
const RADIUS = Math.ceil(3 * SIGMA);
/** Share of texels set in the initial binary pattern */
const INITIAL_DENSITY = 0.1;

/** Seeded so the shipped tile is reproducible */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KERNEL_W = 2 * RADIUS + 1;
const kernel = new Float64Array(KERNEL_W * KERNEL_W);
for (let dy = -RADIUS; dy <= RADIUS; dy++) {
  for (let dx = -RADIUS; dx <= RADIUS; dx++) {
    kernel[(dy + RADIUS) * KERNEL_W + dx + RADIUS] = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA));
  }
}

/** Gaussian energy of the set texels, kept up to date as texels toggle (toroidal, so the tile repeats seamlessly) */
class Field {
  readonly bits = new Uint8Array(N);
  readonly energy = new Float64Array(N);
  count = 0;

  toggle(i: number, on: boolean): void {
    if ((this.bits[i] === 1) === on) return;
    this.bits[i] = on ? 1 : 0;
    this.count += on ? 1 : -1;
    const sign = on ? 1 : -1;
    const x0 = i % SIZE;
    const y0 = (i / SIZE) | 0;
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
      const y = (y0 + dy + SIZE) % SIZE;
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        const x = (x0 + dx + SIZE) % SIZE;
        this.energy[y * SIZE + x] += sign * kernel[(dy + RADIUS) * KERNEL_W + dx + RADIUS];
      }
    }
  }

  /** The set texel with the most energy around it */
  tightestCluster(): number {
    let best = -1;
    let bestE = -Infinity;
    for (let i = 0; i < N; i++) {
      if (this.bits[i] === 1 && this.energy[i] > bestE) {
        bestE = this.energy[i];
        best = i;
      }
    }
    return best;
  }

  /** The empty texel with the least energy around it */
  largestVoid(): number {
    let best = -1;
    let bestE = Infinity;
    for (let i = 0; i < N; i++) {
      if (this.bits[i] === 0 && this.energy[i] < bestE) {
        bestE = this.energy[i];
        best = i;
      }
    }
    return best;
  }

  clone(): Field {
    const f = new Field();
    f.bits.set(this.bits);
    f.energy.set(this.energy);
    f.count = this.count;
    return f;
  }
}

function voidAndCluster(seed: number): Uint8Array {
  const random = mulberry32(seed);

  // Initial binary pattern: random points, then relaxed by moving the tightest cluster into the largest void
  const initial = new Field();
  const target = Math.round(N * INITIAL_DENSITY);
  while (initial.count < target) initial.toggle(Math.floor(random() * N), true);
  for (;;) {
    const cluster = initial.tightestCluster();
    initial.toggle(cluster, false);
    const hole = initial.largestVoid();
    if (hole === cluster) {
      initial.toggle(cluster, true);
      break;
    }
    initial.toggle(hole, true);
  }

  const rank = new Int32Array(N).fill(-1);

  // Phase 1: rank the initial points, removing the tightest cluster first
  const p1 = initial.clone();
  for (let r = initial.count - 1; r >= 0; r--) {
    const i = p1.tightestCluster();
    p1.toggle(i, false);
    rank[i] = r;
  }

  // Phase 2: fill the largest voids up to half the tile
  const p2 = initial.clone();
  for (let r = initial.count; r < N / 2; r++) {
    const i = p2.largestVoid();
    p2.toggle(i, true);
    rank[i] = r;
  }

  // Phase 3: the remaining texels are the minority now; rank them by the tightest cluster of empty texels
  const p3 = new Field();
  for (let i = 0; i < N; i++) if (p2.bits[i] === 0) p3.toggle(i, true);
  for (let r = N / 2; r < N; r++) {
    const i = p3.tightestCluster();
    p3.toggle(i, false);
    rank[i] = r;
  }

  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[i] = Math.floor((rank[i] * 256) / N);
  return out;
}

const tile = voidAndCluster(0x5ca1ab1e);
const outPath = path.join(__dirname, '..', 'public', 'sky', 'blue-noise-128.bin');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, tile);

// A blue-noise tile has a flat histogram and almost no low-frequency energy: check both
const histogram = new Uint32Array(256);
for (const v of tile) histogram[v]++;
const flat = histogram.every((c) => c === N / 256);
let lowFreq = 0;
for (let y = 0; y < SIZE; y += 8) {
  for (let x = 0; x < SIZE; x += 8) {
    let sum = 0;
    for (let j = 0; j < 8; j++) for (let k = 0; k < 8; k++) sum += tile[(y + j) * SIZE + x + k];
    lowFreq = Math.max(lowFreq, Math.abs(sum / 64 - 127.5));
  }
}
console.log(`wrote ${path.relative(process.cwd(), outPath)} (${tile.length} bytes); flat histogram: ${flat}; worst 8x8 block mean offset: ${lowFreq.toFixed(1)}`);
