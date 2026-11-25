import type { AcModData } from './ac-data-decrypt';

type Vec3 = [number, number, number];

export interface AcCameraPose {
  pos: Vec3;
  pitchDeg: number;
  fov: number;
  orientation?: { forward: Vec3; up: Vec3 };
}

export type AcCameraLayout = Partial<Record<'cockpit' | 'dash' | 'tcam' | 'bumper', AcCameraPose>>;

function triplet(raw: string | undefined): Vec3 | undefined {
  const parts = raw?.split(',').map((part) => part.trim());
  if (parts?.length !== 3 || parts.some((part) => part === '')) return undefined;
  const values = parts.map(Number);
  return values.every(Number.isFinite) ? [values[0], values[1], values[2]] : undefined;
}

function unit(pos: Vec3 | undefined): Vec3 | undefined {
  if (!pos) return undefined;
  const length = Math.hypot(...pos);
  return length > 0 && Number.isFinite(length) ? [pos[0] / length, pos[1] / length, pos[2] / length] : undefined;
}

/** Read the named player views first. Numbered cameras are alternate onboard/TV shots, not the driver's eye. */
export function mapAcCameras(mod: AcModData): AcCameraLayout | undefined {
  const graphicPosition = (key: string) => triplet(mod.text('car.ini', 'GRAPHICS', key));
  const graphicPitch = (key: string, fallback: number) => mod.num('car.ini', 'GRAPHICS', key, fallback);
  const cameras: AcCameraLayout = {};

  const eye = graphicPosition('DRIVEREYES');
  if (eye) cameras.cockpit = { pos: eye, pitchDeg: graphicPitch('ON_BOARD_PITCH_ANGLE', -4), fov: 55 };
  const dash = triplet(mod.text('dash_cam.ini', 'DASH_CAM', 'POS'));
  if (dash) cameras.dash = { pos: dash, pitchDeg: -8, fov: 58 };
  const bumper = graphicPosition('BUMPER_CAMERA_POS');
  if (bumper) cameras.bumper = { pos: bumper, pitchDeg: graphicPitch('BUMPER_CAMERA_PITCH', -5), fov: 58 };

  // Slot 0 is an alternate roof/airbox shot on many mods. Only reuse it if it
  // is elevated relative to the driver's eyes and looks forward. Slot 5 is
  // not a T-cam convention (it often points back at the car).
  const camera0 = (key: string) => triplet(mod.text('cameras.ini', 'CAMERA_0', key));
  const pos = camera0('POSITION');
  const forward = unit(camera0('FORWARD'));
  if (eye && pos && pos[1] > eye[1] && forward && forward[2] >= 0.7) {
    const up = unit(camera0('UP'));
    const alignment = up ? Math.abs(up[0] * forward[0] + up[1] * forward[1] + up[2] * forward[2]) : 1;
    const fov = mod.num('cameras.ini', 'CAMERA_0', 'FOV', 58);
    cameras.tcam = {
      pos,
      pitchDeg: Math.atan2(forward[1], Math.hypot(forward[0], forward[2])) * (180 / Math.PI),
      fov: fov > 0 && fov < 180 ? fov : 58,
      orientation: { forward, up: up && alignment < 0.999 ? up : [0, 1, 0] },
    };
  }

  return Object.keys(cameras).length > 0 ? cameras : undefined;
}
