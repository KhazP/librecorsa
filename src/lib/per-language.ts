import { textLocale } from "@/lib/text";

/**
 * A value built from messages once per language, for code that runs every frame: `build` runs again only after the
 * language changes, so a game loop reads its words without formatting them each frame.
 */
export function perLanguage<T>(build: () => T): () => T {
  let locale: string | null = null;
  let value: T;
  return () => {
    const now = textLocale();
    if (now !== locale) {
      value = build();
      locale = now;
    }
    return value;
  };
}
