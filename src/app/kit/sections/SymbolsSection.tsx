"use client";

import React from "react";
import { Badge, StatusDot, type BadgeSize, type BadgeTone, type BadgeVariant, type PaletteColor } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import { CUSTOM_ICONS, ICONS, type IconName } from "@/components/ui/icons/registry";
import { Trend } from "@/components/ui/icons/Trend";
import {
  ClassTag,
  CLASS_COLORS,
  CompoundBadge,
  CompoundGlyph,
  COMPOUNDS,
  DeltaBadge,
  FlagBadge,
  FlagIcon,
  FLAGS,
  PenaltyBadge,
  PlayerTag,
  PositionBadge,
  QualityBadge,
  SessionBadge,
  StateBadge,
  SurfaceBadge,
  type CarClassCode,
  type Compound,
  type ContentState,
  type FlagKind,
  type SessionKind,
  type TrackSurface,
} from "@/components/ui/badges";
import {
  ArrowKeys,
  KeyCap,
  PadGlyph,
  PromptBar,
  WheelButton,
  type PadButtonName,
  type PadGlyphFamily,
  type Prompt,
} from "@/components/ui/prompts";

/* ------------------------------------------------------------------------------------------------------------------
 * Page furniture
 * ---------------------------------------------------------------------------------------------------------------- */

const CARD = "rounded-lc-card border border-white/7 bg-lc-carbon/80 p-4.5";
const HUD_GLASS = "rounded-lc-tile border border-white/7 bg-lc-void/74 shadow-lc-pop backdrop-blur-[14px]";

/** One group of the kit: a plain heading and one caption */
function Group({ title, caption, children }: { title: string; caption: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-5">
      <div className="flex max-w-[72ch] flex-col gap-2">
        <h2 className="lc-h2">{title}</h2>
        <p className="lc-hint m-0 text-[13px]">{caption}</p>
      </div>
      {children}
    </section>
  );
}

/** A card with a plain title */
function Panel({ title, caption, children, className = "" }: { title?: string; caption?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-3 ${CARD} ${className}`}>
      {title ? (
        <div className="flex flex-col gap-1">
          <h3 className="lc-h3">{title}</h3>
          {caption ? <p className="lc-hint m-0">{caption}</p> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/**
 * The bright sky the HUD sits over on a sunny circuit, made from the tokens: a stand-in for the scene, so small
 * symbols are judged where they have to survive
 */
function Sky({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative isolate overflow-hidden rounded-lc-sheet bg-lc-chalk p-3 sm:p-5 ${className}`}>
      <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-b from-lc-cyan/55 via-lc-cyan/20 to-lc-amber/25" />
      <div aria-hidden className="absolute inset-x-0 bottom-0 -z-10 h-1/4 bg-linear-to-t from-lc-slate/45 to-transparent" />
      {children}
    </div>
  );
}

/** The same small renders on HUD glass over the sky and on dark carbon */
function TwoGrounds({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <Sky>
          <div className={`flex flex-wrap items-center gap-x-4 gap-y-3 p-3 text-lc-chalk ${HUD_GLASS}`}>{children}</div>
        </Sky>
        <span className="lc-hint">HUD glass over a bright sky</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex min-h-full flex-wrap items-center gap-x-4 gap-y-3 rounded-lc-sheet bg-lc-carbon p-6 text-lc-chalk">
          {children}
        </div>
        <span className="lc-hint">Dark carbon</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------
 * Data for the demos
 * ---------------------------------------------------------------------------------------------------------------- */

const ICON_NAMES = Object.keys(ICONS) as IconName[];
const CUSTOM = new Set<IconName>(CUSTOM_ICONS);
/** Each own drawing once (the registry also lists a few of them under a second concept) */
const OWN_SYMBOLS = CUSTOM_ICONS.filter((n) => n !== "race" && n !== "circuit");

const FLAG_KINDS = Object.keys(FLAGS) as FlagKind[];
const COMPOUND_KINDS = Object.keys(COMPOUNDS) as Compound[];
const TONES: BadgeTone[] = ["neutral", "player", "info", "good", "best", "warn", "bad"];
const VARIANTS: BadgeVariant[] = ["solid", "soft", "outline"];
const SIZES: BadgeSize[] = ["lg", "md", "sm", "hud"];
const PALETTE: PaletteColor[] = ["crimson", "amber", "green", "cyan", "purple", "pink", "chalk", "slate"];
const SESSIONS: SessionKind[] = ["practice", "race", "timeAttack", "hillClimb", "online", "offline", "host"];
const STATES: ContentState[] = ["new", "beta", "wip", "experimental", "downloaded", "downloading", "updateAvailable", "inUse"];
const SURFACES: TrackSurface[] = ["dry", "damp", "wet", "flooded"];

const FAMILIES: { family: PadGlyphFamily; title: string; caption: string }[] = [
  { family: "xbox", title: "Xbox layout", caption: "Letters on the face buttons, LB RB LT RT, Menu and View." },
  { family: "playstation", title: "PlayStation layout", caption: "Cross, circle, square and triangle as plain strokes; L1 R1 L2 R2; Options and Create." },
  { family: "generic", title: "Any other pad", caption: "Face buttons by position, the pressed one filled; Xbox shoulder names; Start and Select." },
];

const PAD_ROWS: { title: string; buttons: PadButtonName[] }[] = [
  { title: "Face", buttons: ["a", "b", "x", "y"] },
  { title: "Shoulders and triggers", buttons: ["lb", "rb", "lt", "rt"] },
  { title: "Left stick", buttons: ["ls", "l3", "ls-up", "ls-down", "ls-left", "ls-right", "ls-horizontal", "ls-vertical"] },
  { title: "Right stick", buttons: ["rs", "r3", "rs-up", "rs-down", "rs-left", "rs-right", "rs-horizontal", "rs-vertical"] },
  { title: "D-pad", buttons: ["dpad", "dpad-up", "dpad-down", "dpad-left", "dpad-right", "dpad-horizontal", "dpad-vertical"] },
  { title: "System", buttons: ["menu", "view", "touchpad"] },
];

const BAR: Prompt[] = [
  { action: "move", label: "Move" },
  { action: "select", label: "Select" },
  { action: "adjust", label: "Change" },
  { action: "tabs", label: "Next tab" },
  { action: "back", label: "Back" },
];

/* ------------------------------------------------------------------------------------------------------------------
 * The section
 * ---------------------------------------------------------------------------------------------------------------- */

export function SymbolsSection() {
  return (
    <div className="flex flex-col gap-14">
      <Group
        title="Icons"
        caption="One icon per concept, through one Icon part: 14, 16, 20 or 24 px, always a 2 px stroke. Screens ask for the concept, never for a lucide name. Own drawings are marked; they sit on lucide's grid and weight."
      >
        <div className={CARD}>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))] gap-1 p-0">
            {ICON_NAMES.map((name) => (
              <li key={name} className="flex items-center gap-3 rounded-lc-row px-2 py-2 hover:bg-white/4">
                <span className="flex items-end gap-2 text-lc-chalk">
                  <Icon name={name} size="sm" />
                  <Icon name={name} size="md" />
                  <Icon name={name} size="lg" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="lc-mono truncate text-[12px] text-lc-fog">{name}</span>
                  {CUSTOM.has(name) ? <span className="lc-hint">Own drawing</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Group>

      <Group
        title="Own symbols"
        caption="What lucide has no icon for, drawn to its rules: 24 grid, 2 px stroke, round caps and joins, current colour, fills only for kerb blocks, chequers and dots. Each at 96 px to judge the drawing, then at 24, 20 and 16 px."
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
          {OWN_SYMBOLS.map((name) => {
            const Glyph = ICONS[name];
            return (
              <div key={name} className={`flex items-center gap-4 ${CARD}`}>
                <Glyph size={96} strokeWidth={2} aria-hidden className="shrink-0 text-lc-chalk" />
                <div className="flex min-w-0 flex-col gap-3">
                  <span className="flex items-end gap-3 text-lc-chalk">
                    <Icon name={name} size="lg" />
                    <Icon name={name} size="md" />
                    <Icon name={name} size="sm" />
                  </span>
                  <span className="lc-mono text-[12px] text-lc-fog">{name}</span>
                </div>
              </div>
            );
          })}
          <div className={`flex items-center gap-4 ${CARD}`}>
            <div className="flex flex-col gap-3">
              <span className="flex items-end gap-3 text-lc-slate">
                <Icon name="lapTimes" size="lg" />
                <Icon name="flyingLap" size="lg" />
                <Icon name="car" size="lg" />
              </span>
              <span className="lc-hint">Lucide neighbours, for weight</span>
            </div>
          </div>
        </div>
        <TwoGrounds>
          {OWN_SYMBOLS.map((name) => (
            <span key={name} className="flex items-end gap-1.5">
              <Icon name={name} size="md" />
              <Icon name={name} size="sm" />
            </span>
          ))}
        </TwoGrounds>
        <Panel title="Gain and loss" caption="One drawn arrow for every place the game wrote a triangle character. Up is better, down is worse; it sizes with its text.">
          <div className="flex flex-wrap items-center gap-6 text-lc-chalk">
            <span className="lc-data inline-flex items-center gap-1 text-[15px] text-lc-green">
              <Trend direction="up" /> 3
            </span>
            <span className="lc-data inline-flex items-center gap-1 text-[15px] text-lc-crimson">
              <Trend direction="down" /> 2
            </span>
            <span className="lc-data inline-flex items-center gap-1 text-[15px] text-lc-slate">
              <Trend direction="level" /> 0
            </span>
            <span className="lc-data inline-flex items-center gap-1 text-[11px]">
              <Trend direction="up" colored /> 11 px
            </span>
            <span className="lc-data inline-flex items-center gap-1 text-[9px]">
              <Trend direction="down" colored /> 9 px HUD
            </span>
            <Trend direction="up" size={48} colored label="Gaining" />
          </div>
        </Panel>
      </Group>

      <Group
        title="Flags"
        caption="Race control's flags, drawn: a pole and a waving cloth in the flag's colour. Where two flags share a colour they differ in shape or pattern. A flag that means something is always shown with its word."
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
          {FLAG_KINDS.map((f) => (
            <div key={f} className={`flex flex-col gap-3 ${CARD}`}>
              <div className="flex items-end gap-3 text-lc-fog">
                <FlagIcon flag={f} size={96} />
                <FlagIcon flag={f} size={24} />
                <FlagIcon flag={f} size={20} />
                <FlagIcon flag={f} size={16} />
              </div>
              <FlagBadge flag={f} />
            </div>
          ))}
        </div>
        <TwoGrounds>
          {FLAG_KINDS.map((f) => (
            <span key={f} className="flex items-center gap-2 text-lc-fog">
              <FlagIcon flag={f} size={16} />
              <FlagBadge flag={f} size="hud" />
            </span>
          ))}
        </TwoGrounds>
      </Group>

      <Group
        title="Tyre compounds"
        caption="One drawing for a compound: a dark tyre, the compound's stripe and its letter, which is always shown. Soft crimson, medium amber, hard chalk, intermediate green, wet cyan."
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
          {COMPOUND_KINDS.map((c) => (
            <div key={c} className={`flex flex-col gap-3 ${CARD}`}>
              <div className="flex items-end gap-3">
                <CompoundGlyph compound={c} size={96} />
                <CompoundGlyph compound={c} size={24} />
                <CompoundGlyph compound={c} size={20} />
                <CompoundGlyph compound={c} size={16} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <CompoundBadge compound={c} size="lg" />
                <CompoundBadge compound={c} size="sm" />
              </div>
            </div>
          ))}
        </div>
        <TwoGrounds>
          {COMPOUND_KINDS.map((c) => (
            <span key={c} className="flex items-center gap-2">
              <CompoundGlyph compound={c} size={16} />
              <CompoundBadge compound={c} size="hud" />
            </span>
          ))}
        </TwoGrounds>
      </Group>

      <Group
        title="Badges"
        caption="One pill for every status, tag and count: four sizes (28, 24, 20 and the 16 px HUD pill), three variants, seven tones by name. Volt is the player's alone. Data palettes such as car class pass a colour from their own table."
      >
        <Panel title="Tones and variants" caption="Medium size. Solid ink is void on every fill; soft and outline crimson and purple text is a step lighter, so it reads on its tint.">
          <div className="flex flex-col gap-3">
            {VARIANTS.map((v) => (
              <div key={v} className="flex flex-wrap items-center gap-2">
                <span className="lc-hint w-20 shrink-0">{v}</span>
                {TONES.map((t) => (
                  <Badge key={t} tone={t} variant={v}>
                    {t}
                  </Badge>
                ))}
              </div>
            ))}
          </div>
        </Panel>
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title="Sizes" caption="Large 28, medium 24 (the default), small 20, HUD 16. With a leading icon or the 6 px status dot.">
            <div className="flex flex-col gap-3">
              {SIZES.map((s) => (
                <div key={s} className="flex flex-wrap items-center gap-2">
                  <span className="lc-hint w-12 shrink-0">{s}</span>
                  <Badge size={s} tone="good">
                    Final
                  </Badge>
                  <Badge size={s} tone="info" icon="online">
                    Online
                  </Badge>
                  <Badge size={s} tone="good" dot="live">
                    2 connected
                  </Badge>
                  <Badge size={s} tone="warn" variant="outline" dot>
                    82 ms
                  </Badge>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Data palette and status dot" caption="Colours a named table may hand a badge, and the one dot, still or live.">
            <div className="flex flex-wrap items-center gap-2">
              {PALETTE.map((c) => (
                <Badge key={c} tone={{ color: c }}>
                  {c}
                </Badge>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-5 pt-2">
              {TONES.map((t) => (
                <span key={t} className="flex items-center gap-2 text-[13px] text-lc-fog">
                  <StatusDot tone={t} />
                  {t}
                </span>
              ))}
              <span className="flex items-center gap-2 text-[13px] text-lc-fog">
                <StatusDot tone="good" live label="Live" />
                live
              </span>
            </div>
          </Panel>
        </div>
      </Group>

      <Group
        title="Domain badges"
        caption="The single drawing of each racing concept, built on Badge: place, the player, class, compound, flags, penalties, provenance, session, gaps, content state and the track surface."
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title="Places and the player" caption="Always P1 form. The winner is purple, the player volt, everyone else neutral.">
            <div className="flex flex-wrap items-center gap-2">
              <PositionBadge position={1} />
              <PositionBadge position={2} />
              <PositionBadge position={3} />
              <PositionBadge position={7} player />
              <PositionBadge position={14} />
              <PlayerTag />
              <PositionBadge position={4} player size="hud" />
              <PlayerTag size="hud" />
            </div>
          </Panel>
          <Panel title="Car class" caption="Class codes in their colours from one table; no class wears volt.">
            <div className="flex flex-wrap items-center gap-2">
              {(Object.keys(CLASS_COLORS) as CarClassCode[]).map((c) => (
                <ClassTag key={c} carClass={c} />
              ))}
              {(Object.keys(CLASS_COLORS) as CarClassCode[]).map((c) => (
                <ClassTag key={`${c}-hud`} carClass={c} size="hud" />
              ))}
            </div>
          </Panel>
          <Panel title="Penalties" caption="Icon and words; amber for a warning, crimson for a penalty.">
            <div className="flex flex-wrap items-center gap-2">
              <PenaltyBadge penalty={{ kind: "time", seconds: 5 }} />
              <PenaltyBadge penalty={{ kind: "driveThrough" }} />
              <PenaltyBadge penalty={{ kind: "warning" }} />
              <PenaltyBadge penalty={{ kind: "trackLimits", strikes: 2, of: 3 }} />
              <PenaltyBadge penalty={{ kind: "disqualified" }} />
              <PenaltyBadge penalty={{ kind: "time", seconds: 10 }} size="hud" />
            </div>
          </Panel>
          <Panel title="Gaps" caption="Sign and arrow always shown: green gaining, crimson losing, purple and the word Best for a best.">
            <div className="flex flex-wrap items-center gap-2">
              <DeltaBadge seconds={-0.214} />
              <DeltaBadge seconds={0.087} />
              <DeltaBadge seconds={0} />
              <DeltaBadge seconds={-0.402} best />
              <DeltaBadge seconds={1.35} size="hud" />
              <DeltaBadge seconds={-0.05} size="hud" />
            </div>
          </Panel>
          <Panel title="Provenance" caption="Labels, tones and descriptions come from the registries' wrappers.">
            <div className="flex flex-wrap items-center gap-2">
              <QualityBadge label="Original" tone="info" description="Built for LibreCorsa with its own surfaces, kerbs, elevation and scenery." />
              <QualityBadge label="Sim grade" tone="good" description="A hand-built sim circuit." />
              <QualityBadge label="Scan" tone="warn" description="Converted automatically from a community 3D model." />
              <QualityBadge label="Own physics" tone="good" />
              <QualityBadge label="Shared physics" tone="warn" />
              <QualityBadge label="2026 physics" tone="neutral" />
            </div>
          </Panel>
          <Panel title="Session and surface" caption="What kind of session, how it is connected, and the water on the line.">
            <div className="flex flex-wrap items-center gap-2">
              {SESSIONS.map((s) => (
                <SessionBadge key={s} session={s} />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {SURFACES.map((s) => (
                <SurfaceBadge key={s} surface={s} />
              ))}
            </div>
          </Panel>
          <Panel title="Content state" caption="New is information, not volt. One word for the car or circuit in use." className="lg:col-span-2">
            <div className="flex flex-wrap items-center gap-2">
              {STATES.map((s) => (
                <StateBadge key={s} state={s} />
              ))}
            </div>
          </Panel>
        </div>
        <TwoGrounds>
          <PositionBadge position={3} size="hud" />
          <PositionBadge position={6} player size="hud" />
          <ClassTag carClass="gt3" size="hud" />
          <CompoundBadge compound="medium" size="hud" />
          <DeltaBadge seconds={-0.214} size="hud" />
          <DeltaBadge seconds={0.31} size="hud" />
          <PenaltyBadge penalty={{ kind: "time", seconds: 5 }} size="hud" />
          <FlagBadge flag="yellow" size="hud">
            Yellow S2
          </FlagBadge>
          <SurfaceBadge surface="wet" size="hud" />
          <Badge size="hud" tone="info" icon="drsOpen">
            DRS
          </Badge>
          <Badge size="hud" tone="info" icon="ers">
            ERS 62%
          </Badge>
          <span className="lc-data inline-flex items-center gap-1 text-[11px] text-lc-green">
            <Trend direction="up" /> 2 places
          </span>
        </TwoGrounds>
      </Group>

      <Group
        title="Prompts"
        caption="Monochrome caps 22 px high, so a prompt bar is one even row whatever the input: chalk on void with the keyline hairline. Arrow keys are drawn. No maker's logo and no brand colours."
      >
        <div className="grid gap-3 xl:grid-cols-3">
          {FAMILIES.map(({ family, title, caption }) => (
            <Panel key={family} title={title} caption={caption}>
              <div className="flex flex-col gap-4">
                {PAD_ROWS.map((row) => (
                  <div key={row.title} className="grid grid-cols-[6.5rem_1fr] items-center gap-3">
                    <span className="lc-hint">{row.title}</span>
                    <div className="flex flex-wrap items-center gap-2">
                      {row.buttons
                        .filter((b) => b !== "touchpad" || family === "playstation")
                        .map((b) => (
                          <PadGlyph key={b} button={b} family={family} />
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          ))}
        </div>
        <Panel title="Keyboard and wheel" caption="One cap per key. Inside a volt button the cap turns ink. Wheel buttons go by number.">
          <div className="flex flex-wrap items-center gap-3">
            <KeyCap>Esc</KeyCap>
            <KeyCap>Enter</KeyCap>
            <KeyCap>Space</KeyCap>
            <KeyCap>Tab</KeyCap>
            <KeyCap>Bksp</KeyCap>
            <KeyCap>Q</KeyCap>
            <KeyCap>E</KeyCap>
            <KeyCap>F</KeyCap>
            <ArrowKeys set="all" />
            <ArrowKeys set="horizontal" />
            <WheelButton button={4} />
            <span className="inline-flex h-11 items-center gap-2.5 rounded-full bg-lc-volt pr-5 pl-2.5 font-lc-display text-[15px] font-bold text-lc-void uppercase italic">
              <KeyCap tone="ink">Enter</KeyCap>
              Start race
            </span>
          </div>
        </Panel>
        <div className="flex flex-col gap-4">
          {(["keyboard", "xbox", "playstation"] as const).map((input) => (
            <div key={input} className="flex flex-col gap-1.5">
              <div className="rounded-lc-row bg-lc-carbon px-4.5 pt-1 pb-3">
                <PromptBar prompts={BAR} input={input} />
              </div>
              <span className="lc-hint">
                {input === "keyboard" ? "Keyboard" : input === "xbox" ? "Xbox controller" : "PlayStation controller"}
              </span>
            </div>
          ))}
        </div>
      </Group>
    </div>
  );
}
