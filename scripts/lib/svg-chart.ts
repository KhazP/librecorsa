/**
 * Minimal static SVG line charts for the physics report (docs/physics). No dependency: every chart is a string.
 *
 * Built to the data-viz rules the report follows: one y-axis; 2 px lines with round caps; ≥ 8 px markers with a 2 px
 * surface ring; solid 1 px recessive gridlines; a legend for two or more series plus direct end labels for up to four;
 * text in ink tokens, never in a series colour; bands and spans as ~10 % washes. Colours are the validated reference
 * palette (categorical slots 1-3, a one-hue blue ramp for ordered magnitudes), with their own light and dark steps.
 * The chart paints its own surface, so it reads on GitHub's light and dark themes alike, and follows the viewer's
 * colour scheme where the image is allowed to.
 */

export type SeriesColor = 's1' | 's2' | 's3' | 'r1' | 'r2' | 'r3' | 'r4' | 'muted';

export interface ChartSeries {
  name: string;
  points: readonly (readonly [number, number])[];
  color: SeriesColor;
  /** Draw the line (default true) */
  line?: boolean;
  /** Draw a marker on every point (default: only when there is no line) */
  markers?: boolean;
  /** Mark one point (e.g. the peak) with a ringed dot */
  highlight?: readonly [number, number];
}

export interface ChartBand {
  /** Lower and upper edges sampled at the same x values */
  lower: readonly (readonly [number, number])[];
  upper: readonly (readonly [number, number])[];
  color: SeriesColor;
  label: string;
}

export interface ChartSpan {
  x0: number;
  x1: number;
  label: string;
}

export interface Axis {
  min: number;
  max: number;
  step: number;
  label: string;
  /** Tick text (default: up to 2 decimals, trailing zeros dropped) */
  format?: (v: number) => string;
}

export interface ChartSpec {
  title: string;
  subtitle?: string;
  x: Axis;
  y: Axis;
  series: readonly ChartSeries[];
  bands?: readonly ChartBand[];
  spans?: readonly ChartSpan[];
  width?: number;
  height?: number;
  /** Accessible summary (the chart's <desc>) */
  description: string;
}

const LIGHT: Record<string, string> = {
  surface: '#fcfcfb',
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  s1: '#2a78d6',
  s2: '#eb6834',
  s3: '#1baf7a',
  r1: '#86b6ef',
  r2: '#3987e5',
  r3: '#1c5cab',
  r4: '#0d366b',
  mutedSeries: '#898781',
};

const DARK: Record<string, string> = {
  surface: '#1a1a19',
  ink: '#f0efec',
  ink2: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  s1: '#3987e5',
  s2: '#d95926',
  s3: '#199e70',
  r1: '#1c5cab',
  r2: '#3987e5',
  r3: '#86b6ef',
  r4: '#cde2fb',
  mutedSeries: '#898781',
};

const vars = (t: Record<string, string>) =>
  Object.entries(t)
    .map(([k, v]) => `--${k}:${v};`)
    .join('');

const colorVar = (c: SeriesColor) => (c === 'muted' ? 'var(--mutedSeries)' : `var(--${c})`);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const defaultFormat = (v: number) => String(Number(v.toFixed(2)));

const n = (v: number) => Number(v.toFixed(1));

/** Ticks from min to max inclusive at `step` (float-safe) */
function ticks(a: Axis): number[] {
  const out: number[] = [];
  const count = Math.floor((a.max - a.min) / a.step + 1e-6);
  for (let i = 0; i <= count; i++) out.push(Number((a.min + i * a.step).toFixed(6)));
  return out;
}

/** Text width estimate for 11-12 px system sans (layout only; generous so labels never clip) */
const textWidth = (s: string, px: number) => s.length * px * 0.58;

export function lineChart(spec: ChartSpec): string {
  const W = spec.width ?? 720;
  const H = spec.height ?? 420;
  const multi = spec.series.length >= 2;
  const directLabels = multi && spec.series.length <= 4 && spec.series.every((s) => s.line !== false);
  const longestLabel = directLabels ? Math.max(...spec.series.map((s) => textWidth(s.name, 11))) : 0;

  const top = 24 + (spec.subtitle ? 20 : 0) + (multi ? 30 : 8) + 16;
  const left = 64;
  const right = directLabels ? Math.min(220, 16 + longestLabel) : 24;
  const bottom = 56;
  const pw = W - left - right;
  const ph = H - top - bottom;

  const xs = (x: number) => left + ((x - spec.x.min) / (spec.x.max - spec.x.min)) * pw;
  const ys = (y: number) => top + ph - ((y - spec.y.min) / (spec.y.max - spec.y.min)) * ph;
  const clampY = (y: number) => Math.max(spec.y.min, Math.min(spec.y.max, y));
  const fx = spec.x.format ?? defaultFormat;
  const fy = spec.y.format ?? defaultFormat;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">`,
    `<title id="t">${esc(spec.title)}</title>`,
    `<desc id="d">${esc(spec.description)}</desc>`,
    `<style>`,
    `svg{${vars(LIGHT)}font-family:system-ui,-apple-system,"Segoe UI",sans-serif}`,
    `@media (prefers-color-scheme: dark){svg{${vars(DARK)}}}`,
    `.ttl{fill:var(--ink);font-size:15px;font-weight:600}.sub{fill:var(--ink2);font-size:12px}`,
    `.tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}.axt{fill:var(--ink2);font-size:12px}`,
    `.lbl{fill:var(--ink);font-size:11px}.leg{fill:var(--ink2);font-size:12px}`,
    `.grid{stroke:var(--grid);stroke-width:1}.base{stroke:var(--axis);stroke-width:1}`,
    `</style>`,
    `<rect width="${W}" height="${H}" rx="8" fill="var(--surface)"/>`,
    `<text class="ttl" x="${left}" y="28">${esc(spec.title)}</text>`
  );
  if (spec.subtitle) parts.push(`<text class="sub" x="${left}" y="48">${esc(spec.subtitle)}</text>`);

  // Legend (two or more series): swatch + name, wrapping onto one row
  if (multi) {
    let lx = left;
    const ly = (spec.subtitle ? 48 : 28) + 26;
    for (const s of spec.series) {
      const c = colorVar(s.color);
      if (s.line === false) parts.push(`<circle cx="${lx + 8}" cy="${ly - 4}" r="4" fill="${c}"/>`);
      else parts.push(`<line x1="${lx}" y1="${ly - 4}" x2="${lx + 16}" y2="${ly - 4}" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`);
      parts.push(`<text class="leg" x="${lx + 22}" y="${ly}">${esc(s.name)}</text>`);
      lx += 22 + textWidth(s.name, 12) + 18;
    }
    for (const b of spec.bands ?? []) {
      parts.push(`<rect x="${lx}" y="${ly - 10}" width="16" height="10" rx="2" fill="${colorVar(b.color)}" fill-opacity="0.14"/>`);
      parts.push(`<text class="leg" x="${lx + 22}" y="${ly}">${esc(b.label)}</text>`);
      lx += 22 + textWidth(b.label, 12) + 18;
    }
  }

  // Spans (shaded x ranges, e.g. a tyre's working window)
  for (const sp of spec.spans ?? []) {
    const x0 = xs(Math.max(spec.x.min, sp.x0));
    const x1 = xs(Math.min(spec.x.max, sp.x1));
    parts.push(`<rect x="${n(x0)}" y="${top}" width="${n(x1 - x0)}" height="${ph}" fill="var(--muted)" fill-opacity="0.12"/>`);
    parts.push(`<text class="tick" x="${n(x0 + 4)}" y="${top + 14}">${esc(sp.label)}</text>`);
  }

  // Grid and ticks
  for (const t of ticks(spec.y)) {
    const y = n(ys(t));
    parts.push(`<line class="${t === spec.y.min ? 'base' : 'grid'}" x1="${left}" y1="${y}" x2="${left + pw}" y2="${y}"/>`);
    parts.push(`<text class="tick" x="${left - 8}" y="${n(ys(t) + 4)}" text-anchor="end">${esc(fy(t))}</text>`);
  }
  for (const t of ticks(spec.x)) {
    const x = n(xs(t));
    parts.push(`<line class="base" x1="${x}" y1="${top + ph}" x2="${x}" y2="${top + ph + 4}"/>`);
    parts.push(`<text class="tick" x="${x}" y="${top + ph + 18}" text-anchor="middle">${esc(fx(t))}</text>`);
  }
  parts.push(`<text class="axt" x="${left + pw / 2}" y="${H - 14}" text-anchor="middle">${esc(spec.x.label)}</text>`);
  parts.push(`<text class="axt" transform="translate(16 ${top + ph / 2}) rotate(-90)" text-anchor="middle">${esc(spec.y.label)}</text>`);

  // Bands
  for (const b of spec.bands ?? []) {
    const pts = [...b.upper.map(([x, y]) => [xs(x), ys(clampY(y))]), ...[...b.lower].reverse().map(([x, y]) => [xs(x), ys(clampY(y))])];
    parts.push(`<path d="M${pts.map(([x, y]) => `${n(x)},${n(y)}`).join('L')}Z" fill="${colorVar(b.color)}" fill-opacity="0.14"/>`);
  }

  // Lines, then markers on top
  for (const s of spec.series) {
    if (s.line === false || s.points.length < 2) continue;
    const d = s.points.map(([x, y], i) => `${i ? 'L' : 'M'}${n(xs(x))},${n(ys(clampY(y)))}`).join('');
    parts.push(`<path d="${d}" fill="none" stroke="${colorVar(s.color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  for (const s of spec.series) {
    const showMarkers = s.markers ?? s.line === false;
    const dots = showMarkers ? s.points : s.highlight ? [s.highlight] : [];
    for (const [x, y] of dots) {
      parts.push(`<circle cx="${n(xs(x))}" cy="${n(ys(clampY(y)))}" r="4" fill="${colorVar(s.color)}" stroke="var(--surface)" stroke-width="2"/>`);
    }
  }

  // Direct end labels, nudged apart so they never collide
  if (directLabels) {
    const ends = spec.series
      .map((s) => ({ name: s.name, y: ys(clampY(s.points[s.points.length - 1][1])) }))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
    for (const e of ends) parts.push(`<text class="lbl" x="${left + pw + 8}" y="${n(e.y + 4)}">${esc(e.name)}</text>`);
  }

  parts.push('</svg>');
  return parts.join('\n') + '\n';
}

/** CSV of every series, one row per point: series, x, y */
export function seriesCsv(xName: string, yName: string, series: readonly ChartSeries[]): string {
  const rows = [`series,${xName},${yName}`];
  for (const s of series) for (const [x, y] of s.points) rows.push(`"${s.name.replace(/"/g, '""')}",${x},${Number(y.toFixed(5))}`);
  return rows.join('\n') + '\n';
}
