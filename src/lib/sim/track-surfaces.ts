/**
 * Track surface table: what each kind of ground does to a tyre, as data (after TORCS/Speed Dreams `surfaces.xml`
 * and Assetto Corsa `surfaces.ini`).
 *
 *  - `friction`: tyre grip multiplier in the dry (AC `FRICTION`, TORCS `friction`).
 *  - `wetFriction`: extra multiplier at full wetness, relative to asphalt in the same water (painted kerbs and
 *    grass go far slicker than the tarmac). The tyre's own wet behaviour is the tyre model's business.
 *  - `rollingResistance`: drag per newton of load on top of the tyre's own (TORCS `rolling resistance`):
 *    grass and above all gravel slow a car that is not braking.
 *  - `bumpHeightM` / `bumpLengthM`: a sinusoidal ripple along the surface (AC `SIN_HEIGHT` / `SIN_LENGTH`, TORCS
 *    `roughness` / `roughness wavelength`, but as a true wavelength in metres). Kerb serrations live here, so they
 *    are felt whatever the mesh density.
 *  - `vibration`: rumble gain for force feedback, haptics and audio (AC `VIBRATION_GAIN`).
 *  - `validTrack`: counts as the track for track limits (AC `IS_VALID_TRACK`).
 *
 * A track can override any field per kind in `track_data.json` → `metadata.surfaceTable`.
 */

export type TrackSurfaceKind = 'road' | 'kerb' | 'sausage' | 'runoff' | 'pitlane' | 'grass' | 'gravel';

export interface SurfaceProps {
  friction: number;
  wetFriction: number;
  rollingResistance: number;
  bumpHeightM: number;
  bumpLengthM: number;
  vibration: number;
  validTrack: boolean;
}

export type SurfaceTable = Record<TrackSurfaceKind, SurfaceProps>;
export type SurfaceTableOverrides = Partial<Record<TrackSurfaceKind, Partial<SurfaceProps>>>;

export const DEFAULT_SURFACE_TABLE: Readonly<SurfaceTable> = {
  road: { friction: 1, wetFriction: 1, rollingResistance: 0, bumpHeightM: 0, bumpLengthM: 0, vibration: 0, validTrack: true },
  // Serrated painted concrete: a 4 mm ripple every 0.65 m, slippery when wet
  kerb: { friction: 0.96, wetFriction: 0.72, rollingResistance: 0.002, bumpHeightM: 0.004, bumpLengthM: 0.65, vibration: 1, validTrack: true },
  sausage: { friction: 0.85, wetFriction: 0.7, rollingResistance: 0.01, bumpHeightM: 0, bumpLengthM: 0, vibration: 1, validTrack: false },
  // Painted asphalt run-off
  runoff: { friction: 0.75, wetFriction: 0.85, rollingResistance: 0.002, bumpHeightM: 0, bumpLengthM: 0, vibration: 0.15, validTrack: false },
  pitlane: { friction: 0.97, wetFriction: 0.95, rollingResistance: 0, bumpHeightM: 0, bumpLengthM: 0, vibration: 0, validTrack: true },
  // Soft and uneven, and very slippery once wet
  grass: { friction: 0.6, wetFriction: 0.55, rollingResistance: 0.04, bumpHeightM: 0.01, bumpLengthM: 2.4, vibration: 0.5, validTrack: false },
  // Loose stones: little grip, and the car ploughs in
  gravel: { friction: 0.45, wetFriction: 0.9, rollingResistance: 0.16, bumpHeightM: 0.008, bumpLengthM: 1.1, vibration: 0.8, validTrack: false },
};

export function isTrackSurfaceKind(v: unknown): v is TrackSurfaceKind {
  return typeof v === 'string' && v in DEFAULT_SURFACE_TABLE;
}

/** The default table with a track's overrides applied (unknown kinds and non-matching field types are ignored) */
export function resolveSurfaceTable(overrides?: SurfaceTableOverrides | null): SurfaceTable {
  const out = {} as SurfaceTable;
  for (const kind of Object.keys(DEFAULT_SURFACE_TABLE) as TrackSurfaceKind[]) {
    const base = DEFAULT_SURFACE_TABLE[kind];
    const o = overrides?.[kind];
    const props = { ...base };
    if (o) {
      for (const key of Object.keys(base) as (keyof SurfaceProps)[]) {
        const v = o[key];
        if (typeof v === typeof base[key]) (props as Record<string, unknown>)[key] = v;
      }
    }
    out[kind] = props;
  }
  return out;
}

/**
 * Kerb cross-section: height above the road (m) vs distance outward from the asphalt edge (m). One profile for every
 * circuit: the Rwanda kerbs (scripts/rwanda-2026/build_surfaces.py), the scan kerbs (scripts/tracks/build_track.py
 * KERB_PROFILE_*) and the sample-based contact (track-occupancy.ts). Keep the three in step.
 */
export const KERB_PROFILE_L = [-0.3, 0.05, 0.45, 0.95, 1.35] as const;
export const KERB_PROFILE_Z = [0, 0.018, 0.032, 0.026, 0] as const;

/** Kerb height above the road (m) `outwardM` metres outward from the asphalt edge */
export function kerbProfileM(outwardM: number): number {
  const L = KERB_PROFILE_L;
  const Z = KERB_PROFILE_Z;
  if (outwardM <= L[0] || outwardM >= L[L.length - 1]) return 0;
  let i = 0;
  while (outwardM > L[i + 1]) i++;
  const f = (outwardM - L[i]) / (L[i + 1] - L[i]);
  return Z[i] + (Z[i + 1] - Z[i]) * f;
}

/**
 * Ripple height of a surface (m) at `alongM` metres along it, scaled by `lateralFade` (0 at the edge it starts from,
 * 1 where it is fully raised, as TORCS fades a kerb's roughness in across its width).
 */
export function surfaceRippleM(props: SurfaceProps, alongM: number, lateralFade = 1): number {
  if (props.bumpHeightM <= 0 || props.bumpLengthM <= 0) return 0;
  return props.bumpHeightM * lateralFade * Math.sin((2 * Math.PI * alongM) / props.bumpLengthM);
}
