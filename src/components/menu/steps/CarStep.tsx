"use client";

import React from "react";
import { LIVERIES } from "@/lib/track-data";
import { FACTORY_LIVERY_NOTE, carTakesLivery } from "@/lib/cars/car-registry";
import { CAMERA_MODES, STARTING_CAMERAS } from "@/lib/render/camera-modes";
import { Card } from "@/components/ui";
import { SettingsCard, SettingField } from "@/components/settings/fields";
import { defaultView } from "@/components/settings/defs";
import { CarPicker } from "../CarPicker";
import { LiveryPicker } from "../menu-content-ui";
import { Hint } from "./setup-ui";
import type { SetupStepProps } from "./types";

/** The starting view, as three tiles: the same setting (and label) as Settings > Display > Camera */
const startingView = {
  ...defaultView,
  kind: "tiles" as const,
  options: STARTING_CAMERAS.map((id) => ({ id, label: CAMERA_MODES[id].label, detail: CAMERA_MODES[id].blurb })),
};

/** First-run setup's last step: car, livery and the starting view, with the car on the turntable beside the panel */
export const CarStep: React.FC<SetupStepProps> = (p) => (
  <div className="flex flex-col gap-3">
    <Card title="Car">
      <CarPicker carId={p.carId} onChangeCar={p.onChangeCar} />
    </Card>

    <Card title="Livery">
      {!carTakesLivery(p.carId) ? (
        <Hint>{FACTORY_LIVERY_NOTE}</Hint>
      ) : (
        <LiveryPicker liveries={LIVERIES} value={p.selectedLivery} onChange={p.onChangeLivery} surface="var(--color-lc-carbon)" />
      )}
    </Card>

    <SettingsCard title="Camera">
      <SettingField def={startingView} />
    </SettingsCard>
  </div>
);
