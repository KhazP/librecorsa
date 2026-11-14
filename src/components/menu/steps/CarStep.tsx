"use client";

import React from "react";
import { LIVERIES } from "@/lib/track-data";
import { FACTORY_LIVERY_NOTE, carTakesLivery } from "@/lib/cars/car-registry";
import { CAMERA_MODES, STARTING_CAMERAS } from "@/lib/render/camera-modes";
import { Card, OptionTile, OptionTileGroup } from "@/components/ui";
import { SettingsCard, SettingField } from "@/components/settings/fields";
import { defaultView } from "@/components/settings/defs";
import { CarPicker } from "../CarPicker";
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
        <OptionTileGroup aria-label="Livery" columns={3}>
          {LIVERIES.map((liv) => (
            <OptionTile
              key={liv.id}
              checked={p.selectedLivery.id === liv.id}
              onSelect={() => p.onChangeLivery(liv)}
              title={liv.name}
              description={liv.team}
              media={
                <span
                  aria-hidden
                  className="block h-8 w-full"
                  // ui-allow: hex-in-style the livery's own colours are data
                  style={{ background: `linear-gradient(135deg, ${liv.primary} 0 55%, ${liv.accent} 55% 65%, ${liv.secondary} 65%)` }}
                />
              }
            />
          ))}
        </OptionTileGroup>
      )}
    </Card>

    <SettingsCard title="Camera">
      <SettingField def={startingView} />
    </SettingsCard>
  </div>
);
