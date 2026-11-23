import type { NestedKeyOf } from "use-intl";
import type en from "./messages/en";

/** Every message, shaped as the English catalogue (src/i18n/messages/en) */
export type Messages = typeof en;

/** A full dotted message key, such as "menu.title.drive" (for text resolved outside React, src/i18n/runtime.ts) */
export type MessageKey = NestedKeyOf<Messages>;

/** A translation: any part of the English shape, the rest falling back to English key by key */
export type PartialMessages = { [K in keyof Messages]?: DeepPartial<Messages[K]> };
type DeepPartial<T> = T extends string ? string : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

declare module "use-intl" {
  interface AppConfig {
    Messages: Messages;
  }
}
