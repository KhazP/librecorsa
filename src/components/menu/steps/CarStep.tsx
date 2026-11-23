"use client";

import React, { useState } from "react";
import { useTranslations } from "use-intl/react";
import { LIVERIES } from "@/lib/track-data";
import { FACTORY_LIVERY_NOTE, carById, carTakesLivery, type CarId } from "@/lib/cars/car-registry";
import { CAMERA_MODES, STARTING_CAMERAS } from "@/lib/render/camera-modes";
import { Card } from "@/components/ui";
import { SettingsCard, SettingField } from "@/components/settings/fields";
import { defaultView } from "@/components/settings/defs";
import { CarThumb } from "../CarBrowser";
import { CarPicker } from "../CarPicker";
import { CarSkinPicker, LiveryPicker } from "../menu-content-ui";
import { Hint } from "./setup-ui";
import type { SetupStepProps } from "./types";

/**
 * The starting view, as three tiles: the same setting (and label) as Settings > Display > Camera. Built when drawn, so
 * the label and the views' names are in the current language.
 */
const startingView = () => ({
  ...defaultView,
  kind: "tiles" as const,
  options: () => STARTING_CAMERAS.map((id) => ({ id, label: CAMERA_MODES[id].label, detail: CAMERA_MODES[id].blurb })),
});

/** First-run setup's last step: car, livery and the starting view, with the car on the turntable beside the panel */
export const CarStep: React.FC<SetupStepProps> = (p) => {
  const tx = useTranslations("setup.car");
  const car = carById(p.carId);
  const [hoveredLivery, setHoveredLivery] = useState<{ carId: CarId; id: string } | null>(null);
  const [hoveredSkin, setHoveredSkin] = useState<{ carId: CarId; id: string } | null>(null);
  const previewLiveryId = carTakesLivery(p.carId)
    ? hoveredLivery?.carId === p.carId
      ? hoveredLivery.id
      : p.selectedLivery.id
    : undefined;
  const previewSkinId = car.skins?.length && hoveredSkin?.carId === p.carId ? hoveredSkin.id : undefined;

  return (
    <div className="flex flex-col gap-3">
      <Card title={tx("car")}>
        <CarPicker carId={p.carId} onChangeCar={p.onChangeCar} />
      </Card>

      <Card title={tx("livery")} bodyClassName="gap-3">
        <span className="relative block aspect-video max-h-44 w-full overflow-hidden rounded-lc-tile bg-lc-well [&>img]:size-full">
          <CarThumb car={car} liveryId={previewLiveryId} skinId={previewSkinId} className="p-2" />
        </span>
        {carTakesLivery(p.carId) ? (
          <LiveryPicker
            liveries={LIVERIES}
            value={p.selectedLivery}
            onChange={p.onChangeLivery}
            onHover={(livery) =>
              setHoveredLivery((prev) =>
                livery ? { carId: p.carId, id: livery.id } : prev?.carId === p.carId ? null : prev,
              )
            }
            surface="var(--color-lc-carbon)"
          />
        ) : car.skins?.length ? (
          <CarSkinPicker
            carId={p.carId}
            onHover={(skinId) =>
              setHoveredSkin((prev) =>
                skinId ? { carId: p.carId, id: skinId } : prev?.carId === p.carId ? null : prev,
              )
            }
            surface="var(--color-lc-carbon)"
          />
        ) : (
          <Hint>{FACTORY_LIVERY_NOTE}</Hint>
        )}
      </Card>

      <SettingsCard title={tx("camera")}>
        <SettingField def={startingView()} />
      </SettingsCard>
    </div>
  );
};
