import { useSyncExternalStore } from "react";
import { carById, carSkin, type CarId, type CarSkin } from "@/lib/cars/car-registry";

/**
 * The livery picked for each car that has its own (`CarDefinition.skins`, the ported mods' skins), kept in the
 * browser like the F1 physics switch: car id -> skin id. A car not in it wears its first skin, the paint its model was
 * made in.
 */
const STORAGE_KEY = "librecorsa.carSkins";

const isId = (v: unknown, max: number): v is string => typeof v === "string" && new RegExp(`^[\\w-]{1,${max}}$`).test(v);

function load(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    const out: Record<string, string> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [car, skin] of Object.entries(raw)) if (isId(car, 40) && isId(skin, 60)) out[car] = skin;
    }
    return out;
  } catch {
    return {};
  }
}

let current: Record<string, string> | null = null;
const listeners = new Set<() => void>();

function all(): Record<string, string> {
  if (current === null) current = typeof window === "undefined" ? {} : load();
  return current;
}

/** The skin a car wears (null for a car without skins of its own) */
export const carSkinFor = (car: CarId): CarSkin | null => carSkin(car, all()[car]);

export function setCarSkin(car: CarId, skinId: string): void {
  if (!carById(car).skins?.some((s) => s.id === skinId) || all()[car] === skinId) return;
  current = { ...all(), [car]: skinId };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Storage unavailable: the choice lasts for this session only
  }
  listeners.forEach((l) => l());
}

export function subscribeCarSkins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The skin id a car wears, for the menus (re-renders when it changes) */
export function useCarSkinId(car: CarId): string | null {
  return useSyncExternalStore(
    subscribeCarSkins,
    () => carSkinFor(car)?.id ?? null,
    () => null
  );
}
