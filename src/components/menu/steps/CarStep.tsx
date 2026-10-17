"use client";

import React from "react";
import type { CameraMode } from "@/types/f1";
import { LIVERIES } from "@/lib/track-data";
import { keyLabel } from "@/lib/input/bindings";
import { Choice, VEHICLE_CHOICES } from "@/components/hud/PauseMenu";
import { useMenuNav } from "../useMenuNav";
import { Card, SectionLabel } from "../menu-ui";
import type { SetupStepProps } from "./types";

const CARS = VEHICLE_CHOICES;

const CAMERAS: { id: CameraMode; title: string; sub: string }[] = [
  { id: "cockpit", title: "Cockpit", sub: "Driver's eye" },
  { id: "tv_pod", title: "T-cam", sub: "Over the helmet" },
  { id: "chase", title: "Chase", sub: "Behind the car" },
];

/** Step 4: car, livery and starting camera, with the car on the turntable beside the panel */
export const CarStep: React.FC<SetupStepProps> = (p) => {
  const liveryIdx = Math.max(0, LIVERIES.findIndex((l) => l.id === p.selectedLivery.id));
  const carIdx = CARS.findIndex((c) => c.id === p.vehicleModel);
  useMenuNav({
    keyboardSelect: false,
    onLeft: () => p.onChangeLivery(LIVERIES[(liveryIdx + LIVERIES.length - 1) % LIVERIES.length]),
    onRight: () => p.onChangeLivery(LIVERIES[(liveryIdx + 1) % LIVERIES.length]),
    onUp: () => p.onChangeVehicle(CARS[(carIdx + CARS.length - 1) % CARS.length].id),
    onDown: () => p.onChangeVehicle(CARS[(carIdx + 1) % CARS.length].id),
  });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <SectionLabel>Car</SectionLabel>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {CARS.map((car) => (
            <Choice key={car.id} active={p.vehicleModel === car.id} onClick={() => p.onChangeVehicle(car.id)}>
              <div className="font-f1-italic text-sm uppercase">{car.title}</div>
              <div className="font-f1-mono text-[11px] opacity-75">{car.sub}</div>
            </Choice>
          ))}
        </div>
      </Card>

      <Card>
        <SectionLabel>Livery</SectionLabel>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {LIVERIES.map((liv) => (
            <Choice key={liv.id} active={p.selectedLivery.id === liv.id} onClick={() => p.onChangeLivery(liv)}>
              <span className="flex items-center gap-3">
                <span
                  className="h-8 w-8 shrink-0 rounded-sm"
                  style={{ background: `linear-gradient(135deg, ${liv.primary} 0 55%, ${liv.accent} 55% 65%, ${liv.secondary} 65%)` }}
                />
                <span className="min-w-0">
                  <span className="block truncate font-f1-italic text-sm uppercase">{liv.name}</span>
                  <span className="block truncate font-f1-mono text-[11px] opacity-75">{liv.team}</span>
                </span>
              </span>
            </Choice>
          ))}
        </div>
      </Card>

      <Card>
        <SectionLabel>Starting camera · {keyLabel(p.settings.keys.camera[0])} cycles in the car</SectionLabel>
        <div className="grid grid-cols-3 gap-2">
          {CAMERAS.map((c) => (
            <Choice key={c.id} active={p.cameraMode === c.id} onClick={() => p.onChangeCameraMode(c.id)}>
              <div className="font-f1-italic text-sm uppercase">{c.title}</div>
              <div className="font-f1-mono text-[11px] opacity-75">{c.sub}</div>
            </Choice>
          ))}
        </div>
      </Card>
    </div>
  );
};
