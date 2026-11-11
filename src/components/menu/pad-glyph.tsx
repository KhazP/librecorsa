"use client";

import React from "react";
import { FACE_BUTTONS, type PadFamily } from "./input-mode";

export type PadButtonName = "a" | "b" | "x" | "y" | "lb" | "rb" | "menu" | "view" | "dpad";

const FACE_INDEX = { a: 0, b: 1, x: 2, y: 3 } as const;

/** A controller button as printed on the pad (Xbox or PlayStation layout) */
export const PadGlyph: React.FC<{ button: PadButtonName; family?: PadFamily }> = ({ button, family = "xbox" }) => {
  if (button === "a" || button === "b" || button === "x" || button === "y") {
    const face = FACE_BUTTONS[family][FACE_INDEX[button]];
    return (
      <span
        className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-2 bg-[#08090D] font-f1-mono text-[11px] leading-none font-extrabold"
        style={{ borderColor: face.color, color: face.color }}
      >
        {face.label}
      </span>
    );
  }
  if (button === "dpad") {
    return (
      <svg viewBox="0 0 24 24" className="h-[22px] w-[22px] shrink-0" aria-hidden>
        <path
          d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z"
          fill="#08090D"
          stroke="#F5F7FA"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path d="M12 4.5l1.6 2.2h-3.2zM12 19.5l1.6-2.2h-3.2zM4.5 12l2.2-1.6v3.2zM19.5 12l-2.2-1.6v3.2z" fill="#F5F7FA" />
      </svg>
    );
  }
  const ps = family === "playstation";
  const text =
    button === "lb" ? (ps ? "L1" : "LB") : button === "rb" ? (ps ? "R1" : "RB") : button === "menu" ? (ps ? "OPT" : "☰") : ps ? "SHR" : "⧉";
  return (
    <span className="inline-flex h-[22px] min-w-[30px] shrink-0 items-center justify-center rounded-full border-2 border-[#F5F7FA]/80 bg-[#08090D] px-[7px] font-f1-mono text-[10px] leading-none font-extrabold text-[#F5F7FA]">
      {text}
    </span>
  );
};
