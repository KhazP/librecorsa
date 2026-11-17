"use client";

import { useSyncExternalStore } from "react";
import { keyLayoutSnapshot, subscribeKeyLayout } from "./key-layout";

/**
 * Re-renders when the keyboard layout is read or changes, so keyLabel() names keys as printed on the player's keyboard.
 * The value itself is rarely needed: call it in a component that shows key names.
 */
export const useKeyLayout = () => useSyncExternalStore(subscribeKeyLayout, keyLayoutSnapshot, () => null);
