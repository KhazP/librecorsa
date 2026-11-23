"use client";
import { useEffect, type ReactNode } from "react";
import { IntlProvider } from "use-intl/react";
import { parseInterface, SETTINGS_STORAGE_KEY } from "@/lib/settings/player-settings";
import { applyLanguage, getMessageFallback, onError, useI18nState } from "./runtime";

/**
 * The game's messages for every component under it (useTranslations), in the language runtime.ts holds. After the
 * first render it switches to the saved Language setting, or the browser's language for a first visit; the game
 * applies later changes as the player makes them (applyInterfaceSettings).
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const { locale, messages } = useI18nState();
  useEffect(() => {
    let choice = "auto";
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      const json: unknown = raw ? JSON.parse(raw) : null;
      if (json && typeof json === "object") choice = parseInterface((json as { ui?: unknown }).ui).language;
    } catch {
      // Storage unavailable or a corrupt save: follow the browser
    }
    void applyLanguage(choice);
  }, []);
  return (
    <IntlProvider locale={locale} messages={messages} onError={onError} getMessageFallback={getMessageFallback} timeZone="UTC">
      {children}
    </IntlProvider>
  );
}
