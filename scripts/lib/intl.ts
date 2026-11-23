/**
 * For suites that render components outside the game: wraps an element in the English messages, as I18nProvider does on
 * a page, so components that call useTranslations render their English text.
 */
import React from "react";
import { IntlProvider } from "use-intl/react";
import en from "../../src/i18n/messages/en";

export const withEnglish = (element: React.ReactElement): React.ReactElement =>
  React.createElement(IntlProvider, { locale: "en", messages: en, timeZone: "UTC", children: element });
