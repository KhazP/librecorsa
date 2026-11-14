import React from "react";
import type { PadFamily } from "@/components/menu/input-mode";
import { Icon } from "../icons/Icon";
import type { IconName } from "../icons/registry";

/** Pad families drawn: the two the game detects, plus a generic pad (any other standard-mapping controller) */
export type PadGlyphFamily = PadFamily | "generic";

export type PadDirection = "up" | "down" | "left" | "right" | "horizontal" | "vertical";

/**
 * Every button a prompt can show. The first nine are the names older call sites pass; the rest extend them.
 * `dpad-*`, `ls-*` and `rs-*` fill in the direction.
 */
export type PadButtonName =
  | "a"
  | "b"
  | "x"
  | "y"
  | "lb"
  | "rb"
  | "menu"
  | "view"
  | "dpad"
  | "lt"
  | "rt"
  | "ls"
  | "rs"
  | "l3"
  | "r3"
  | "touchpad"
  | `dpad-${PadDirection}`
  | `ls-${PadDirection}`
  | `rs-${PadDirection}`;

/* One cap for every glyph: void, keyline hairline, chalk ink, 22 px high (the same as KeyCap) */
const ROUND = "relative inline-flex size-5.5 shrink-0 items-center justify-center rounded-full border border-lc-keyline bg-lc-void text-lc-chalk";
const PILL =
  "lc-chip-text inline-flex h-5.5 min-w-7.5 shrink-0 items-center justify-center gap-0.5 rounded-full border border-lc-keyline bg-lc-void px-1.5 text-[11px] leading-none text-lc-chalk";

type Face = "a" | "b" | "x" | "y";
const XBOX_FACE: Record<Face, string> = { a: "A", b: "B", x: "X", y: "Y" };
const PS_FACE_NAME: Record<Face, string> = { a: "Cross", b: "Circle", x: "Square", y: "Triangle" };
const GENERIC_FACE_NAME: Record<Face, string> = { a: "Bottom", b: "Right", x: "Left", y: "Top" };

/** PlayStation face shapes as plain strokes on the 22 px cap */
const PS_SHAPE: Record<Face, React.ReactNode> = {
  a: <path d="M7.75 7.75l6.5 6.5M14.25 7.75l-6.5 6.5" />,
  b: <circle cx={11} cy={11} r={4.25} />,
  x: <rect x={7.25} y={7.25} width={7.5} height={7.5} rx={0.75} />,
  y: <path d="M11 6.75l4.5 7.75h-9Z" />,
};

/** Generic pad: the four face positions as a diamond of dots, the pressed one filled */
const DIAMOND: Record<Face, [number, number]> = { y: [11, 6.25], b: [15.75, 11], a: [11, 15.75], x: [6.25, 11] };

const Svg22: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <svg
    viewBox="0 0 22 22"
    width={22}
    height={22}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    // Its own size, with `!`: a button or tab sizes every icon inside it, and that must not shrink the glyph off-centre
    className={`absolute -inset-px size-5.5! ${className}`}
  >
    {children}
  </svg>
);

/* D-pad: a cross outline with the pressed arm(s) filled */
const CROSS = "M8.5 3.75h5v4.75h4.75v5H13.5v4.75h-5V13.5H3.75v-5H8.5Z";
const ARM: Record<"up" | "down" | "left" | "right", string> = {
  up: "M8.5 3.75h5V9h-5Z",
  down: "M8.5 13h5v5.25h-5Z",
  left: "M3.75 8.5H9v5H3.75Z",
  right: "M13 8.5h5.25v5H13Z",
};
const ARMS: Record<PadDirection, ("up" | "down" | "left" | "right")[]> = {
  up: ["up"],
  down: ["down"],
  left: ["left"],
  right: ["right"],
  horizontal: ["left", "right"],
  vertical: ["up", "down"],
};
const DIR_WORD: Record<PadDirection, string> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  horizontal: "left and right",
  vertical: "up and down",
};
const DIR_ICONS: Record<PadDirection, IconName[]> = {
  up: ["keyUp"],
  down: ["keyDown"],
  left: ["keyLeft"],
  right: ["keyRight"],
  horizontal: ["moveHorizontal"],
  vertical: ["moveVertical"],
};

const SHOULDER: Record<"lb" | "rb" | "lt" | "rt", { xbox: string; playstation: string; name: string }> = {
  lb: { xbox: "LB", playstation: "L1", name: "Left bumper" },
  rb: { xbox: "RB", playstation: "R1", name: "Right bumper" },
  lt: { xbox: "LT", playstation: "L2", name: "Left trigger" },
  rt: { xbox: "RT", playstation: "R2", name: "Right trigger" },
};

/** System buttons by family, one spelling each */
const SYSTEM: Record<"menu" | "view", Record<PadGlyphFamily, string>> = {
  menu: { xbox: "Menu", playstation: "Options", generic: "Start" },
  view: { xbox: "View", playstation: "Create", generic: "Select" },
};

/** A stick: the cap with the stick's ring and its letter */
const Stick: React.FC<{ text: string; label: string; className: string }> = ({ text, label, className }) => (
  <span role="img" aria-label={label} className={`${ROUND} ${className}`}>
    <span aria-hidden className="absolute inset-0.5 rounded-full border border-lc-chalk/45" />
    <span aria-hidden className="lc-chip-text relative text-[11px] leading-none tracking-normal">
      {text}
    </span>
  </span>
);

/**
 * A controller button as a prompt (UI standard §7): monochrome chalk on a void cap with a keyline hairline, 22 px high
 * like `KeyCap`, so a prompt bar reads as one row whatever the input. Xbox letters, PlayStation shapes, or a generic
 * pad's positions; no maker's logo and no brand colours.
 */
export const PadGlyph: React.FC<{ button: PadButtonName; family?: PadGlyphFamily; className?: string }> = ({
  button,
  family = "xbox",
  className = "",
}) => {
  if (button === "a" || button === "b" || button === "x" || button === "y") {
    if (family === "xbox") {
      return (
        <span role="img" aria-label={`${XBOX_FACE[button]} button`} className={`${ROUND} ${className}`}>
          <span aria-hidden className="lc-chip-text text-[11px] leading-none tracking-normal">
            {XBOX_FACE[button]}
          </span>
        </span>
      );
    }
    if (family === "playstation") {
      return (
        <span role="img" aria-label={`${PS_FACE_NAME[button]} button`} className={`${ROUND} ${className}`}>
          <Svg22>{PS_SHAPE[button]}</Svg22>
        </span>
      );
    }
    return (
      <span role="img" aria-label={`${GENERIC_FACE_NAME[button]} face button`} className={`${ROUND} ${className}`}>
        <Svg22>
          {(Object.keys(DIAMOND) as Face[]).map((f) => (
            <circle
              key={f}
              cx={DIAMOND[f][0]}
              cy={DIAMOND[f][1]}
              r={f === button ? 2.4 : 1.9}
              strokeWidth={f === button ? 0 : 1.25}
              fill={f === button ? "currentColor" : "none"}
            />
          ))}
        </Svg22>
      </span>
    );
  }

  if (button === "dpad" || button.startsWith("dpad-")) {
    const dir = button === "dpad" ? null : (button.slice(5) as PadDirection);
    return (
      <span role="img" aria-label={dir ? `D-pad ${DIR_WORD[dir]}` : "D-pad"} className={`${ROUND} ${className}`}>
        <Svg22 className="[stroke-width:1.25]">
          {dir ? ARMS[dir].map((a) => <path key={a} d={ARM[a]} fill="currentColor" stroke="none" />) : null}
          <path d={CROSS} />
        </Svg22>
      </span>
    );
  }

  if (button === "lb" || button === "rb" || button === "lt" || button === "rt") {
    const s = SHOULDER[button];
    const text = family === "playstation" ? s.playstation : s.xbox;
    return (
      <span role="img" aria-label={`${s.name} (${text})`} className={`${PILL} ${className}`}>
        <span aria-hidden>{text}</span>
      </span>
    );
  }

  if (button === "menu" || button === "view") {
    const text = SYSTEM[button][family];
    return (
      <span role="img" aria-label={`${text} button`} className={`${PILL} ${className}`}>
        <span aria-hidden>{text}</span>
      </span>
    );
  }

  if (button === "touchpad") {
    return (
      <span role="img" aria-label="Touchpad" className={`${PILL} w-9 ${className}`}>
        <svg viewBox="0 0 16 10" width={16} height={10} fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden className="h-2.5! w-4!">
          <rect x={1} y={1} width={14} height={8} rx={2} />
        </svg>
      </span>
    );
  }

  // Sticks: the stick on its own, its click, or a direction on it
  const side = button.startsWith("l") ? "L" : "R";
  const sideWord = side === "L" ? "Left" : "Right";
  if (button === "l3" || button === "r3") {
    // The click: a pressed stick (ring with its centre filled) and the button's printed name
    const text = family === "xbox" ? `${side}S` : `${side}3`;
    return (
      <span role="img" aria-label={`${sideWord} stick press (${text})`} className={`${PILL} gap-1 pl-1 ${className}`}>
        <svg viewBox="0 0 14 14" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.25} aria-hidden className="size-3.5!">
          <circle cx={7} cy={7} r={5.75} strokeOpacity={0.55} />
          <circle cx={7} cy={7} r={2.75} fill="currentColor" stroke="none" />
        </svg>
        <span aria-hidden>{text}</span>
      </span>
    );
  }
  if (button === "ls" || button === "rs") return <Stick text={side} label={`${sideWord} stick`} className={className} />;
  const dir = button.slice(3) as PadDirection;
  return (
    <span
      role="img"
      aria-label={`${sideWord} stick ${DIR_WORD[dir]}`}
      className={`inline-flex h-5.5 shrink-0 items-center gap-0.5 rounded-full border border-lc-keyline bg-lc-void pr-1.5 text-lc-chalk ${className}`}
    >
      <span aria-hidden className="relative -my-px -ml-px inline-flex size-5.5 items-center justify-center">
        <span className="absolute inset-0.5 rounded-full border border-lc-chalk/45" />
        <span className="lc-chip-text relative text-[11px] leading-none tracking-normal">{side}</span>
      </span>
      {DIR_ICONS[dir].map((n) => (
        <Icon key={n} name={n} size="xs" className="size-3!" />
      ))}
    </span>
  );
};
