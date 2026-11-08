"use client";

import React from "react";
import { LIVERIES } from "@/lib/track-data";
import { FACTORY_LIVERY_NOTE, carTakesLivery } from "@/lib/cars/car-registry";
import { keyLabel } from "@/lib/input/bindings";
import { CAMERA_MODES, STARTING_CAMERAS } from "@/lib/render/camera-modes";
import { Choice } from "@/components/hud/PauseMenu";
import { CarPicker } from "../CarPicker";
import { AutoGrid, ChoiceText, SetupCard } from "./setup-ui";
import type { SetupStepProps } from "./types";


/** Step 4: car, livery and starting camera, with the car on the turntable beside the panel */
export const CarStep: React.FC<SetupStepProps> = (p) => {

  return (
    <div className="flex flex-col gap-3.5">
      <SetupCard label="Car" className="gap-3!">
        <CarPicker carId={p.carId} onChangeCar={p.onChangeCar} />
      </SetupCard>

      <SetupCard label="Livery" className="gap-3!">
        {!carTakesLivery(p.carId) ? (
          <p className="m-0 text-[13px] opacity-75">{FACTORY_LIVERY_NOTE}</p>
        ) : (
          <AutoGrid min={180} className="gap-2">
            {LIVERIES.map((liv) => (
              <Choice key={liv.id} active={p.selectedLivery.id === liv.id} onClick={() => p.onChangeLivery(liv)}>
                <span className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="h-9 w-9 shrink-0 rounded-xl"
                    style={{ background: `linear-gradient(135deg, ${liv.primary} 0 55%, ${liv.accent} 55% 65%, ${liv.secondary} 65%)` }}
                  />
                  <span className="min-w-0">
                    <span className="lc-title block truncate text-[14px] leading-tight">{liv.name}</span>
                    <span className="block truncate text-[12px] opacity-75">{liv.team}</span>
                  </span>
                </span>
              </Choice>
            ))}
          </AutoGrid>
        )}
      </SetupCard>

      <SetupCard label={`Starting camera · ${keyLabel(p.settings.keys.camera[0])} cycles in the car`} className="gap-3!">
        <div className="grid grid-cols-3 gap-2">
          {STARTING_CAMERAS.map((id) => (
            <Choice key={id} active={p.cameraMode === id} onClick={() => p.onChangeCameraMode(id)}>
              <ChoiceText title={CAMERA_MODES[id].label} detail={CAMERA_MODES[id].blurb} size={15} />
            </Choice>
          ))}
        </div>
      </SetupCard>
    </div>
  );
};
