"use client";

import React from "react";
import type { CameraMode } from "@/types/f1";
import { LIVERIES } from "@/lib/track-data";
import { keyLabel } from "@/lib/input/bindings";
import { Choice } from "@/components/hud/PauseMenu";
import { CarPicker } from "../CarPicker";
import { AutoGrid, ChoiceText, SetupCard } from "./setup-ui";
import type { SetupStepProps } from "./types";

const CAMERAS: { id: CameraMode; title: string; sub: string }[] = [
  { id: "cockpit", title: "Cockpit", sub: "Driver's eye" },
  { id: "tv_pod", title: "T-cam", sub: "Over the helmet" },
  { id: "chase", title: "Chase", sub: "Behind the car" },
];

/** Step 4: car, livery and starting camera, with the car on the turntable beside the panel */
export const CarStep: React.FC<SetupStepProps> = (p) => {

  return (
    <div className="flex flex-col gap-3.5">
      <SetupCard label="Car" className="gap-3!">
        <CarPicker carId={p.carId} onChangeCar={p.onChangeCar} />
      </SetupCard>

      <SetupCard label="Livery" className="gap-3!">
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
      </SetupCard>

      <SetupCard label={`Starting camera · ${keyLabel(p.settings.keys.camera[0])} cycles in the car`} className="gap-3!">
        <div className="grid grid-cols-3 gap-2">
          {CAMERAS.map((c) => (
            <Choice key={c.id} active={p.cameraMode === c.id} onClick={() => p.onChangeCameraMode(c.id)}>
              <ChoiceText title={c.title} detail={c.sub} size={15} />
            </Choice>
          ))}
        </div>
      </SetupCard>
    </div>
  );
};
