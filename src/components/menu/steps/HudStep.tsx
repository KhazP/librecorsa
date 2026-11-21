"use client";

import React from "react";
import { useSettingsEnv } from "@/components/settings/env";
import { HudLayoutPicker } from "@/components/settings/HudLayoutPicker";

/**
 * First-run setup's HUD step: every layout as a picture, Broadcast already chosen, so Next keeps it. The same picker as
 * Settings > Display > HUD and the pause menu's HUD tab.
 */
export const HudStep: React.FC = () => {
  const { settings, update } = useSettingsEnv();
  return (
    <div className="flex flex-col gap-3">
      <HudLayoutPicker
        value={settings.hud.preset}
        onChange={(id) => update((s) => ({ ...s, hud: { ...s.hud, preset: id } }))}
        navDefault
      />
    </div>
  );
};
