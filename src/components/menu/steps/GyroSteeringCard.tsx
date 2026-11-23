"use client";

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import { Button, SettingRow } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { lens, SettingsCard, slider, toggle, type RowDef } from "@/components/settings/fields";
import type { SettingsEnv } from "@/components/settings/env";
import { useSettingsEnv } from "@/components/settings/env";
import {
  GYRO_LOCK_MAX_DEG,
  GYRO_LOCK_MIN_DEG,
  GYRO_SENSITIVITY_MAX,
  GYRO_SENSITIVITY_MIN,
  gyroSteerValue,
} from "@/lib/input/gyro-steer";
import { gyroSource } from "@/lib/input/gyro-source";
import { dualSenseHid } from "@/lib/input/webhid-dualsense";
import { dualShock4Hid } from "@/lib/input/webhid-dualshock4";
import type { DualSenseSettings } from "@/lib/settings/player-settings";
import { TrackMeter } from "./setup-ui";

const ds = <K extends keyof DualSenseSettings>(key: K) =>
  lens<DualSenseSettings[K]>(
    (s) => s.dualSense[key],
    (s, value) => ({ ...s, dualSense: { ...s.dualSense, [key]: value } }),
  );

type GyroText = ReturnType<typeof useTranslations<"setup.gyro">>;

/** The rows, for why gyro steering cannot be used right now (null when a pad with a gyro is connected over WebHID) */
function gyroRows(blocked: string | null, tx: GyroText): { on: RowDef; lock: RowDef; sensitivity: RowDef } {
  const needsGyro = (env: SettingsEnv) => blocked ?? (env.settings.dualSense.gyroSteer ? null : tx("needsGyro"));
  return {
    on: toggle({
      id: "dualSenseGyro",
      label: tx("toggle"),
      hint: tx("toggleHint"),
      off: () => blocked,
      ...ds("gyroSteer"),
    }),
    lock: slider({
      id: "dualSenseGyroLock",
      label: tx("lock"),
      hint: tx("lockHint"),
      off: needsGyro,
      min: GYRO_LOCK_MIN_DEG,
      max: GYRO_LOCK_MAX_DEG,
      step: 1,
      format: (v) => `${Math.round(v)}°`,
      ...ds("gyroLockDeg"),
    }),
    sensitivity: slider({
      id: "dualSenseGyroSensitivity",
      label: tx("sensitivity"),
      hint: tx("sensitivityHint"),
      off: needsGyro,
      min: GYRO_SENSITIVITY_MIN,
      max: GYRO_SENSITIVITY_MAX,
      step: 0.05,
      format: (v) =>
        Math.abs(v - 1) < 0.025 ? tx("linear") : v < 1 ? tx("calmer", { value: v.toFixed(2) }) : tx("sharper", { value: v.toFixed(2) }),
      ...ds("gyroSensitivity"),
    }),
  };
}

/**
 * The paired DualSense's gyro steering, live, while `active`: its lean from the centre (deg) and the steering it
 * gives. Keeps the motion tracked while shown, also outside a drive. Null while there is nothing to show. With `padId`,
 * that pad's own lean only, as the car gets it.
 */
export function useGyroLive(active: boolean, lockDeg: number, sensitivity: number, padId?: string): { deg: number; steer: number } | null {
  const [deg, setDeg] = useState<number | null>(null);
  useEffect(() => {
    if (!active) {
      setDeg(null);
      return;
    }
    const release = gyroSource.holdMotion();
    let raf = 0;
    let shown: number | null = null;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = gyroSource.steerDeg(padId);
      // Tenths of a degree: the meter stays still with the pad at rest instead of re-rendering every frame
      const rounded = now === null ? null : Math.round(now * 10) / 10;
      if (rounded !== shown) {
        shown = rounded;
        setDeg(rounded);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      release();
    };
  }, [active, padId]);
  return deg === null ? null : { deg, steer: gyroSteerValue(deg, lockDeg, sensitivity) };
}

/**
 * Gyro steering, for every controller player: a DualSense or DualShock 4 connected over WebHID steers by turning it,
 * alongside the stick. The DualSense connects in its own card (it has more there); the DualShock 4 connects here. The
 * card says plainly what it needs, so a player with another pad learns why it stays off.
 */
export function GyroSteeringCard() {
  const { settings } = useSettingsEnv();
  const tx = useTranslations("setup.gyro");
  const d = settings.dualSense;
  const sense = useSyncExternalStore(dualSenseHid.subscribe, dualSenseHid.getStatus, dualSenseHid.getStatus);
  const shock = useSyncExternalStore(dualShock4Hid.subscribe, dualShock4Hid.getStatus, dualShock4Hid.getStatus);
  // WebHID is read on the client only, so the first render matches the server's
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(dualSenseHid.supported()), []);
  const senseOn = supported && sense.state === "connected";
  const shockOn = supported && shock.state === "connected";
  const connected = senseOn || shockOn;
  const live = useGyroLive(connected && d.gyroSteer, d.gyroLockDeg, d.gyroSensitivity);

  const blocked = !supported
    ? tx("needsChrome")
    : connected
      ? null
      : tx("connectFirst");
  const r = gyroRows(blocked, tx);
  const rows: RowDef[] = [r.on, ...(d.gyroSteer ? [r.lock, r.sensitivity] : [])];
  const padName = senseOn ? (sense.name ?? "DualSense") : "DualShock 4";
  const transport = (senseOn ? sense.transport : shock.transport) === "usb" ? "USB" : "Bluetooth";
  return (
    <SettingsCard
      title={tx("title")}
      description={tx("description")}
      rows={rows}
      before={
        connected ? (
          <span className="flex items-center gap-2 pb-1">
            <Badge tone="good" dot>
              {tx("connected")}
            </Badge>
            <span className="lc-body truncate">{tx("padLine", { name: padName, transport })}</span>
          </span>
        ) : undefined
      }
    >
      {supported && !connected ? (
        <SettingRow label="DualShock 4" hint={shock.message ?? undefined}>
          <Button size="sm" variant="secondary" onClick={() => void dualShock4Hid.connect()}>
            {tx("connectDualShock")}
          </Button>
        </SettingRow>
      ) : null}
      {connected && d.gyroSteer ? (
        <>
          <div className="py-1">
            <TrackMeter
              label={tx("tilt")}
              value={live?.steer ?? 0}
              detail={live ? `${live.deg > 0 ? "+" : ""}${live.deg.toFixed(0)}°` : tx("noMotion")}
              color="var(--color-lc-info)"
              centered
            />
          </div>
          <SettingRow label={tx("recentre")} hint={tx("recentreHint")}>
            <Button size="sm" variant="secondary" onClick={() => gyroSource.recentre()}>
              {tx("recentreButton")}
            </Button>
          </SettingRow>
        </>
      ) : null}
    </SettingsCard>
  );
}
