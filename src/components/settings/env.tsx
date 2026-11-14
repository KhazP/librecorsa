"use client";

import React, { createContext, useContext } from "react";
import type { PlayerSettings } from "@/lib/settings/player-settings";
import type { CarId } from "@/lib/cars/car-registry";
import type { VehicleModelId } from "@/types/f1";

/**
 * What every settings row reads and changes, shared by the Settings screen and first-run setup: the saved settings,
 * the one writer, and the few things that live outside the settings object (rumble, the car on track, VR, the seat).
 */
export interface SettingsEnv {
  settings: PlayerSettings;
  update: (fn: (prev: PlayerSettings) => PlayerSettings) => void;
  /** Controller vibration, saved on its own key */
  rumble: boolean;
  onToggleRumble: () => void;
  /** The current car's steering lock (road-wheel degrees), for the countersteer sliders */
  steerLockDeg?: number;
  carId: CarId;
  vehicleModel: VehicleModelId;
  /** A car's name from its vehicle model id (the per-car force feedback list) */
  vehicleLabel?: (vehicle: string) => string;
  /** The car's own driver's-eye field of view (degrees) */
  carFovDeg?: number;
  vrSupported?: boolean;
  vrActive?: boolean;
  onEnterVr?: () => void;
  /** Claims a new name on the online board: null once it has taken, else why not */
  onRenameDriver?: (name: string) => Promise<string | null>;
  /** Closes the menus onto the seat panel (only while driving) */
  onOpenSeatPanel?: () => void;
  /** Opens first-run setup again */
  onRunSetup?: () => void;
  /** The driver key: save it to a file, load it from one, and what the last try said */
  driverKey?: { onExport: () => void; onImport: (file: File) => void; notice: string | null };
}

const EnvContext = createContext<SettingsEnv | null>(null);

export const SettingsEnvProvider: React.FC<{ value: SettingsEnv; children: React.ReactNode }> = ({ value, children }) => (
  <EnvContext.Provider value={value}>{children}</EnvContext.Provider>
);

export function useSettingsEnv(): SettingsEnv {
  const env = useContext(EnvContext);
  if (!env) throw new Error("A settings row needs a SettingsEnvProvider above it");
  return env;
}
