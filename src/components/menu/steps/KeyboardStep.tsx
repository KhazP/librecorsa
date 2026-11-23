"use client";

import React, { useEffect, useState } from "react";
import { useTranslations } from "use-intl/react";
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
import { useKeyLayout } from "@/lib/input/use-key-layout";
import { Button, Disclosure, IconButton, SettingRow } from "@/components/ui";
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
 * The keys a newcomer drives with, in the table's own order so they pair up in two columns (throttle and brake, steer
 * left and right, boost and aero, gear up and down, camera and restart). First-run setup shows these first.
 */
const ESSENTIAL_KEYS: ReadonlySet<KeyAction> = new Set<KeyAction>([
  "throttle",
  "brake",
  "steerLeft",
  "steerRight",
  "boostHold",
  "aero",
  "shiftUp",
  "shiftDown",
  "camera",
  "restart",
]);

/**
 * The slot columns: every row has the same two fixed-width slots, each a key cap and its unbind button, so the caps
 * line up down the table. A third key (Boost has three by default) wraps under the first slot; a row narrower than two
 * slots (a small phone) stacks them. On touch screens the unbind button grows to 44 px, and the slot with it.
 */
const SLOT_GRID = "flex w-61.5 max-w-full flex-wrap gap-1.5 pointer-coarse:w-65.5";
const SLOT = "flex w-30 shrink-0 items-center gap-1 pointer-coarse:w-32";
/** A key cap: fixed width so every slot starts and ends in the same place; the padding is trimmed so L-SHIFT fits */
const CAP = "w-20 px-2.5!";

/**
 * Key bindings: press a slot, then the new key. Taking a key from another action swaps the two. Reset asks first and
 * is never where the cursor lands. `essentials` (first-run setup) shows the keys a newcomer needs and puts the rest
 * behind a disclosure; Settings shows every key.
 */
export function KeyBindingsCard({ first, essentials }: { first?: boolean; essentials?: boolean }) {
  // Key names as printed on this keyboard (AZERTY's KeyW is "Z"), re-read when the layout is known or changes
  useKeyLayout();
  const tx = useTranslations("setup.keyBindings");
  const { settings, update } = useSettingsEnv();
  const [capture, setCapture] = useState<{ action: KeyAction; slot: number } | null>(null);
  /** A key the game keeps, or one taken from another action (worded when drawn) */
  const [notice, setNotice] = useState<{ code: string; from?: KeyAction } | null>(null);

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
        setNotice({ code: e.code });
        return;
      }
      const owner = KEY_ACTIONS.find((a) => settings.keys[a.id].includes(e.code) && a.id !== capture.action);
      update((s) => ({ ...s, keys: rebindKey(s.keys, capture.action, capture.slot, e.code) }));
      setNotice(owner ? { code: e.code, from: owner.id } : null);
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

  const noticeText = notice
    ? notice.from
      ? tx("moved", { key: keyWord(notice.code), action: KEY_ACTIONS.find((a) => a.id === notice.from)?.label ?? notice.from })
      : tx("reserved", { key: keyWord(notice.code) })
    : null;
  const changed = KEY_ACTIONS.some(({ id }) => settings.keys[id].join() !== DEFAULT_KEY_BINDINGS[id].join());
  // The cursor starts on the table's first key (Throttle), shown in both hosts
  const firstAction = KEY_ACTIONS[0]?.id;

  const row = ({ id, label }: (typeof KEY_ACTIONS)[number]) => {
    const codes = settings.keys[id];
    // One empty slot at most: an action with no key shows a single Add, not two, in the first free column
    const slots = Math.min(Math.max(KEY_SLOTS, codes.length), codes.length + 1);
    return (
      <SettingRow key={id} label={label} className={capture?.action === id ? "bg-lc-volt/6" : undefined}>
        <span className={SLOT_GRID}>
          {Array.from({ length: slots }, (_, slot) => {
            const listening = capture?.action === id && capture.slot === slot;
            // An empty slot binds the next free one, so the slot pressed and the one listening can differ
            const target = Math.min(slot, codes.length);
            const code = codes[slot];
            const press = () => {
              setNotice(null);
              setCapture(listening ? null : { action: id, slot: target });
            };
            const navDefault = first && id === firstAction && slot === 0 ? "" : undefined;
            return (
              <span key={slot} className={SLOT}>
                {listening ? (
                  // Listening takes the whole slot: its unbind button is hidden meanwhile
                  <Button size="sm" variant="primary" className="w-full px-2.5!" aria-label={tx("pressKeyFor", { action: label })} data-nav-default={navDefault} onClick={press}>
                    {tx("pressKey")}
                  </Button>
                ) : code ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      className={CAP}
                      title={keyWord(code)}
                      aria-label={tx("boundAria", { action: label, key: keyWord(code) })}
                      data-nav-default={navDefault}
                      onClick={press}
                    >
                      {keyWord(code)}
                    </Button>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={tx("unbind", { key: keyWord(code), action: label })}
                      icon={<Icon name="close" />}
                      onClick={() => update((s) => ({ ...s, keys: clearKey(s.keys, id, slot) }))}
                    />
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    className={CAP}
                    icon={<Icon name="add" />}
                    aria-label={tx("addFor", { action: label })}
                    data-nav-default={navDefault}
                    onClick={press}
                  >
                    {tx("add")}
                  </Button>
                )}
              </span>
            );
          })}
        </span>
      </SettingRow>
    );
  };

  const TABLE = "grid gap-x-8 gap-y-1 xl:grid-cols-2";
  const shown = essentials ? KEY_ACTIONS.filter((a) => ESSENTIAL_KEYS.has(a.id)) : KEY_ACTIONS;
  const more = essentials ? KEY_ACTIONS.filter((a) => !ESSENTIAL_KEYS.has(a.id)) : [];

  return (
    <SettingsCard
      title={tx("title")}
      description={tx("description")}
      extraReset={{ changed, reset: () => update((s) => ({ ...s, keys: DEFAULT_KEY_BINDINGS })) }}
      resetWhat={tx("resetWhat")}
    >
      <div className={TABLE}>{shown.map(row)}</div>
      {more.length ? (
        // The rest of the table, opened in place above the button (no count: "(20)" would read as the total)
        <Disclosure moreLabel={tx("showAll")} lessLabel={tx("showFewer")}>
          <div className={TABLE}>{more.map(row)}</div>
        </Disclosure>
      ) : null}
      <div className="pt-2">
        <StatusPill tone={capture ? "live" : notice ? "info" : "idle"}>
          {capture
            ? (noticeText ?? tx("capturing", { seconds: CAPTURE_TIMEOUT_S }))
            : (noticeText ?? tx("escPauses"))}
        </StatusPill>
      </div>
    </SettingsCard>
  );
}

type FixedKey = "pause" | "moveView" | "viewHeight" | "mfdDials" | "boostChat" | "switchTabs";

/**
 * Keys the game keeps for itself, listed so they can be found (S137). The view and tab keys are physical positions
 * (KeyboardEvent.code), named as printed on this keyboard; the MFD and chat keys are the characters typed (event.key)
 */
const fixedKeys = (arrows: string): { id: FixedKey; keys: string[] }[] => [
  { id: "pause", keys: ["Esc"] },
  { id: "moveView", keys: ["Alt", arrows] },
  { id: "viewHeight", keys: ["Minus", "Equal", "BracketLeft", "BracketRight"].map(keyLabel) },
  { id: "mfdDials", keys: [",", ".", "-", "="] },
  { id: "boostChat", keys: ["/"] },
  { id: "switchTabs", keys: ["KeyQ", "KeyE"].map(keyLabel) },
];

export function FixedKeysCard() {
  useKeyLayout();
  const tx = useTranslations("setup.fixedKeys");
  return (
    <SettingsCard title={tx("title")} advanced>
      {fixedKeys(tx("arrows")).map((f) => (
        <div key={f.id} className="flex min-h-11 items-center justify-between gap-3">
          <span className="lc-body">{tx(f.id)}</span>
          <span className="flex shrink-0 items-center gap-1">
            {f.keys.map((k, i) => (
              <KeyCap key={i}>{k}</KeyCap>
            ))}
          </span>
        </div>
      ))}
    </SettingsCard>
  );
}

/**
 * Settings > Controls > Keyboard (every key), and the keyboard step of first-run setup (`essentials`: the driving keys
 * first, the rest on request)
 */
export function KeyboardSetup({ essentials }: { essentials?: boolean }) {
  const tx = useTranslations("setup.keyboard");
  return (
    <>
      <KeyBindingsCard first essentials={essentials} />
      <SettingsCard title={tx("mouse")} rows={[mouseSteer]} />
      <SettingsCard title={tx("feel")} rows={keyboardFeel} />
      <FixedKeysCard />
    </>
  );
}

export const KeyboardStep: React.FC = () => (
  <div className="flex flex-col gap-3">
    <KeyboardSetup essentials />
  </div>
);
