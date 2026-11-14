"use client";

import React, { useEffect, useState } from "react";
import {
  clearKey,
  DEFAULT_KEY_BINDINGS,
  KEY_ACTIONS,
  KEY_SLOTS,
  keyLabel,
  rebindKey,
  RESERVED_CODES,
  type KeyAction,
} from "@/lib/input/bindings";
import { Button, IconButton, SettingRow } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import { KeyCap } from "@/components/ui/prompts";
import { useSettingsEnv } from "@/components/settings/env";
import { SettingsCard } from "@/components/settings/fields";
import { keyboardFeel, mouseSteer } from "@/components/settings/defs";
import { suspendMenuNav } from "../useMenuNav";
import { CAPTURE_TIMEOUT_S } from "./button-capture";
import { StatusPill } from "./setup-ui";

const ARROW_WORDS: Record<string, string> = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };

/** A key's name as words (arrows by name, not by glyph) */
export const keyWord = (code: string | undefined) => (code && ARROW_WORDS[code]) || keyLabel(code);

/**
 * Key bindings: press a slot, then the new key. Taking a key from another action swaps the two. Reset asks first and
 * is never where the cursor lands.
 */
export function KeyBindingsCard({ first }: { first?: boolean }) {
  const { settings, update } = useSettingsEnv();
  const [capture, setCapture] = useState<{ action: KeyAction; slot: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!capture) return;
    const resume = suspendMenuNav();
    const onKey = (e: KeyboardEvent) => {
      // Capture phase + stopImmediatePropagation: the menu and the simulator never see this key
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.code === "Escape") {
        setNotice(null);
        setCapture(null);
        return;
      }
      if (RESERVED_CODES.has(e.code)) {
        // Still listening: the line says so until another key is pressed
        setNotice(`${keyWord(e.code)} is kept for the game. Press another key`);
        return;
      }
      const owner = KEY_ACTIONS.find((a) => settings.keys[a.id].includes(e.code) && a.id !== capture.action);
      update((s) => ({ ...s, keys: rebindKey(s.keys, capture.action, capture.slot, e.code) }));
      setNotice(owner ? `${keyWord(e.code)} moved from ${owner.label}` : null);
      setCapture(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    // Gives up like the controller and wheel captures, so a controller that opened it is never stuck here
    const timeout = window.setTimeout(() => {
      setNotice(null);
      setCapture(null);
    }, CAPTURE_TIMEOUT_S * 1000);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", onKey, { capture: true });
      // Let the key-up of the captured key pass before menus listen again
      window.setTimeout(resume, 0);
    };
  }, [capture, settings.keys, update]);

  const changed = KEY_ACTIONS.some(({ id }) => settings.keys[id].join() !== DEFAULT_KEY_BINDINGS[id].join());

  return (
    <SettingsCard
      title="Key bindings"
      description="Press a key's slot, then the new key. A key taken from another action swaps with it"
      extraReset={{ changed, reset: () => update((s) => ({ ...s, keys: DEFAULT_KEY_BINDINGS })) }}
      resetWhat="every key binding"
    >
      <div className="grid gap-x-8 gap-y-1 xl:grid-cols-2">
      {KEY_ACTIONS.map(({ id, label }, row) => {
        const codes = settings.keys[id];
        const slots = Math.max(KEY_SLOTS, codes.length);
        return (
          <SettingRow key={id} label={label} className={capture?.action === id ? "bg-lc-volt/6" : undefined}>
            <span className="flex flex-wrap items-center justify-end gap-1.5">
              {Array.from({ length: slots }, (_, slot) => {
                const listening = capture?.action === id && capture.slot === slot;
                // An empty slot binds the next free one, so the slot pressed and the one listening can differ
                const target = Math.min(slot, codes.length);
                const code = codes[slot];
                return (
                  <span key={slot} className="inline-flex items-center">
                    <Button
                      size="sm"
                      variant={listening ? "primary" : "secondary"}
                      className="min-w-20"
                      icon={code || listening ? undefined : <Icon name="add" />}
                      aria-label={listening ? `Press a key for ${label}` : code ? `${label}: ${keyWord(code)}. Change` : `Add a key for ${label}`}
                      data-nav-default={first && row === 0 && slot === 0 ? "" : undefined}
                      onClick={() => {
                        setNotice(null);
                        setCapture(listening ? null : { action: id, slot: target });
                      }}
                    >
                      {listening ? "Press a key" : code ? keyWord(code) : "Add"}
                    </Button>
                    {code && !listening ? (
                      <IconButton
                        size="sm"
                        variant="ghost"
                        aria-label={`Unbind ${keyWord(code)} from ${label}`}
                        icon={<Icon name="close" />}
                        onClick={() => update((s) => ({ ...s, keys: clearKey(s.keys, id, slot) }))}
                      />
                    ) : null}
                  </span>
                );
              })}
            </span>
          </SettingRow>
        );
      })}
      </div>
      <div className="pt-2">
        <StatusPill tone={capture ? "live" : notice ? "info" : "idle"}>
          {capture ? (notice ?? `Press a key. Esc cancels; it stops after ${CAPTURE_TIMEOUT_S} s`) : (notice ?? "Esc always opens the pause menu.")}
        </StatusPill>
      </div>
    </SettingsCard>
  );
}

/** Keys the game keeps for itself, listed so they can be found (S137) */
const FIXED_KEYS: { label: string; keys: string[] }[] = [
  { label: "Pause menu", keys: ["Esc"] },
  { label: "Move the view (cockpit, dash)", keys: ["Alt", "Arrows"] },
  { label: "View height and field of view", keys: ["-", "=", "[", "]"] },
  { label: "MFD dials", keys: [",", ".", "-", "="] },
  { label: "Chat command for boost", keys: ["/"] },
  { label: "Switch tabs in menus", keys: ["Q", "E"] },
];

export function FixedKeysCard() {
  return (
    <SettingsCard title="Fixed keys" description="These keys cannot be changed" advanced>
      {FIXED_KEYS.map((f) => (
        <div key={f.label} className="flex min-h-11 items-center justify-between gap-3">
          <span className="lc-body">{f.label}</span>
          <span className="flex shrink-0 items-center gap-1">
            {f.keys.map((k) => (
              <KeyCap key={k}>{k}</KeyCap>
            ))}
          </span>
        </div>
      ))}
    </SettingsCard>
  );
}

/** Settings > Controls > Keyboard, and the keyboard step of first-run setup */
export function KeyboardSetup() {
  return (
    <>
      <KeyBindingsCard first />
      <SettingsCard title="Mouse" rows={[mouseSteer]} />
      <SettingsCard title="Keyboard feel" rows={keyboardFeel} />
      <FixedKeysCard />
    </>
  );
}

export const KeyboardStep: React.FC = () => (
  <div className="flex flex-col gap-3">
    <KeyboardSetup />
  </div>
);
