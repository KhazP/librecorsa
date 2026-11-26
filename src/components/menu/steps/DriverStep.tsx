"use client";

import React from "react";
import { useTranslations } from "use-intl/react";
import { CAMERA_MODES, STARTING_CAMERAS } from "@/lib/render/camera-modes";
import { DriverProfileCard } from "@/components/settings/panes/ProfilePane";
import { SettingsCard, SettingField } from "@/components/settings/fields";
import { defaultView } from "@/components/settings/defs";

/**
 * The starting view, as three tiles: the same setting (and label) as Settings > Display > Camera. Built when drawn, so
 * the label and the views' names are in the current language.
 */
const startingView = () => ({
  ...defaultView,
  kind: "tiles" as const,
  options: () => STARTING_CAMERAS.map((id) => ({ id, label: CAMERA_MODES[id].label, detail: CAMERA_MODES[id].blurb })),
});

/** First-run setup's last step: driver name, 3-letter timing code, colour, and starting camera view */
export const DriverStep: React.FC<{ onNameCommitted?: () => void }> = ({ onNameCommitted }) => {
  const tx = useTranslations("setup.car");
  return (
    <div className="flex flex-col gap-3">
      <DriverProfileCard showPreview onCommitted={onNameCommitted} />
      <SettingsCard title={tx("camera")}>
        <SettingField def={startingView()} />
      </SettingsCard>
    </div>
  );
};
