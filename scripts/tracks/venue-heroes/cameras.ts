/**
 * Optional per-venue camera & lighting overrides for `npm run venue-heroes`.
 *
 * Any venue not listed here uses the automatic raycast-verified scenic camera picker in `render.ts`. Add an entry
 * whenever a specific corner, landmark (grandstands, harbour, hill climb house, floodlit turn), or sun angle frames a
 * venue better than the automatic pick.
 */
export interface VenueHeroCameraOverride {
  /** Driven distance along the road, as a fraction of road length (0..1); takes precedence over `uM` if both are set */
  uFrac?: number;
  /** Driven distance along the road in metres from the start */
  uM?: number;
  /** Lateral side of the road: +1 = right, -1 = left */
  side: 1 | -1;
  /** Lateral offset from road centreline in metres */
  offsetM: number;
  /** Camera height above the road at `u` in metres */
  heightM: number;
  /** Distance along the road to aim at (+ = forward, - = looking back toward oncoming direction) */
  lookAheadM: number;
  /** Height above the target road point to aim at (default 1.8 m) */
  lookHeightM?: number;
  /** Lateral offset of the look target from centreline in metres (default 0) */
  lookSideM?: number;
  /** Vertical field of view in degrees (default 38) */
  fovDeg?: number;
  /** Sun elevation in degrees (defaults to 14° golden hour, or -8° for night circuits) */
  sunElevationDeg?: number;
  /** Sun azimuth in degrees (defaults to cinematic 3/4 cross-light relative to the camera heading) */
  sunAzimuthDeg?: number;
  /** Cloud cover 0..1 (default 0.30 for golden hour, 0.18 for night) */
  cloud?: number;
  /** Deterministic seed for volumetric cloud shapes */
  cloudSeed?: number;
}

export const VENUE_HERO_CAMERAS: Partial<Record<string, VenueHeroCameraOverride>> = {
  // RISE Motordrome: Start/Finish straight framing the start gantry, main grandstand, colourful runoff & acacia hills
  rwanda_official_short: {
    uFrac: 0.975,
    side: -1,
    offsetM: 6.5,
    heightM: 4.8,
    lookAheadM: 120,
    lookHeightM: 2.8,
    lookSideM: 8,
    fovDeg: 38,
    cloud: 0.30,
  },
  // Monaco: just past the tunnel exit pillar, looking cleanly over the harbour, yachts & Nouvelle Chicane
  monaco: {
    uFrac: 0.625,
    side: 1,
    offsetM: 3.6,
    heightM: 5.4,
    lookAheadM: 95,
    lookHeightM: 2.0,
    fovDeg: 38,
    cloud: 0.26,
  },
  // Red Bull Ring: start/finish straight climbing toward Turn 1 with grandstands & Styrian Alps
  spielberg: {
    uFrac: 0.97,
    side: -1,
    offsetM: 5.5,
    heightM: 5.0,
    lookAheadM: 130,
    lookHeightM: 3.0,
    fovDeg: 38,
    cloud: 0.28,
  },
  // Chang: on the main straight itself, framing the cantilevered Buriram grandstand & blue/white kerbs
  chang: {
    uFrac: 0.992,
    side: -1,
    offsetM: 5.5,
    heightM: 5.2,
    lookAheadM: 130,
    lookHeightM: 4.5,
    lookSideM: 6,
    fovDeg: 38,
    cloud: 0.28,
  },
  // Okayama: pit straight, grandstands & lush Japanese mountain backdrop
  okayama: {
    uFrac: 0.96,
    side: 1,
    offsetM: 5.0,
    heightM: 4.8,
    lookAheadM: 115,
    lookHeightM: 2.5,
    fovDeg: 38,
    cloud: 0.28,
  },
  // Borgloh: mid-course forested hill-climb sweep (clear of the finish parking apron)
  borgloh: {
    uFrac: 0.42,
    side: 1,
    offsetM: 2.8,
    heightM: 3.6,
    lookAheadM: 75,
    lookHeightM: 1.6,
    fovDeg: 38,
    cloud: 0.28,
  },
  // SpeedVegas: start/finish grid angled slightly toward the paddock tents, red/white walls & desert hills
  speedvegas: {
    uFrac: 0.945,
    side: -1,
    offsetM: 3.2,
    heightM: 4.0,
    lookAheadM: 105,
    lookHeightM: 2.6,
    lookSideM: 8,
    fovDeg: 38,
    cloud: 0.26,
  },
  // Riverside: pit straight & classic California raceway gantry/grandstands
  riverside: {
    uFrac: 0.96,
    side: -1,
    offsetM: 5.5,
    heightM: 4.8,
    lookAheadM: 120,
    lookHeightM: 2.5,
    fovDeg: 38,
    cloud: 0.26,
  },
  // Dunsfold: down the runway toward the hangars and tyre walls
  dunsfold: {
    uFrac: 0.015,
    side: -1,
    offsetM: 5.0,
    heightM: 4.2,
    lookAheadM: 110,
    lookHeightM: 2.0,
    fovDeg: 38,
    cloud: 0.30,
  },
  // Bridgehampton: start/finish straight & dunes
  bridgehampton: {
    uFrac: 0.96,
    side: -1,
    offsetM: 4.5,
    heightM: 4.4,
    lookAheadM: 110,
    lookHeightM: 2.0,
    fovDeg: 38,
    cloud: 0.28,
  },
};
