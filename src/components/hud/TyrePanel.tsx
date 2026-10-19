"use client";

import React from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { HUD_GLASS } from "./hud-format";
import { TyreBrakeGrid } from "./TyreBrakeWidget";

/** Bottom-left LibreCorsa 4-corner tyre and brake matrix: O/M/I tread bands, PSI vs optimum, wear, brakes and damage */
export const TyrePanel: React.FC<{ telemetry: CarTelemetry; compound: TireCompound }> = ({ telemetry, compound }) => (
  <section aria-label="Tyres" className={`w-[288px] rounded-[22px] p-3 ${HUD_GLASS}`}>
    <TyreBrakeGrid t={telemetry} compound={compound} />
  </section>
);
