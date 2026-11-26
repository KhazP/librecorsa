/**
 * F1 2007's engine sounds, one per team: each team's car in Cimmerian Iter's mod has a bank of its own
 * (scripts/audio/car_configs.json "f1-2007" `variants`, ported to public/cars/f1-2007/audio/<team>/). The cockpit
 * recordings are a different engine for every team; the outside recordings are one set for ten of them, the Honda's
 * differing in one, so the other cars (heard from outside only) load the Ferrari's outside loops for those ten.
 */
import type { CarSoundSource } from '../CarAudio';
import { F12007_CONFIG } from './F12007Config';

export type F12007Team =
  | 'ferrari'
  | 'mclaren'
  | 'renault'
  | 'honda'
  | 'bmw-sauber'
  | 'toyota'
  | 'red-bull'
  | 'williams'
  | 'toro-rosso'
  | 'spyker'
  | 'super-aguri';

const DIR = '/cars/f1-2007/audio/';
/** The outside loops ten teams share (the Ferrari's bank holds them) */
const SHARED_OUTSIDE = `${DIR}ferrari/`;

const sound = (team: F12007Team): CarSoundSource => ({
  // The Ferrari's is the car's own sound (`F12007_SOUND`)
  id: team === 'ferrari' ? 'f1-2007' : `f1-2007-${team}`,
  assetDir: `${DIR}${team}/`,
  limiterRpm: F12007_CONFIG.gearbox.gears.redline_rpm,
  ...(team === 'ferrari' || team === 'honda' ? {} : { outsideAssetDir: SHARED_OUTSIDE }),
});

const TEAM_SOUNDS: Record<F12007Team, CarSoundSource> = {
  ferrari: sound('ferrari'),
  mclaren: sound('mclaren'),
  renault: sound('renault'),
  honda: sound('honda'),
  'bmw-sauber': sound('bmw-sauber'),
  toyota: sound('toyota'),
  'red-bull': sound('red-bull'),
  williams: sound('williams'),
  'toro-rosso': sound('toro-rosso'),
  spyker: sound('spyker'),
  'super-aguri': sound('super-aguri'),
};

/** A team's engine sound (the same object every time: the player and the other cars compare them) */
export const f12007Sound = (team: F12007Team): CarSoundSource => TEAM_SOUNDS[team];
