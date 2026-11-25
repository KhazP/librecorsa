/**
 * IndexedDB storage for imported user car mods.
 * Database: `librecorsa-custom-mods`
 * Store: `cars` (keyed by custom car ID)
 */

import type { CarPhysicsConfig } from '@/lib/sim/f12026-car/F12026CarConfig';
import type { CarClassId } from '@/lib/cars/car-registry';

export interface CustomCarSkin {
  name: string;
  swatch?: [string, string];
  swatchSource?: 'authored';
  textures: Record<string, Blob>;
  appearanceConfig?: string;
}

export interface CustomCarRecord {
  id: string; // e.g. "custom_" + slug
  slug?: string;
  title: string;
  subTitle?: string;
  author?: string;
  year?: number;
  classId?: CarClassId;
  physicsConfig: CarPhysicsConfig;
  glbBlob?: Blob;
  kn5Blob?: Blob;
  skins?: CustomCarSkin[];
  /** The car's ext_config files in order, followed at render time by the chosen skin's config. */
  appearanceConfig?: string[];
  thumbBlob?: Blob;
  badgeBlob?: Blob;
  previewBlob?: Blob;
  importedAt: number;
}

const DB_NAME = 'librecorsa-custom-mods';
const DB_VERSION = 1;
const STORE_NAME = 'cars';

let dbInstance: IDBDatabase | null = null;
const memoryFallbackStore = new Map<string, CustomCarRecord>();

function isIndexedDbAvailable(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

/**
 * Opens or retrieves the singleton IndexedDB connection.
 */
export function openModDb(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new Error('IndexedDB is not supported or not running in a browser environment'));
  }

  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
      };
      resolve(dbInstance);
    };

    request.onerror = () => {
      reject(request.error || new Error('Failed to open IndexedDB'));
    };
  });
}

/**
 * Saves or updates a custom car record in IndexedDB (or in-memory fallback).
 */
export async function saveCustomCar(car: CustomCarRecord): Promise<void> {
  if (!isIndexedDbAvailable()) {
    memoryFallbackStore.set(car.id, car);
    return;
  }
  const db = await openModDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(car);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error(`Failed to save custom car ${car.id}`));
  });
}

/**
 * Retrieves a custom car record by ID.
 */
export async function getCustomCar(id: string): Promise<CustomCarRecord | undefined> {
  if (!isIndexedDbAvailable()) {
    return memoryFallbackStore.get(id);
  }
  const db = await openModDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);

    req.onsuccess = () => resolve(req.result as CustomCarRecord | undefined);
    req.onerror = () => reject(req.error || new Error(`Failed to get custom car ${id}`));
  });
}

/**
 * Checks whether a custom car ID already exists.
 */
export async function hasCustomCar(id: string): Promise<boolean> {
  if (!isIndexedDbAvailable()) {
    return memoryFallbackStore.has(id);
  }
  const car = await getCustomCar(id);
  return Boolean(car);
}

/**
 * Retrieves all stored custom car records.
 */
export async function getAllCustomCars(): Promise<CustomCarRecord[]> {
  if (!isIndexedDbAvailable()) {
    return Array.from(memoryFallbackStore.values());
  }
  const db = await openModDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();

    req.onsuccess = () => resolve((req.result as CustomCarRecord[]) || []);
    req.onerror = () => reject(req.error || new Error('Failed to list custom cars'));
  });
}

/**
 * Deletes a custom car record by ID.
 */
export async function deleteCustomCar(id: string): Promise<void> {
  if (!isIndexedDbAvailable()) {
    memoryFallbackStore.delete(id);
    return;
  }
  const db = await openModDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error(`Failed to delete custom car ${id}`));
  });
}

/**
 * Clears all custom cars from storage.
 */
export async function clearAllCustomCars(): Promise<void> {
  if (!isIndexedDbAvailable()) {
    memoryFallbackStore.clear();
    return;
  }
  const db = await openModDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();

    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error || new Error('Failed to clear custom cars store'));
  });
}
