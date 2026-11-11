/**
 * Track surface table: what each kind of ground does to a tyre, as data (after TORCS/Speed Dreams `surfaces.xml`
 * and Assetto Corsa `surfaces.ini`).
 *
 *  - `friction`: tyre grip multiplier in the dry (AC `FRICTION`, TORCS `friction`).
 *  - `wetFriction`: extra multiplier at full wetness, relative to asphalt in the same water (painted kerbs and
 *    grass go far slicker than the tarmac). The tyre's own wet behaviour is the tyre model's business.
 *  - `rollingResistance`: drag per newton of load on top of the tyre's own (TORCS `rolling resistance`):
 *    grass and above all gravel slow a car that is not braking. The tyres plough the loose surface whichever way
 *    they move, so it acts against the contact patch's whole velocity (sliding sideways too), outside the tyre's
 *    friction circle, and builds with speed (see `surfaceDragN`).
 *  - `bumpHeightM` / `bumpLengthM`: a sinusoidal ripple along the surface (AC `SIN_HEIGHT` / `SIN_LENGTH`, TORCS
 *    `roughness` / `roughness wavelength`, but as a true wavelength in metres). Kerb serrations live here, so they
 *    are felt whatever the mesh density.
 *  - `bumpRise`: the ripple's shape. 0 is the sinusoid, `bumpHeightM` either side of the surface. Above 0 it is a row
 *    of blocks standing on the surface, as a kerb is cast: each climbs to `bumpHeightM` over this share of
 *    `bumpLengthM` in the direction of travel, and comes back down over the rest (a tyre rolls off a block's end
 *    over about its contact patch's length, so the drop is given that much, never a step).
 *  - `vibration`: rumble gain for force feedback, haptics and audio (AC `VIBRATION_GAIN`).
 *  - `maxRiseM`: for a raised surface (kerb, sausage), the most it may stand above the drivable surface beneath it;
 *    any higher and the tyre rides at that height instead. Unlimited by default: the authored mesh is the kerb.
 *    For converted meshes whose kerbs are modelled as solid blocks rather than a profile.
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
  bumpRise: number;
  vibration: number;
  validTrack: boolean;
  maxRiseM: number;
}

export type SurfaceTable = Record<TrackSurfaceKind, SurfaceProps>;
export type SurfaceTableOverrides = Partial<Record<TrackSurfaceKind, Partial<SurfaceProps>>>;

export const DEFAULT_SURFACE_TABLE: Readonly<SurfaceTable> = {
  road: { friction: 1, wetFriction: 1, rollingResistance: 0, bumpHeightM: 0, bumpLengthM: 0, bumpRise: 0, vibration: 0, validTrack: true, maxRiseM: Infinity },
  // Serrated painted concrete: a 2 mm ripple every 0.65 m, slippery when wet. The tyres feel the road over their
  // contact patch, but a 0.15-0.25 m patch barely smooths a 0.65 m wave (and at speed it comes far above the wheel-hop
  // frequency, so the tyre spring takes all of it): 4 mm still lifts an F1 wheel off for 13-20 % of its kerb time on
  // Sepang and Suzuka (12-18 % for the GT3), against 6-14 % at 2 mm and 5-13 % with no ripple at all. A circuit whose
  // kerbs are modelled block by block gives them as `bumpRise` blocks instead (RISE Motordrome: 16 mm every 0.8 m)
  kerb: { friction: 0.96, wetFriction: 0.72, rollingResistance: 0.002, bumpHeightM: 0.002, bumpLengthM: 0.65, bumpRise: 0, vibration: 1, validTrack: true, maxRiseM: Infinity },
  sausage: { friction: 0.85, wetFriction: 0.7, rollingResistance: 0.01, bumpHeightM: 0, bumpLengthM: 0, bumpRise: 0, vibration: 1, validTrack: false, maxRiseM: Infinity },
  // Painted asphalt run-off
  runoff: { friction: 0.75, wetFriction: 0.85, rollingResistance: 0.002, bumpHeightM: 0, bumpLengthM: 0, bumpRise: 0, vibration: 0.15, validTrack: false, maxRiseM: Infinity },
  pitlane: { friction: 0.97, wetFriction: 0.95, rollingResistance: 0, bumpHeightM: 0, bumpLengthM: 0, bumpRise: 0, vibration: 0, validTrack: true, maxRiseM: Infinity },
  // Soft and uneven, and very slippery once wet
  grass: { friction: 0.6, wetFriction: 0.55, rollingResistance: 0.04, bumpHeightM: 0.01, bumpLengthM: 2.4, bumpRise: 0, vibration: 0.5, validTrack: false, maxRiseM: Infinity },
  // Loose stones: little grip, and the car ploughs in: about 0.5 g of drag at speed on top of what the tyres give
  gravel: { friction: 0.45, wetFriction: 0.9, rollingResistance: 0.5, bumpHeightM: 0.008, bumpLengthM: 1.1, bumpRise: 0, vibration: 0.8, validTrack: false, maxRiseM: Infinity },
};

/** Contact-patch speed (m/s) at which a surface's plough drag is fully built: a crawling car can still drive out */
export const SURFACE_DRAG_FULL_SPEED_MS = 20;

/**
 * Plough drag of a loose surface on one tyre (N, ≥ 0), to apply against the contact patch's velocity over the
 * ground: `rollingResistance` × load, eased in from a standstill up to `SURFACE_DRAG_FULL_SPEED_MS`.
 */
export function surfaceDragN(rollingResistance: number, fzN: number, patchSpeedMs: number): number {
  if (!(rollingResistance > 0) || !(fzN > 0) || !(patchSpeedMs > 0)) return 0;
  const x = Math.min(1, patchSpeedMs / SURFACE_DRAG_FULL_SPEED_MS);
  return rollingResistance * fzN * x * x * (3 - 2 * x);
}

export function isTrackSurfaceKind(v: unknown): v is TrackSurfaceKind {
  // Own keys only: `in` also accepts prototype names ("constructor", "toString")
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_SURFACE_TABLE, v);
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
 * circuit: RISE Motordrome's kerbs (scripts/rwanda-official/bl_track.py), the scan kerbs (scripts/tracks/build_track.py
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

/** The most of a block's length its climb may take (`bumpRise`): the rest is its way back down */
export const MAX_BUMP_RISE = 0.95;

/**
 * Ripple height of a surface (m) at `alongM` metres along it, scaled by `lateralFade` (0 at the edge it starts from,
 * 1 where it is fully raised, as TORCS fades a kerb's roughness in across its width).
 */
export function surfaceRippleM(props: SurfaceProps, alongM: number, lateralFade = 1): number {
  if (props.bumpHeightM <= 0 || props.bumpLengthM <= 0) return 0;
  if (props.bumpRise > 0) {
    const rise = Math.min(props.bumpRise, MAX_BUMP_RISE);
    const x = alongM / props.bumpLengthM;
    const f = x - Math.floor(x);
    return props.bumpHeightM * lateralFade * (f < rise ? f / rise : (1 - f) / (1 - rise));
  }
  return props.bumpHeightM * lateralFade * Math.sin((2 * Math.PI * alongM) / props.bumpLengthM);
}
