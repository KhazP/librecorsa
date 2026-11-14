/**
 * A design token as a colour string, for drawing that CSS cannot reach: canvas 2D, three.js materials, SVG built in
 * code. `var(--color-lc-*)` is ignored there, so the token is read from the page once and kept per palette; a change
 * of colour-blind palette (html[data-palette]) is picked up on the next call, so call this where you draw, not once
 * at module load.
 *
 *   ctx.strokeStyle = tokenColor("gain");          // follows the palette
 *   ctx.fillStyle = tokenColor("carbon", 0.8);     // with alpha
 *   material.color.set(tokenColor("volt"));
 */
const SEMANTIC = ["gain", "loss", "best", "caution", "info", "cold", "ideal", "hot", "throttle", "brake", "best-ink", "loss-ink"] as const;
const PLAIN = [
  "volt", "volt-hi", "volt-dim", "crimson", "crimson-hi", "cyan", "purple", "purple-hi", "green", "amber", "pink", "azure",
  "tangerine", "lemon", "copper",
  "well", "void", "carbon", "titanium", "line", "keyline", "dim", "slate", "fog", "chalk",
] as const;

export type SemanticColorToken = (typeof SEMANTIC)[number];
export type ColorToken = SemanticColorToken | (typeof PLAIN)[number];

/** What each token is in the standard palette: used before the page exists (server render) and if a read fails */
const FALLBACK: Record<ColorToken, string> = {
  volt: "#ccff00", "volt-hi": "#d9ff33", "volt-dim": "#99bf00", // ui-allow: hex-in-style the fallback table
  crimson: "#ff2a3c", cyan: "#00e5ff", purple: "#b845ff", green: "#00e676", amber: "#ffb300", pink: "#ff6b8a", // ui-allow: hex-in-style the fallback table
  azure: "#4da6ff", tangerine: "#ff8a1f", lemon: "#f2e24a", copper: "#d98162", "crimson-hi": "#fc5d6c", "purple-hi": "#c772fe", // ui-allow: hex-in-style the fallback table
  well: "#050608", void: "#08090d", carbon: "#11131a", titanium: "#1b1f2b", line: "#262b3d", keyline: "#3a4157", // ui-allow: hex-in-style the fallback table
  dim: "#5b6275", slate: "#8e96aa", fog: "#c5cbd8", chalk: "#f5f7fa", // ui-allow: hex-in-style the fallback table
  gain: "#00e676", loss: "#ff2a3c", best: "#b845ff", caution: "#ffb300", info: "#00e5ff", // ui-allow: hex-in-style the fallback table
  cold: "#00e5ff", ideal: "#00e676", hot: "#ff2a3c", throttle: "#00e676", brake: "#ff2a3c", // ui-allow: hex-in-style the fallback table
  "best-ink": "#c772fe", "loss-ink": "#fc5d6c", // ui-allow: hex-in-style the fallback table
};

const isSemantic = (t: ColorToken): t is SemanticColorToken => (SEMANTIC as readonly string[]).includes(t);
/** Per palette, then per token: two lookups and no string built, since the HUD asks many times a frame */
const cache = new Map<string, Map<ColorToken, string>>();

function read(token: ColorToken): string {
  if (typeof document === "undefined") return FALLBACK[token];
  const root = document.documentElement;
  const palette = root.dataset.palette ?? "";
  let tokens = cache.get(palette);
  if (!tokens) cache.set(palette, (tokens = new Map()));
  let hex = tokens.get(token);
  if (!hex) {
    const raw = getComputedStyle(root)
      .getPropertyValue(isSemantic(token) ? `--lc-sem-${token}` : `--color-lc-${token}`)
      .trim();
    hex = /^#[0-9a-f]{6}$/i.test(raw) ? raw : FALLBACK[token];
    tokens.set(token, hex);
  }
  return hex;
}

/** The token as "#rrggbb", or as "rgba(r, g, b, a)" when an alpha is given */
export function tokenColor(token: ColorToken, alpha?: number): string {
  const hex = read(token);
  if (alpha === undefined) return hex;
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
