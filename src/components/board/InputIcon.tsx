/*
 * What a lap on a board was driven with, as a small icon beside the driver's name: keyboard, controller, wheel or
 * touch. Its name shows on hover and is read out; a lap stored before the boards kept it shows nothing.
 */
import React from "react";
import { useTranslations } from "use-intl/react";
import { Icon } from "@/components/ui/icons/Icon";
import type { IconName } from "@/components/ui/icons/registry";
import type { LapInput } from "@/lib/sim/lap-types";

const INPUT_ICONS: Record<LapInput, IconName> = {
  keyboard: "keyboard",
  controller: "controller",
  wheel: "wheel",
  touch: "touch",
};

export const InputIcon: React.FC<{ input: LapInput | undefined; className?: string }> = ({ input, className = "" }) => {
  const tx = useTranslations("board.input");
  if (!input) return null;
  const label = tx("drivenWith", { input });
  return (
    <span className={`inline-flex shrink-0 ${className}`} title={label}>
      <Icon name={INPUT_ICONS[input]} size="xs" />
      <span className="sr-only">{label}</span>
    </span>
  );
};
