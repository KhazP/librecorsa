"use client";

import React from "react";
import { useSettingsEnv } from "@/components/settings/env";
import { SettingsCard } from "@/components/settings/fields";
import { assistLevel, autoClutch, autoGearbox, controllerSteerAssist, racingLine, tcAbs } from "@/components/settings/defs";

/** First-run setup's assists step: the assist level and the aids it sets, the same rows as Settings > Driving */
export const AssistsStep: React.FC = () => {
  const { settings } = useSettingsEnv();
  return (
    <div className="flex flex-col gap-3">
      <SettingsCard
        title="Assists"
        first
        rows={[assistLevel, tcAbs, racingLine, autoGearbox, autoClutch, ...(settings.device === "controller" ? [controllerSteerAssist] : [])]}
      />
    </div>
  );
};
