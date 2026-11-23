"use client";

import React from "react";
import { useTranslations } from "use-intl/react";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/Button";
import { Icon } from "@/components/ui/icons";
import { supportLabel, type SupportLink } from "@/lib/modder-support";
import { useStoreBuild } from "@/lib/use-store-build";

/**
 * A modder's support link as a button: "Donate via PayPal", "Support on Patreon". Never in the Android app, which
 * leaves payment links out for Google Play's rules (store-mode.ts), as it does the game's own coffee link.
 */
export function SupportButton({
  support,
  maker,
  variant = "primary",
  size = "sm",
  className,
  onOpen,
  named,
}: {
  support: SupportLink | undefined;
  /** Whose page it opens, for the button's name ("Donate to Mitja Bonca via PayPal") */
  maker: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  /** Pressed (the note after a drive stops asking for this maker) */
  onOpen?: () => void;
  /** Says whose: "Donate to Mitja Bonca", "Support gregsediting" (where several buttons stand together) */
  named?: boolean;
}) {
  const store = useStoreBuild();
  const t = useTranslations("game.support");
  if (!support || store) return null;
  const payPal = support.via === "PayPal";
  return (
    <Button
      href={support.url}
      native
      target="_blank"
      rel="noopener noreferrer"
      variant={variant}
      size={size}
      icon={<Icon name="support" />}
      aria-label={payPal ? t("donateToVia", { maker, site: support.via }) : t("supportOnSite", { maker, site: support.via })}
      onPointerEnter={focusOnHover}
      onClick={onOpen}
      className={className}
    >
      {named ? (payPal ? t("donateTo", { maker }) : t("supportMaker", { maker })) : supportLabel(support)}
    </Button>
  );
}
