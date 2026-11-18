/**
 * Where gyro steering comes from: the DualSense (its own driver, which also runs its triggers and lights) or the
 * DualShock 4, both over WebHID. One place for the frame loop, the device reader and the settings screens to ask.
 */
import { isDualSensePadId } from "./dualsense-protocol";
import { isDualShock4PadId } from "./dualshock4-protocol";
import { dualSenseHid } from "./webhid-dualsense";
import { dualShock4Hid } from "./webhid-dualshock4";

/** A Gamepad API id of a pad whose gyro the game can read */
export function isGyroPadId(id: string): boolean {
  return isDualSensePadId(id) || isDualShock4PadId(id);
}

export const gyroSource = {
  /** Gyro steering on or off, from the settings (the frame loop sets it every frame) */
  setMotionWanted(on: boolean): void {
    dualSenseHid.setMotionWanted(on);
    dualShock4Hid.setMotionWanted(on);
  },
  /** Keeps the motion tracked while a settings screen shows it; call the returned function to let go */
  holdMotion(): () => void {
    const a = dualSenseHid.holdMotion();
    const b = dualShock4Hid.holdMotion();
    return () => {
      a();
      b();
    };
  },
  /**
   * The lean from its centre (deg, + = right) of the pad with the Gamepad API id `padId`, from the driver of its kind;
   * without an id, of whichever pad streams. Null with none streaming its motion
   */
  steerDeg(padId?: string): number | null {
    if (padId === undefined) return dualSenseHid.gyroSteerDeg() ?? dualShock4Hid.gyroSteerDeg();
    if (isDualSensePadId(padId)) return dualSenseHid.gyroSteerDeg();
    return isDualShock4PadId(padId) ? dualShock4Hid.gyroSteerDeg() : null;
  },
  /** The lean as it is now becomes straight ahead */
  recentre(): void {
    dualSenseHid.recentreGyro();
    dualShock4Hid.recentreGyro();
  },
  /** A pad with a gyro is connected over WebHID */
  connected(): boolean {
    return dualSenseHid.connected() || dualShock4Hid.connected();
  },
};
