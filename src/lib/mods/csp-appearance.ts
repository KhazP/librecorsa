import type { Rgba } from './ac-albedo';
import { isTextureFile } from './texture-files';

const SLOTS = {
  txdiffuse: 'diffuse',
  txdiffuse0: 'diffuse',
  txdetail: 'detail',
  txnormal: 'normal',
  txnormal0: 'normal',
  txnormaldetail: 'normalDetail',
} as const;

export type TextureSlot = (typeof SLOTS)[keyof typeof SLOTS];
export type AlphaMode = 'opaque' | 'test' | 'blend';

export interface ResourceReplacement {
  slot: TextureSlot;
  file?: string;
  color?: Rgba;
}

export interface AppearanceRule {
  matches(material: string, mesh?: string): boolean;
  resources: readonly ResourceReplacement[];
  brightness?: number;
  detailUv?: number;
  detailEnabled?: boolean;
  detailNormalBlend?: number;
  roughness?: number;
  clearcoat?: number;
  alphaMode?: AlphaMode;
  alphaRef?: number;
}

function sections(text: string): { name: string; values: Map<string, string> }[] {
  const out: ReturnType<typeof sections> = [];
  let current: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(?:;|\/\/).*$/, '').trim();
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading) {
      current = new Map();
      out.push({ name: heading[1].trim().toLowerCase(), values: current });
    } else if (line && current) {
      const equals = line.indexOf('=');
      if (equals > 0) current.set(line.slice(0, equals).trim().toLowerCase(), line.slice(equals + 1).trim());
    }
  }
  return out;
}

function literalNumber(value: string | undefined): number | undefined {
  if (!value || !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value)) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const bounded = (n: number, high = 1) => Math.min(high, Math.max(0, n));

function colorBytes(value: string | undefined): Rgba | undefined {
  if (!value) return undefined;
  const parts = value.split(',').map((part) => part.trim());
  if (/^#[\da-f]{6}$/i.test(parts[0]) && parts.length <= 2) {
    const hex = Number.parseInt(parts[0].slice(1), 16);
    const alpha = parts.length === 1 ? 1 : literalNumber(parts[1]);
    return alpha === undefined ? undefined : [hex >> 16, (hex >> 8) & 255, hex & 255, Math.round(bounded(alpha) * 255)];
  }
  if (![1, 3, 4].includes(parts.length)) return undefined;
  const bytes = parts.map((part) => {
    const n = literalNumber(part);
    return n === undefined ? undefined : Math.round(bounded(n) * 255);
  });
  const [r, g, b, a] = bytes;
  if (r === undefined || (parts.length >= 3 && (g === undefined || b === undefined)) || (parts.length === 4 && a === undefined)) {
    return undefined;
  }
  return [r, g ?? r, b ?? r, a ?? 255];
}

function resourceFile(value: string | undefined): string | undefined {
  const name = value?.replace(/^(["'])(.*)\1$/, '$2').trim().replace(/\\/g, '/');
  if (!name || /[:$<>"'{}*?]/.test(name) || name.startsWith('/') || name.split('/').includes('..')) return undefined;
  return isTextureFile(name) ? name : undefined;
}

function selectors(value: string | undefined): string[] {
  return value?.split(',').map((token) => token.trim().toLowerCase()).filter((token) => token && !/[$:{}]/.test(token)) ?? [];
}

function matchesPattern(name: string, pattern: string): boolean {
  if (!/[?*]/.test(pattern)) return name === pattern;
  // CSP treats ? as a wildcard. Match literal runs without interpreting them as regex.
  const parts = pattern.split(/[?*]+/);
  const prefix = parts.shift() ?? '';
  const suffix = parts.pop() ?? '';
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
  const end = name.length - suffix.length;
  let from = prefix.length;
  for (const literal of parts) {
    const at = name.indexOf(literal, from);
    if (at < 0) return false;
    from = at + literal.length;
  }
  return from <= end;
}

function compileRule(name: string, values: ReadonlyMap<string, string>): AppearanceRule | null {
  const active = values.get('active')?.toLowerCase();
  if (active && !['1', 'true', 'yes', 'on'].includes(active)) return null;
  if (values.has('condition') || values.has('skins') || values.has('@active')) return null;

  const paint = /^material_carpaint(?:_|$)/.test(name);
  const carbon = name === 'material_carbon';
  if (!paint && !carbon && !/^shader_replacement(?:_|$)/.test(name)) return null;
  const materialTargets = selectors(values.get('materials') ?? (paint ? values.get('carpaintmaterial') : undefined));
  const meshTargets = selectors(values.get('meshes'));
  if ((!materialTargets.length && !meshTargets.length) ||
      (values.has('materials') && !materialTargets.length) || (values.has('meshes') && !meshTargets.length)) return null;

  const resources: ResourceReplacement[] = [];
  const props = new Map<string, number>();
  for (const [key, value] of values) {
    const resource = key.match(/^resource_(\d+)$/);
    if (resource) {
      const slotName = value.toLowerCase();
      if (!Object.hasOwn(SLOTS, slotName)) continue;
      const file = resourceFile(values.get(`resource_file_${resource[1]}`));
      const color = colorBytes(values.get(`resource_color_${resource[1]}`));
      if (file || color) resources.push({ slot: SLOTS[slotName as keyof typeof SLOTS], file, color });
    } else if (/^prop_\d+(?:_.*)?$/.test(key)) {
      const [prop, raw] = value.split(',').map((part) => part.trim());
      const n = literalNumber(raw);
      if (n !== undefined) props.set(prop.toLowerCase(), n);
    }
  }

  const blend = values.get('blend_mode')?.toUpperCase();
  const brightness = literalNumber(values.get(paint ? 'brightnessadjustment' : 'brightness'));
  const detailUv = props.get('detailuvmultiplier') ?? literalNumber(values.get('detailscale'));
  const detailEnabled = props.get('usedetail');
  const smoothness = literalNumber(values.get('smoothness'));
  const clearcoat = literalNumber(values.get('clearcoatintensity'));
  const detailNormalBlend = props.get('detailnormalblend') ?? literalNumber(values.get('detailnormalblend'));
  const alphaMode = blend === 'ALPHA_TEST' ? 'test' : blend === 'ALPHA_BLEND' ? 'blend' : blend === 'OPAQUE' ? 'opaque' : undefined;
  const alphaRef = props.get('ksalpharef');
  if (!resources.length && brightness === undefined && detailUv === undefined && detailEnabled === undefined &&
      smoothness === undefined && clearcoat === undefined && detailNormalBlend === undefined &&
      alphaMode === undefined && alphaRef === undefined) return null;

  return {
    matches: (material, mesh) =>
      (!materialTargets.length || materialTargets.some((pattern) => matchesPattern(material.toLowerCase(), pattern))) &&
      (!meshTargets.length || (mesh !== undefined && meshTargets.some((pattern) => matchesPattern(mesh.toLowerCase(), pattern)))),
    resources,
    brightness: brightness === undefined ? undefined : bounded(brightness, 4),
    detailUv: detailUv === undefined ? undefined : bounded(detailUv, 4096),
    detailEnabled: detailEnabled === undefined ? undefined : detailEnabled !== 0,
    detailNormalBlend,
    roughness: smoothness === undefined ? undefined : Math.max(0.12, 1 - bounded(smoothness)),
    clearcoat: clearcoat === undefined ? undefined : bounded(clearcoat),
    alphaMode,
    alphaRef,
  };
}

/** Only literal, explicitly targeted appearance settings; never loads includes or executes CSP code. */
export function parseCspAppearance(configs: readonly string[]): AppearanceRule[] {
  const rules: AppearanceRule[] = [];
  for (const config of configs) {
    for (const { name, values } of sections(config)) {
      const rule = compileRule(name, values);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}
