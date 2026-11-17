/**
 * The player's keyboard layout, for naming keys. Bindings are stored as KeyboardEvent.code, a physical position named
 * after the US layout, so on AZERTY `KeyW` is the key printed Z and `KeyQ` the one printed A. Chromium and Electron say
 * what each position prints (navigator.keyboard.getLayoutMap); elsewhere the US names stay.
 *
 * No React here: bindings.ts (and the verify scripts that load it) read it plainly. useKeyLayout re-renders on load.
 */

type LayoutMap = ReadonlyMap<string, string>;
type KeyboardApi = { getLayoutMap?: () => Promise<LayoutMap> };

let layout: LayoutMap | null = null;
let loading = false;
const listeners = new Set<() => void>();

/** What a code's key prints on this keyboard ("z" for KeyW on AZERTY), or undefined when not known */
export function printedKey(code: string): string | undefined {
  return layout?.get(code);
}

/** The layout map once read (null before, and in browsers without the API); its identity changes when it is re-read */
export const keyLayoutSnapshot = (): LayoutMap | null => layout;

/** Reads the layout (again): once on first use, and when the window regains focus, since the input source may have changed */
export function loadKeyLayout(): void {
  if (loading || typeof navigator === "undefined") return;
  const api = (navigator as Navigator & { keyboard?: KeyboardApi }).keyboard;
  if (!api?.getLayoutMap) return;
  loading = true;
  api.getLayoutMap().then(
    (map) => {
      loading = false;
      const same = layout !== null && layout.size === map.size && [...map].every(([k, v]) => layout?.get(k) === v);
      if (same) return;
      layout = map;
      for (const l of listeners) l();
    },
    () => {
      // Refused (a cross-origin frame, an old engine): the US names stay
      loading = false;
    },
  );
}

/** For useSyncExternalStore: starts the first read and re-reads on focus */
export function subscribeKeyLayout(onChange: () => void): () => void {
  listeners.add(onChange);
  loadKeyLayout();
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("focus", loadKeyLayout);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("focus", loadKeyLayout);
  };
}
