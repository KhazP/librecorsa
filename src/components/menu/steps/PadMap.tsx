"use client";

import React, { useState } from "react";
import { PAD_ACTIONS, PAD_BRAKE_BUTTON, PAD_THROTTLE_BUTTON, type PadButtonBindings } from "@/lib/input/bindings";
import { PadGlyph, type PadButtonName } from "@/components/ui/prompts";
import { tokenColor } from "@/components/ui/token-color";
import { cx } from "@/components/ui/styles";
import { PAD_BUTTON_NAMES as NAMES, type PadFamily } from "../input-mode";
import type { PadState } from "../useMenuNav";

/** Standard-mapping buttons 0..11 as the glyphs name them */
const GLYPH: readonly PadButtonName[] = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "view", "menu", "l3", "r3"];

type Row = { key: string; buttons: number[]; glyph: PadButtonName; action: (b: PadButtonBindings) => string | null };

/** What a button does: a fixed control, or the action bound to it */
const bound = (button: number) => (b: PadButtonBindings) => PAD_ACTIONS.find((a) => b[a.id] === button)?.label ?? null;
const btn = (button: number, fixed?: string): Row => ({
  key: `b${button}`,
  buttons: [button],
  glyph: GLYPH[button],
  action: fixed ? () => fixed : bound(button),
});

const LEFT: Row[] = [
  btn(PAD_BRAKE_BUTTON, "Brake"),
  btn(4),
  btn(8),
  { key: "lstick", buttons: [], glyph: "ls", action: () => "Steer" },
  btn(10),
  { key: "dpad-x", buttons: [14, 15], glyph: "dpad-horizontal", action: () => "MFD dial" },
  { key: "dpad-y", buttons: [12, 13], glyph: "dpad-vertical", action: () => "MFD value" },
];
const RIGHT: Row[] = [btn(PAD_THROTTLE_BUTTON, "Throttle"), btn(5), btn(9), btn(3), btn(1), btn(2), btn(0), btn(11)];

/** Button state on the drawing: pressed on the pad, picked in the list, or at rest */
type Look = "pressed" | "picked" | "rest";

/** The drawing's colours, read where it draws (tokens follow the page) */
const FILL = (l: Look) => (l === "pressed" ? tokenColor("volt") : tokenColor("well"));
const STROKE = (l: Look) => (l === "rest" ? tokenColor("keyline") : tokenColor("volt"));

/** Body outlines in one 760-wide frame (both pads share it) */
const BODY: Record<PadFamily, string> = {
  xbox:
    "M380 118C430 118 470 110 500 112C535 114 552 130 560 152C575 200 590 260 592 300C594 330 575 345 555 340C535 335 520 310 505 290C490 270 470 262 450 262L310 262C290 262 270 270 255 290C240 310 225 335 205 340C185 345 166 330 168 300C170 260 185 200 200 152C208 130 225 114 260 112C290 110 330 118 380 118Z",
  playstation:
    "M380 122C430 122 470 106 510 108C545 110 560 128 568 150C582 196 600 262 602 300C604 334 584 352 560 346C540 341 527 318 512 296C500 280 480 272 460 272L300 272C280 272 260 280 248 296C233 318 220 341 200 346C176 352 156 334 158 300C160 262 178 196 192 150C200 128 215 110 250 108C290 106 330 122 380 122Z",
  // Any other pad is drawn as the Xbox layout
  get generic() {
    return BODY.xbox;
  },
};

/** Where each part sits on the body */
const LAYOUT: Record<
  PadFamily,
  {
    triggers: [number, number, number, number][]; // x y w h for LT / RT
    bumpers: [number, number, number, number][]; // LB / RB
    lstick: [number, number];
    rstick: [number, number];
    dpad: [number, number];
    face: [number, number];
    view: [number, number];
    menu: [number, number];
    home: [number, number];
  }
> = {
  xbox: {
    triggers: [
      [232, 76, 56, 18],
      [472, 76, 56, 18],
    ],
    bumpers: [
      [222, 98, 84, 12],
      [454, 98, 84, 12],
    ],
    lstick: [285, 165],
    rstick: [430, 228],
    dpad: [330, 228],
    face: [482, 165],
    view: [352, 168],
    menu: [408, 168],
    home: [380, 140],
  },
  playstation: {
    triggers: [
      [222, 74, 54, 18],
      [484, 74, 54, 18],
    ],
    bumpers: [
      [210, 96, 80, 12],
      [470, 96, 80, 12],
    ],
    lstick: [326, 234],
    rstick: [434, 234],
    dpad: [258, 170],
    face: [502, 170],
    view: [314, 130],
    menu: [446, 130],
    home: [380, 214],
  },
  // Any other pad is drawn as the Xbox layout
  get generic() {
    return LAYOUT.xbox;
  },
};

/** PlayStation face symbols drawn as shapes, so they look the same in every font */
const PsSymbol: React.FC<{ button: number; x: number; y: number; color: string }> = ({ button, x, y, color }) => {
  const p = { fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (button === 0) return <path d={`M${x - 4.5} ${y - 4.5}L${x + 4.5} ${y + 4.5}M${x + 4.5} ${y - 4.5}L${x - 4.5} ${y + 4.5}`} {...p} />;
  if (button === 1) return <circle cx={x} cy={y} r={5} {...p} />;
  if (button === 2) return <rect x={x - 4.5} y={y - 4.5} width={9} height={9} {...p} />;
  return <path d={`M${x} ${y - 5.5}L${x + 5.5} ${y + 4}L${x - 5.5} ${y + 4}Z`} {...p} />;
};

const PadArt: React.FC<{ family: PadFamily; look: (button: number) => Look; axes: number[] }> = ({ family, look, axes }) => {
  const L = LAYOUT[family];
  const part = (button: number) => {
    const l = look(button);
    return { fill: FILL(l), stroke: STROKE(l), strokeWidth: l === "rest" ? 1.5 : 2.5 };
  };
  const stick = ([cx, cy]: [number, number], button: number, ax: number, ay: number) => (
    <g>
      <circle cx={cx} cy={cy} r={25} fill={tokenColor("void")} stroke={tokenColor("line")} strokeWidth={1.5} />
      <circle cx={cx + ax * 7} cy={cy + ay * 7} r={16} {...part(button)} />
      <circle cx={cx + ax * 7} cy={cy + ay * 7} r={9} fill="none" stroke={look(button) === "pressed" ? tokenColor("void") : tokenColor("line")} strokeWidth={1.5} />
    </g>
  );
  const [dx, dy] = L.dpad;
  const [fx, fy] = L.face;
  const faces: [number, number, number][] = [
    [0, fx, fy + 23],
    [1, fx + 23, fy],
    [2, fx - 23, fy],
    [3, fx, fy - 23],
  ];

  return (
    <svg viewBox="140 62 480 300" className="block h-auto w-full" role="img" aria-label="Controller">
      {/* Triggers and bumpers sit behind the body */}
      {L.triggers.map(([x, y, w, h], i) => (
        <rect key={`t${i}`} x={x} y={y} width={w} height={h} rx={8} {...part(i ? 7 : 6)} />
      ))}
      {L.bumpers.map(([x, y, w, h], i) => (
        <rect key={`b${i}`} x={x} y={y} width={w} height={h} rx={6} {...part(i ? 5 : 4)} />
      ))}
      <path d={BODY[family]} fill={tokenColor("titanium")} stroke={tokenColor("keyline")} strokeWidth={1.5} />

      {family === "playstation" ? (
        <rect x={328} y={116} width={104} height={62} rx={10} fill={tokenColor("well")} stroke={tokenColor("line")} strokeWidth={1.5} />
      ) : null}
      <circle cx={L.home[0]} cy={L.home[1]} r={family === "xbox" ? 12 : 8} fill={tokenColor("well")} stroke={tokenColor("keyline")} strokeWidth={1.5} />

      {/* View / Create and Menu / Options */}
      <rect x={L.view[0] - 7} y={L.view[1] - (family === "xbox" ? 5 : 8)} width={14} height={family === "xbox" ? 10 : 16} rx={5} {...part(8)} />
      <rect x={L.menu[0] - 7} y={L.menu[1] - (family === "xbox" ? 5 : 8)} width={14} height={family === "xbox" ? 10 : 16} rx={5} {...part(9)} />

      {stick(L.lstick, 10, axes[0] ?? 0, axes[1] ?? 0)}
      {stick(L.rstick, 11, axes[2] ?? 0, axes[3] ?? 0)}

      {/* D-pad: one arm per button */}
      <rect x={dx - 22} y={dy - 8} width={44} height={16} rx={3} fill={tokenColor("well")} />
      <rect x={dx - 8} y={dy - 22} width={16} height={44} rx={3} fill={tokenColor("well")} />
      <rect x={dx - 8} y={dy - 23} width={16} height={16} rx={3} {...part(12)} />
      <rect x={dx - 8} y={dy + 7} width={16} height={16} rx={3} {...part(13)} />
      <rect x={dx - 23} y={dy - 8} width={16} height={16} rx={3} {...part(14)} />
      <rect x={dx + 7} y={dy - 8} width={16} height={16} rx={3} {...part(15)} />

      {/* Face buttons */}
      {faces.map(([b, x, y]) => {
        const l = look(b);
        const color = l === "pressed" ? tokenColor("void") : tokenColor("chalk");
        return (
          <g key={b}>
            <circle cx={x} cy={y} r={11.5} fill={FILL(l)} stroke={l === "rest" ? tokenColor("keyline") : tokenColor("volt")} strokeWidth={l === "rest" ? 1.5 : 2.5} />
            {family === "playstation" ? (
              <PsSymbol button={b} x={x} y={y} color={color} />
            ) : (
              <text x={x} y={y + 4.5} textAnchor="middle" fontSize={12} fontWeight={800} fill={color} fontFamily="inherit">
                {NAMES.xbox[b]}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

/** A button's glyph in the lists; ringed in volt while it is held down */
const Chip: React.FC<{ row: Row; family: PadFamily; lit: boolean }> = ({ row, family, lit }) => (
  <span className={cx("inline-flex min-w-9 shrink-0 justify-center rounded-full p-0.5", lit ? "inset-ring-2 inset-ring-lc-volt" : undefined)}>
    <PadGlyph button={row.glyph} family={family} />
  </span>
);

/**
 * Controller map: the connected pad drawn as an Xbox controller or a DualSense, with what every
 * button does either side. Buttons light up as they are pressed; pointing at a row picks its
 * button out on the drawing.
 */
export const PadMap: React.FC<{ family: PadFamily; bindings: PadButtonBindings; pad?: PadState | null }> = ({
  family,
  bindings,
  pad,
}) => {
  const [picked, setPicked] = useState<string | null>(null);
  const pressed = (b: number) => Boolean(pad?.buttons[b]?.pressed);
  const pickedButtons = new Set([...LEFT, ...RIGHT].find((r) => r.key === picked)?.buttons ?? []);
  const look = (b: number): Look => (pressed(b) ? "pressed" : pickedButtons.has(b) ? "picked" : "rest");
  const stickMoved = Math.hypot(pad?.axes[0] ?? 0, pad?.axes[1] ?? 0) > 0.2;

  const list = (rows: Row[], className: string) => (
    <ul className={`flex flex-col gap-1 ${className}`}>
      {rows.map((r) => {
        const action = r.action(bindings);
        const lit = r.key === "lstick" ? stickMoved : r.buttons.some(pressed);
        return (
          <li
            key={r.key}
            onPointerEnter={() => setPicked(r.key)}
            onPointerLeave={() => setPicked((p) => (p === r.key ? null : p))}
            className={`flex min-h-[38px] items-center gap-2.5 rounded-lc-nub px-1.5 transition-colors duration-100 ${
              lit ? "bg-lc-volt/8" : picked === r.key ? "bg-white/5" : ""
            }`}
          >
            <Chip row={r} family={family} lit={lit} />
            <span className={`min-w-0 text-[13px] leading-tight font-semibold ${action ? "text-lc-chalk" : "text-lc-slate"}`}>
              {action ?? "Not used"}
            </span>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="grid items-center gap-x-5 gap-y-3 sm:grid-cols-2 lg:grid-cols-[1fr_minmax(200px,300px)_1fr]">
      <div className="mx-auto w-full max-w-[320px] sm:col-span-2 lg:order-2 lg:col-span-1">
        <PadArt family={family} look={look} axes={pad?.axes ?? []} />
      </div>
      {list(LEFT, "lg:order-1")}
      {list(RIGHT, "lg:order-3")}
    </div>
  );
};
