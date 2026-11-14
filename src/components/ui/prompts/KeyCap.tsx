import React from "react";
import { Icon } from "../icons/Icon";
import type { IconName } from "../icons/registry";

export type ArrowKey = "up" | "down" | "left" | "right";

const ARROW_ICON: Record<ArrowKey, IconName> = { up: "keyUp", down: "keyDown", left: "keyLeft", right: "keyRight" };
const ARROW_NAME: Record<ArrowKey, string> = { up: "Up", down: "Down", left: "Left", right: "Right" };

const CAP =
  "lc-chip-text inline-flex h-5.5 min-w-5.5 shrink-0 items-center justify-center rounded-full border px-1.5 text-[11px] leading-none";
const TONE = {
  default: "border-lc-keyline bg-lc-void text-lc-chalk",
  /** Inside a volt button */
  ink: "border-lc-void bg-lc-void text-lc-volt",
} as const;

/**
 * A keyboard key (UI standard §7): a 22 px pill, the key's name in 11 px chip text. Arrow keys are drawn, never typed
 * as characters. One cap per key.
 */
export const KeyCap: React.FC<{
  /** The key's name ("Esc", "Enter", "Q") */
  children?: React.ReactNode;
  /** An arrow key instead of a name */
  arrow?: ArrowKey;
  tone?: keyof typeof TONE;
  className?: string;
}> = ({ children, arrow, tone = "default", className = "" }) => (
  <kbd className={`${CAP} ${TONE[tone]} ${arrow ? "px-0" : ""} ${className}`}>
    {arrow ? (
      <>
        <Icon name={ARROW_ICON[arrow]} size="xs" className="size-3!" />
        <span className="sr-only">{ARROW_NAME[arrow]}</span>
      </>
    ) : (
      children
    )}
  </kbd>
);

/** A set of arrow keys, one cap each */
export const ArrowKeys: React.FC<{ set: "all" | "horizontal" | "vertical"; tone?: keyof typeof TONE }> = ({
  set,
  tone,
}) => {
  const keys: ArrowKey[] = set === "horizontal" ? ["left", "right"] : set === "vertical" ? ["up", "down"] : ["up", "down", "left", "right"];
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <KeyCap key={k} arrow={k} tone={tone} />
      ))}
    </span>
  );
};

/** A wheel button, shown by number */
export const WheelButton: React.FC<{ button: number; tone?: keyof typeof TONE }> = ({ button, tone }) => (
  <KeyCap tone={tone}>Btn {button}</KeyCap>
);

const ARROW_CHAR: Record<string, ArrowKey> = { "\u2191": "up", "\u2193": "down", "\u2190": "left", "\u2192": "right" };

/**
 * Turns a key string as older call sites write it ("Esc", "Q / E", "← →", "W S · ↑ ↓") into caps, one per
 * key, with the arrow characters drawn
 */
export const KeysFromString: React.FC<{ keys: string; tone?: keyof typeof TONE }> = ({ keys, tone }) => {
  const caps: React.ReactNode[] = [];
  // A separator on its own is the key itself ("/" opens the search)
  const tokens = /^\s*[/\u00b7+]\s*$/.test(keys) ? [keys.trim()] : keys.split(/[\s/\u00b7+]+/).filter(Boolean);
  for (const token of tokens) {
    if ([...token].every((ch) => ch in ARROW_CHAR)) {
      for (const ch of token) caps.push(<KeyCap key={caps.length} arrow={ARROW_CHAR[ch]} tone={tone} />);
    } else {
      caps.push(
        <KeyCap key={caps.length} tone={tone}>
          {token}
        </KeyCap>,
      );
    }
  }
  return <span className="inline-flex items-center gap-1">{caps}</span>;
};
