"use client";

import React from "react";
import { useInputMode } from "@/components/menu/input-mode";
import { ArrowKeys, KeyCap, KeysFromString } from "./KeyCap";
import { PadGlyph, type PadButtonName, type PadGlyphFamily } from "./PadGlyph";

export type PromptAction = "move" | "select" | "back" | "tabs" | "start" | "adjust";

/** One prompt: what it does (a verb: "Select", "Back", "Change", "Next tab") and, if not the action's own, its inputs */
export interface Prompt {
  action: PromptAction;
  label: string;
  /** Keys shown for the keyboard, as text ("Space", "Q / E", "← →"); arrows are drawn */
  key?: string;
  /** Controller button shown instead of the action's own */
  pad?: PadButtonName;
}

/** The input to show prompts for; absent, the bar follows the input the player used last */
export type PromptInput = "keyboard" | PadGlyphFamily;

const PAD_FOR: Record<PromptAction, PadButtonName[]> = {
  move: ["dpad"],
  select: ["a"],
  back: ["b"],
  tabs: ["lb", "rb"],
  start: ["menu"],
  adjust: ["dpad-horizontal"],
};

const KeysFor: React.FC<{ action: PromptAction }> = ({ action }) => {
  switch (action) {
    case "move":
      return <ArrowKeys set="all" />;
    case "adjust":
      return <ArrowKeys set="horizontal" />;
    case "tabs":
      return (
        <span className="inline-flex items-center gap-1">
          <KeyCap>Q</KeyCap>
          <KeyCap>E</KeyCap>
        </span>
      );
    case "back":
      return <KeyCap>Esc</KeyCap>;
    default:
      return <KeyCap>Enter</KeyCap>;
  }
};

/**
 * Button prompts along the bottom of a screen (UI standard §7): each a glyph or key cap and a 13 px label, 22 px apart,
 * on a hairline. Controller glyphs while a pad is in use, keys otherwise; on touch the bar hides until a pad is used.
 */
export const PromptBar: React.FC<{
  prompts: readonly Prompt[];
  /** Show one input's prompts whatever was used last (the kit, help screens) */
  input?: PromptInput;
  /** Draw the hairline above the bar (default) */
  rule?: boolean;
  className?: string;
}> = ({ prompts, input, rule = true, className = "" }) => {
  const live = useInputMode();
  const pad: PadGlyphFamily | null = input ? (input === "keyboard" ? null : input) : live.mode === "pad" ? live.family : null;
  const hideOnTouch = !input && !pad ? "pointer-coarse:hidden!" : "";
  return (
    <div
      className={`flex flex-wrap items-center gap-x-5.5 gap-y-2 ${rule ? "border-t border-lc-line pt-3" : ""} ${hideOnTouch} ${className}`}
    >
      {prompts.map((p) => (
        <span key={p.action + p.label} className="inline-flex items-center gap-2 text-[13px] font-semibold text-lc-fog">
          {pad ? (
            <span className="inline-flex items-center gap-1">
              {(p.pad ? [p.pad] : PAD_FOR[p.action]).map((b) => (
                <PadGlyph key={b} button={b} family={pad} />
              ))}
            </span>
          ) : p.key ? (
            <KeysFromString keys={p.key} />
          ) : (
            <KeysFor action={p.action} />
          )}
          {p.label}
        </span>
      ))}
    </div>
  );
};
