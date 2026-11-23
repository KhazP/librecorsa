import { useSyncExternalStore } from "react";
import { createTranslator, IntlErrorCode, type IntlError } from "use-intl/core";
import { CATALOGS, formatLocale, PSEUDO_LOCALE, resolveLocale, SOURCE_LOCALE } from "./catalogs";
import en from "./messages/en";
import type { MessageKey, Messages, PartialMessages } from "./types";

/**
 * The language the game shows, held once for the page. React reads it through I18nProvider (useTranslations), and
 * code outside React (a toast the simulation raises, a label a canvas draws) through `t` below.
 *
 * The page always starts in English, as the static export was rendered, and switches once it has run: the saved
 * Language setting (applyInterfaceSettings → applyLanguage), else the browser's languages. `?lang=<code>` overrides
 * both for the visit, which is how the pseudo-language is reached. A language's file loads only when it is picked;
 * a message it lacks shows in English.
 */
export interface I18nState {
  locale: string;
  dir: "ltr" | "rtl";
  messages: Messages;
}

const ENGLISH: I18nState = { locale: SOURCE_LOCALE, dir: "ltr", messages: en };
let state: I18nState = ENGLISH;
let translate = makeTranslator(ENGLISH);
let wanted = "";
const listeners = new Set<() => void>();

function makeTranslator(s: I18nState) {
  return createTranslator({ locale: formatLocale(s.locale), messages: s.messages, onError, getMessageFallback });
}

/** A message that fails to format shows its key in development and its English in production */
export function onError(error: IntlError) {
  if (error.code === IntlErrorCode.MISSING_MESSAGE) return;
  if (process.env.NODE_ENV !== "production") console.warn("[i18n]", error.message);
}

export function getMessageFallback({ namespace, key }: { namespace?: string; key: string }) {
  const path = namespace ? `${namespace}.${key}` : key;
  const english = path.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), en);
  return typeof english === "string" ? english : path;
}

/** English underneath, the translation over it, key by key */
function merge(base: Record<string, unknown>, over: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!over) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = base[k];
    if (typeof v === "string" && typeof b === "string" && v.trim()) out[k] = v;
    else if (v && typeof v === "object" && b && typeof b === "object") out[k] = merge(b as Record<string, unknown>, v as Record<string, unknown>);
  }
  return out;
}

function browserLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? [...navigator.languages] : navigator.language ? [navigator.language] : [];
}

/** `?lang=` for this visit, if the page was opened with one */
function linkLanguage(): string | null {
  if (typeof location === "undefined") return null;
  const lang = new URLSearchParams(location.search).get("lang");
  return lang && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$/.test(lang) ? lang : null;
}

function set(next: I18nState) {
  state = next;
  translate = makeTranslator(next);
  if (typeof document !== "undefined") {
    document.documentElement.lang = next.locale;
    document.documentElement.dir = next.dir;
  }
  for (const l of listeners) l();
}

/**
 * Show the language a saved choice ("auto", or a language code) stands for. Safe to call on every settings change:
 * it does nothing while that language is already shown or loading.
 */
export async function applyLanguage(choice: string): Promise<void> {
  const link = linkLanguage();
  const target = link && (link === PSEUDO_LOCALE || link in CATALOGS || link === SOURCE_LOCALE) ? link : resolveLocale(choice, browserLanguages());
  if (target === wanted || (target === state.locale && !wanted)) return;
  wanted = target;
  if (target === SOURCE_LOCALE) {
    set(ENGLISH);
    return;
  }
  const catalog = CATALOGS[target];
  try {
    let loaded: PartialMessages = (await catalog.load()).default;
    // Right to left, the values filled into a message are isolated so numbers and Latin codes keep their order
    if (catalog.dir === "rtl") loaded = (await import("./isolate")).isolateMessages(loaded);
    if (wanted !== target) return; // another choice came in while this one loaded
    set({ locale: target, dir: catalog.dir ?? "ltr", messages: merge(en, loaded) as Messages });
  } catch (err) {
    console.warn(`[i18n] could not load ${target}; staying in ${state.locale}`, err);
    wanted = state.locale;
  }
}

/** The current language and messages, re-rendering when they change */
export function useI18nState(): I18nState {
  return useSyncExternalStore(subscribe, () => state, () => ENGLISH);
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
const subscribe = subscribeLanguage;

export const currentLocale = () => state.locale;

/**
 * A message by its full key, for code outside React: `t("game.trackLimits.cut")`. Resolve it when the text is shown,
 * not once at start-up, so a change of language reaches it. Components use useTranslations instead.
 */
export function t(key: MessageKey, values?: Record<string, string | number | Date>): string {
  return (translate as unknown as (k: string, v?: Record<string, string | number | Date>) => string)(key, values);
}

/** Upper case as the current language writes it (Turkish i → İ), for text drawn on a canvas or built in code */
export const upper = (text: string) => text.toLocaleUpperCase(state.locale);
