"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import {
  Accessibility,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Gamepad2,
  Inbox,
  KeyRound,
  Monitor,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Timer,
  Trash2,
  TriangleAlert,
  Volume2,
} from "lucide-react";
import {
  adjacentTab,
  Button,
  Card,
  ConfirmDialog,
  cx,
  Disclosure,
  EmptyState,
  IconButton,
  MediaTile,
  Meter,
  NavList,
  OptionTile,
  OptionTileGroup,
  Segmented,
  Select,
  SettingRow,
  SettingsDetailProvider,
  Sheet,
  Skeleton,
  SkeletonText,
  Slider,
  Stepper,
  Tabs,
  TextField,
  Toast,
  ToastRegion,
  Toggle,
  useToasts,
  Well,
  type SettingsDetail,
  type ToastTone,
} from "@/components/ui";
import { focusables, focusInZone, focusZone, useFocusNav, useMoveHandler } from "@/components/menu/useFocusNav";

/* ------------------------------------------------------------------------------------------------------------------
 * Page furniture
 * ---------------------------------------------------------------------------------------------------------------- */

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

/** A photo-like dark block (a circuit at dusk, floodlights off to the sides), the ground the parts live on */
function Scene({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "relative isolate overflow-hidden rounded-lc-sheet border border-white/7 bg-linear-to-b from-lc-titanium via-lc-carbon to-lc-void p-3 sm:p-6",
        className,
      )}
    >
      <div aria-hidden className="absolute inset-0 -z-10 bg-radial-[at_12%_0%] from-lc-cyan/16 via-transparent via-40% to-transparent" />
      <div aria-hidden className="absolute inset-0 -z-10 bg-radial-[at_92%_100%] from-lc-amber/14 via-transparent via-45% to-transparent" />
      <div aria-hidden className="absolute -top-24 right-1/4 -z-10 size-72 rounded-full bg-lc-fog/6 blur-3xl" />
      <div aria-hidden className="absolute inset-x-0 top-[62%] -z-10 h-px bg-white/8" />
      <div aria-hidden className="absolute inset-x-0 bottom-0 -z-10 h-2/5 bg-linear-to-t from-lc-void/90 to-transparent" />
      {children}
    </div>
  );
}

/** A part with its state written under it */
function State({ name, children, className }: { name: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-w-0 max-w-full flex-col items-start gap-2 [&>*]:max-w-full", className)}>
      {children}
      <span className="lc-hint">{name}</span>
    </div>
  );
}

/** A keyboard cap for the demo's prompts (the real `KeyCap` comes with the prompts set) */
function DemoKey({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <span
      aria-label={label}
      className="lc-chip-text inline-flex h-5.5 min-w-5.5 shrink-0 items-center justify-center rounded-full bg-lc-void px-1.5 text-[10px] leading-none text-lc-chalk inset-ring inset-ring-lc-keyline [&_svg]:size-3"
    >
      {children}
    </span>
  );
}

const icon20 = (I: React.ComponentType<{ size?: number; strokeWidth?: number }>) => <I size={20} strokeWidth={2} />;
const icon16 = (I: React.ComponentType<{ size?: number; strokeWidth?: number }>) => <I size={16} strokeWidth={2} />;

/* ------------------------------------------------------------------------------------------------------------------
 * Groups
 * ---------------------------------------------------------------------------------------------------------------- */

const TYPE_ROLES: readonly { cls: string; sample: string; note: string }[] = [
  { cls: "lc-h1", sample: "Race setup", note: "Screen title · 44 / 28 px" },
  { cls: "lc-h2", sample: "Settings", note: "Panel title · 34 / 24 px" },
  { cls: "lc-h3", sample: "Force feedback", note: "Card title · 18 px" },
  { cls: "lc-row-label", sample: "Proximity radar", note: "Row label · 15 px" },
  { cls: "lc-body", sample: "Fades in when a car is alongside or within 25 m.", note: "Body · 14 px" },
  { cls: "lc-hint", sample: "Lower is faster", note: "Hint · 12 px" },
  { cls: "lc-field-label", sample: "Lobby code", note: "The name above a field · 13 px, sentence case" },
  { cls: "lc-lbl", sample: "Best lap", note: "Table headers and inline meter names only · 11 px" },
  { cls: "lc-chip-text", sample: "Final lap", note: "Chip text · 11 px" },
  { cls: "lc-data text-[15px]", sample: "1:42.318", note: "Data · tabular" },
  { cls: "lc-mono text-[13px] text-lc-fog", sample: "+0.412  P3  12/24", note: "Mono · tabular" },
  { cls: "lc-hud-lbl", sample: "Gap ahead", note: "HUD label · 9 px, HUD only" },
];

function TypeGroup() {
  return (
    <Group title="Type roles" caption="One class per role, fixed sizes. The two display headings step down on phones.">
      <Card>
        {TYPE_ROLES.map((r) => (
          <div key={r.cls} className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1 border-b border-lc-line py-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_16rem]">
            <span className={r.cls}>{r.sample}</span>
            <span className="lc-mono text-[12px] text-lc-slate">
              .{r.cls.split(" ")[0]} <span className="text-lc-dim">{r.note}</span>
            </span>
          </div>
        ))}
      </Card>
    </Group>
  );
}

function ButtonGroup() {
  const variants = ["primary", "secondary", "ghost", "danger"] as const;
  const labels = { primary: "Start race", secondary: "Car setup", ghost: "Skip", danger: "Delete ghost" };
  return (
    <Group
      title="Buttons"
      caption="Four variants, three sizes. Cursor, disabled and loading are forced here; hover and press any button to see the rest. The cursor is volt on every variant but danger, which fills crimson."
    >
      <Scene>
        <Sheet className="flex flex-col gap-6">
          <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
            {variants.map((v) => (
              <div key={v} className="flex flex-col gap-3">
                <State name={`${v[0].toUpperCase()}${v.slice(1)}`}>
                  <Button variant={v}>{labels[v]}</Button>
                </State>
                <State name="Cursor">
                  <Button variant={v} forceCursor>
                    {labels[v]}
                  </Button>
                </State>
                <State name="Disabled">
                  <Button variant={v} disabled>
                    {labels[v]}
                  </Button>
                </State>
                <State name="Loading">
                  <Button variant={v} loading>
                    {labels[v]}
                  </Button>
                </State>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-x-5 gap-y-4 border-t border-lc-line pt-5">
            <State name="lg 52 px, prompt inside">
              <Button variant="primary" size="lg" prompt={<DemoKey>Enter</DemoKey>}>
                Drive
              </Button>
            </State>
            <State name="md 44 px, icon">
              <Button variant="secondary" icon={icon20(Settings)}>
                Settings
              </Button>
            </State>
            <State name="sm 36 px">
              <Button variant="ghost" size="sm" icon={icon16(RotateCcw)}>
                Reset
              </Button>
            </State>
            <State name="Link">
              <Button variant="secondary" size="sm" href="#kit-core-settings">
                Settings screen
              </Button>
            </State>
            <State name="Reason kept reachable">
              <Button variant="primary" size="md" disabledReason="Pick a car first">
                Start race
              </Button>
            </State>
          </div>
          <div className="flex flex-wrap items-end gap-x-5 gap-y-4 border-t border-lc-line pt-5">
            <State name="Icon, md 44">
              <IconButton variant="primary" aria-label="Resume" icon={icon20(Play)} />
            </State>
            <State name="Secondary">
              <IconButton variant="secondary" aria-label="Add a preset" icon={icon20(Plus)} />
            </State>
            <State name="Ghost">
              <IconButton aria-label="Settings" icon={icon20(Settings)} />
            </State>
            <State name="Cursor">
              <IconButton aria-label="Settings" icon={icon20(Settings)} forceCursor />
            </State>
            <State name="Danger, sm 36">
              <IconButton variant="danger" size="sm" aria-label="Delete" icon={icon16(Trash2)} />
            </State>
            <State name="Disabled">
              <IconButton variant="secondary" size="sm" aria-label="Reset" icon={icon16(RotateCcw)} disabled />
            </State>
          </div>
        </Sheet>
      </Scene>
      <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg" prompt={<DemoKey>Enter</DemoKey>}>
              Drive
            </Button>
            <Button variant="secondary">Car setup</Button>
            <Button variant="ghost" size="sm" icon={icon16(RotateCcw)}>
              Reset
            </Button>
            <Button variant="secondary" size="sm">
              Recalibrate
            </Button>
          </div>
    </Group>
  );
}

function RowsGroup() {
  const [radar, setRadar] = useState(true);
  const [trace, setTrace] = useState(false);
  const [hud, setHud] = useState(115);
  const [quality, setQuality] = useState<"low" | "medium" | "high">("high");
  const [laps, setLaps] = useState(5);
  const [cam, setCam] = useState("cockpit");
  const [demoToggle, setDemoToggle] = useState(true);
  const [demoRange, setDemoRange] = useState(1);
  const [demoTune, setDemoTune] = useState(0.6);
  const [demoPsi, setDemoPsi] = useState(23.5);
  const [demoSeg, setDemoSeg] = useState<"off" | "tcabs" | "full">("tcabs");
  return (
    <Group
      title="Setting rows"
      caption="Every setting is one row: label, hint, control on the right, the whole row ringed when its control has the cursor. A cyan dot and a reset button show a changed value. A disabled row stays reachable and says why."
    >
      <Scene>
        <div className="grid gap-3 xl:grid-cols-2">
          <Card title="Row states">
            <SettingRow label="Proximity radar" hint="Fades in when a car is alongside or within 25 m">
              <Toggle checked={radar} onChange={setRadar} />
            </SettingRow>
            <SettingRow label="Input trace" hint="Cursor forced on this row" forceCursor>
              <Toggle checked={trace} onChange={setTrace} />
            </SettingRow>
            <SettingRow
              label="HUD size"
              hint="Each corner group scales about its own corner"
              changed={hud !== 100}
              onReset={() => setHud(100)}
              resetLabel="Reset HUD size to 100%"
            >
              <Slider value={hud} onChange={setHud} min={75} max={150} step={5} unit="%" defaultValue={100} />
            </SettingRow>
            <SettingRow label="Field of view" hint="Cursor forced on a slider row" forceCursor>
              <Slider value={75} onChange={() => undefined} min={40} max={110} format={(v) => `${v}°`} defaultValue={75} />
            </SettingRow>
            <SettingRow label="Impulse-trigger rumble" disabled disabledReason="Turn on Gamepad rumble first">
              <Toggle checked={false} onChange={() => undefined} />
            </SettingRow>
            <SettingRow label="Render resolution" disabled disabledReason="Set by the VR headset while in VR">
              <Slider value={100} onChange={() => undefined} min={50} max={150} step={5} unit="%" />
            </SettingRow>
          </Card>
          <Card title="Every control in a row">
            <SettingRow label="Graphics quality" hint="Low drops shadows and bloom">
              <Segmented
                value={quality}
                onChange={setQuality}
                options={[
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                ]}
              />
            </SettingRow>
            <SettingRow label="Laps" hint="Stepper: small whole numbers">
              <Stepper value={laps} onChange={setLaps} min={1} max={50} />
            </SettingRow>
            <SettingRow label="Starting camera" hint="Select: more than five options, or long ones">
              <Select
                value={cam}
                onChange={setCam}
                options={[
                  { id: "cockpit", label: "Cockpit" },
                  { id: "bonnet", label: "Bonnet" },
                  { id: "chase", label: "Chase", detail: "Behind the car" },
                  { id: "far", label: "Chase far" },
                  { id: "tv", label: "TV cameras", detail: "Trackside, cuts as you pass" },
                  { id: "heli", label: "Helicopter" },
                ]}
              />
            </SettingRow>
            <SettingRow label="Key bindings" hint="A destructive action sits in a row as a danger button">
              <Button variant="danger" size="sm">
                Reset
              </Button>
            </SettingRow>
          </Card>
        </div>
      </Scene>
      <div className="flex flex-col gap-1">
            <SettingRow label="Proximity radar" hint="Fades in when a car is alongside or within 25 m">
              <Toggle checked={demoToggle} onChange={setDemoToggle} />
            </SettingRow>
            <SettingRow label="Render resolution" hint="Lower is faster">
              <Slider value={Math.round(demoRange * 100)} onChange={(v) => setDemoRange(v / 100)} min={50} max={150} step={5} unit="%" defaultValue={100} />
            </SettingRow>
            <SettingRow label="Steering speed" hint="How fast the wheel turns">
              <Slider value={Math.round(demoTune * 100)} onChange={(v) => setDemoTune(v / 100)} min={0} max={100} step={5} unit="%" />
            </SettingRow>
            <SettingRow label="Front left">
              <Slider value={demoPsi} onChange={setDemoPsi} min={18} max={30} step={0.5} format={(v) => `${v.toFixed(1)} psi`} />
            </SettingRow>
            <SettingRow label="Assists">
              <Segmented
                value={demoSeg}
                onChange={setDemoSeg}
                options={[
                  { id: "off", label: "Off" },
                  { id: "tcabs", label: "TC + ABS" },
                  { id: "full", label: "Full" },
                ]}
              />
            </SettingRow>
          </div>
    </Group>
  );
}

const QUALITY_TILES = [
  { id: "low", title: "Low", detail: "No shadows or bloom, half the trees, lower resolution" },
  { id: "medium", title: "Medium", detail: "Shadows, no bloom, fewer trees" },
  { id: "high", title: "High", detail: "Everything on" },
] as const;

function ChoicesGroup() {
  const [seg, setSeg] = useState<"interval" | "leader">("interval");
  const [mirror, setMirror] = useState<"off" | "top" | "corner">("top");
  const [tile, setTile] = useState<string>("high");
  const [demoTile, setDemoTile] = useState<string>("high");
  const [demoMedia, setDemoMedia] = useState<string>("Prototype");
  const [choice, setChoice] = useState<"race" | "practice">("race");
  const [opponents, setOpponents] = useState(11);
  const [units, setUnits] = useState("metric");
  return (
    <Group
      title="Choices"
      caption="The chosen option is white, the cursor volt; the cursor wins where both meet. Segmented rows take left and right as a change of value and stop at their ends."
    >
      <Scene>
        <Sheet className="flex flex-col gap-6">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-5">
            <State name="Segmented md 40">
              <Segmented aria-label="Timing tower" value={seg} onChange={setSeg} options={[{ id: "interval", label: "Interval" }, { id: "leader", label: "To leader" }]} />
            </State>
            <State name="Cursor on a chosen option">
              <Segmented aria-label="Timing tower" value={seg} onChange={setSeg} forceCursorOn={seg} options={[{ id: "interval", label: "Interval" }, { id: "leader", label: "To leader" }]} />
            </State>
            <State name="sm 36, one option off">
              <Segmented
                size="sm"
                aria-label="Rear-view mirror"
                value={mirror}
                onChange={setMirror}
                options={[
                  { id: "off", label: "Off" },
                  { id: "top", label: "Top" },
                  { id: "corner", label: "Corner", disabled: true },
                ]}
              />
            </State>
            <State name="Disabled">
              <Segmented aria-label="Units" disabled value={units} onChange={setUnits} options={[{ id: "metric", label: "Metric" }, { id: "imperial", label: "Imperial" }]} />
            </State>
          </div>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-5 border-t border-lc-line pt-5">
            <State name="Select">
              <Select aria-label="Frame rate limit" value="display" onChange={() => undefined} options={[{ id: "display", label: "Match the display" }, { id: "60", label: "60 fps" }]} />
            </State>
            <State name="Select, cursor">
              <Select aria-label="Frame rate limit" value="display" forceCursor onChange={() => undefined} options={[{ id: "display", label: "Match the display" }]} />
            </State>
            <State name="Select, disabled">
              <Select aria-label="Frame rate limit" value="display" disabled onChange={() => undefined} options={[{ id: "display", label: "Match the display" }]} />
            </State>
            <State name="Stepper">
              <Stepper aria-label="Opponents" value={opponents} onChange={setOpponents} min={0} max={23} />
            </State>
            <State name="Stepper, cursor">
              <Stepper aria-label="Opponents" value={opponents} onChange={setOpponents} min={0} max={23} forceCursor />
            </State>
            <State name="Stepper, disabled">
              <Stepper aria-label="Opponents" value={opponents} onChange={setOpponents} min={0} max={23} disabled />
            </State>
          </div>
          <div className="flex flex-col gap-3 border-t border-lc-line pt-5">
            <OptionTileGroup aria-label="Graphics quality" columns={3}>
              {QUALITY_TILES.map((q) => (
                <OptionTile key={q.id} checked={tile === q.id} onSelect={() => setTile(q.id)} title={q.title} description={q.detail} forceCursor={q.id === "medium"} />
              ))}
            </OptionTileGroup>
            <OptionTileGroup aria-label="Graphics quality in VR" columns={3}>
              <OptionTile checked={false} disabled onSelect={() => undefined} title="Ultra" description="Needs a desktop GPU; off in VR" />
            </OptionTileGroup>
            <p className="lc-hint m-0">Option tiles: High is chosen, the cursor is forced onto Medium; Ultra is disabled.</p>
          </div>
        </Sheet>
      </Scene>
      <div className="flex flex-col gap-3">
            <OptionTileGroup aria-label="Session" columns={2}>
              <OptionTile checked={choice === "race"} onSelect={() => setChoice("race")} title="Race" description="A grid, a start and a finish" />
              <OptionTile checked={choice === "practice"} onSelect={() => setChoice("practice")} title="Practice" description="Lap on your own, as long as you like" />
            </OptionTileGroup>
            <OptionTileGroup aria-label="Quality" columns={3}>
              {QUALITY_TILES.map((q) => (
                <OptionTile key={q.id} checked={demoTile === q.id} onSelect={() => setDemoTile(q.id)} title={q.title} description={q.detail} />
              ))}
            </OptionTileGroup>
            <div className="grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-3">
              {(["Prototype", "GT3", "Road car"] as const).map((name, i) => (
                <MediaTile
                  key={name}
                  media={<span className="block size-full bg-linear-to-br from-lc-titanium to-lc-well" />}
                  title={name}
                  meta={i === 0 ? "Open-wheel, 2026" : i === 1 ? "GT3, 2024" : "Road, 2019"}
                  badges={<Badge tone={i === 0 ? "good" : "neutral"} size="sm">{i === 0 ? "Own physics" : "Shared physics"}</Badge>}
                  overlay={demoMedia === name ? <Badge tone="neutral" variant="solid" size="sm">In use</Badge> : undefined}
                  chosen={demoMedia === name}
                  onSelect={() => setDemoMedia(name)}
                />
              ))}
            </div>
          </div>
    </Group>
  );
}

const KIT_WRAP_TABS = ["Aerodynamics", "Transmission", "Suspension", "Dampers", "Brakes", "Tyres", "Electronics", "Fuel"].map((label) => ({
  id: label.toLowerCase(),
  label,
}));

const KIT_TABS = [
  { id: "race", label: "Race" },
  { id: "conditions", label: "Conditions" },
  { id: "field", label: "Field" },
  { id: "rules", label: "Rules" },
] as const;
type KitTab = (typeof KIT_TABS)[number]["id"];

function NavGroup() {
  const [a, setA] = useState<KitTab>("race");
  const [b, setB] = useState<"all" | "fav" | "recent">("all");
  const [tabDemo, setDemo] = useState<KitTab>("race");
  const [wrapDemo, setWrapDemo] = useState("aerodynamics");
  const [cat, setCat] = useState<"display" | "controls" | "audio">("display");
  return (
    <Group
      title="Tabs and lists"
      caption="Tabs choose as the cursor lands on them and take a nav zone each, so two strips share a screen. The nav list is the left column of a settings screen: up and down choose, right enters the pane. Hovering moves neither, so the page never switches under the pointer."
    >
      <Scene>
        <Sheet className="flex flex-col gap-5">
          <Tabs
            aria-label="Race setup"
            navZone="kit-tabs-a"
            tabs={KIT_TABS}
            value={a}
            onChange={setA}
            prevPrompt={<DemoKey>Q</DemoKey>}
            nextPrompt={<DemoKey>E</DemoKey>}
          />
          <div className="flex flex-wrap items-end gap-x-6 gap-y-5">
            <State name="sm 36, its own zone">
              <Tabs
                aria-label="Library"
                navZone="kit-tabs-b"
                size="sm"
                value={b}
                onChange={setB}
                tabs={[
                  { id: "all", label: "All cars", badge: <span className="lc-mono text-[12px] opacity-70">42</span> },
                  { id: "fav", label: "Favourites" },
                  { id: "recent", label: "Recent" },
                ]}
              />
            </State>
            <State name="Cursor forced on a tab that is not chosen">
              <Tabs aria-label="Race setup" navZone="kit-tabs-c" size="sm" tabs={KIT_TABS} value="race" onChange={() => undefined} forceCursorOn="field" />
            </State>
          </div>
          <div className="grid gap-5 border-t border-lc-line pt-5 sm:grid-cols-[repeat(2,minmax(0,15rem))]">
            <NavList
              aria-label="Settings categories"
              navZone="kit-nav"
              value={cat}
              onChange={setCat}
              items={[
                { id: "display", label: "Display", icon: icon20(Monitor), count: 2, countLabel: "2 changed" },
                { id: "controls", label: "Controls", icon: icon20(Gamepad2) },
                { id: "audio", label: "Audio", icon: icon20(Volume2) },
              ]}
            />
            <NavList
              aria-label="Settings categories"
              navZone="kit-nav-b"
              value="display"
              onChange={() => undefined}
              forceCursorOn="controls"
              items={[
                { id: "display", label: "Display", icon: icon20(Monitor), count: 2, countLabel: "2 changed" },
                { id: "controls", label: "Controls", icon: icon20(Gamepad2), count: 1, countLabel: "1 changed" },
                { id: "audio", label: "Audio", icon: icon20(Volume2) },
              ]}
            />
          </div>
        </Sheet>
      </Scene>
      <div className="flex flex-col gap-3">
            <Tabs aria-label="Race setup" navZone="kit-tabs-d" tabs={KIT_TABS} value={tabDemo} onChange={setDemo} prevPrompt={<DemoKey>Q</DemoKey>} nextPrompt={<DemoKey>E</DemoKey>} />
            <div className="max-w-md">
              <Tabs aria-label="Garage pages" navZone="kit-tabs-e" size="sm" wrap tabs={KIT_WRAP_TABS} value={wrapDemo} onChange={setWrapDemo} />
            </div>
            <NavList
              aria-label="Settings categories"
              navZone="kit-nav-c"
              className="max-w-xs"
              value="display"
              onChange={() => undefined}
              items={[
                { id: "display", label: "Display", icon: icon20(Monitor) },
                { id: "controls", label: "Controls", icon: icon20(Gamepad2) },
              ]}
            />
          </div>
    </Group>
  );
}

function FieldsGroup() {
  const [name, setName] = useState("Alp");
  const [code, setCode] = useState("KQZ4");
  const [query, setQuery] = useState("");
  const [demoName, setDemoName] = useState("Alp");
  const [demoNote, setDemoNote] = useState("");
  const codeError = code.length !== 6 ? "A lobby code is six characters, like KQZ4TR. Check the invite and try again." : undefined;
  return (
    <Group title="Text fields" caption="44 px on a well, the label above it. The focus is the volt edge and halo; an error turns the edge crimson and says how to fix it.">
      <Scene>
        <Sheet className="grid gap-x-5 gap-y-6 md:grid-cols-2">
          <TextField label="Driver name" value={name} onChange={setName} hint="Shown on the timing tower and online boards" maxLength={24} />
          <TextField label="Lobby code" value={code} onChange={(v) => setCode(v.toUpperCase())} error={codeError} spellCheck={false} autoComplete="off" />
          <TextField label="Search circuits" value={query} onChange={setQuery} placeholder="Name, country or layout" icon={icon16(Search)} forceCursor />
          <TextField label="Server address" value="eu-west.librecorsa.net" onChange={() => undefined} disabled hint="Set by the host" />
        </Sheet>
      </Scene>
      <div className="grid gap-5 md:grid-cols-2">
        <TextField label="Driver name" value={demoName} onChange={setDemoName} />
        <TextField label="What happened" multiline rows={3} value={demoNote} onChange={setDemoNote} hint="Multiline: a text area on the same well" />
      </div>
    </Group>
  );
}

function SurfacesGroup() {
  return (
    <Group
      title="Surfaces"
      caption="A sheet per screen region over the scene, cards inside it, wells inside a card. A card names itself with a plain heading; it never holds another card."
    >
      <Scene>
        <Sheet className="grid gap-3 md:grid-cols-2">
          <Card title="Best laps" action={<Button variant="ghost" size="sm" icon={icon16(RotateCcw)}>Reset</Button>}>
            <div className="grid grid-cols-3 gap-2">
              {[
                ["Best", "1:42.318"],
                ["Theoretical", "1:41.906"],
                ["Last", "1:43.050"],
              ].map(([k, v]) => (
                <Well key={k} className="flex flex-col gap-1 px-3 py-2.5">
                  <span className="lc-data text-[16px] text-lc-chalk">{v}</span>
                  <span className="lc-hint">{k}</span>
                </Well>
              ))}
            </div>
          </Card>
          <Card title="Tyres" description="Card with a line under its title">
            <Meter label="Front left" value={0.82} tone="good" detail="82%" labelClassName="w-28" />
            <Meter label="Front right" value={0.64} tone="warn" detail="64%" labelClassName="w-28" />
            <Meter label="Rear left" value={0.31} tone="bad" detail="31%" labelClassName="w-28" />
          </Card>
        </Sheet>
      </Scene>
      <div className="flex flex-col gap-3">
            <Card title="Steering assist">
              <span className="lc-body">Card content</span>
            </Card>
            <Card title="Widgets and cues">
              <span className="lc-body">Card content</span>
            </Card>
          </div>
    </Group>
  );
}

function FeedbackGroup({ onToast }: { onToast: (message: string, tone: ToastTone) => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Group
      title="Feedback"
      caption="Toasts take their tone from the icon and hairline, never a fill. Empty states teach what goes there. Skeletons stand in at the size of the content and stop pulsing under reduced motion."
    >
      <Scene>
        <Sheet className="grid gap-3 lg:grid-cols-2">
          <Card title="Toasts">
            <div className="flex flex-col items-start gap-2 py-1">
              <Toast tone="good">Setup saved to this car</Toast>
              <Toast tone="info">Ghost loaded: 1:42.318</Toast>
              <Toast tone="warn">Connection is slow: 240 ms</Toast>
              <Toast tone="bad">The lobby closed</Toast>
              <Toast tone="neutral" action={<Button variant="ghost" size="sm">Undo</Button>}>
                Livery changed
              </Toast>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button size="sm" onClick={() => onToast("Setup saved to this car", "good")}>
                Show a toast
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onToast("Connection is slow: 240 ms", "warn")}>
                Show a warning
              </Button>
            </div>
          </Card>
          <Card title="Lap times">
            <EmptyState icon={icon20(Timer)} action={<Button variant="primary" size="md" icon={icon20(Play)}>Drive</Button>}>
              Your lap times appear here after your first timed lap. Drive a lap to set one.
            </EmptyState>
          </Card>
          <Card title="Loading">
            <div aria-busy="true" aria-label="Loading circuits" className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-12 w-20" />
                  <span className="flex min-w-0 flex-1 flex-col gap-2">
                    <Skeleton shape="line" className="w-2/5" />
                    <SkeletonText lines={1} />
                  </span>
                  <Skeleton shape="circle" className="size-9" />
                </div>
              ))}
            </div>
          </Card>
          <Card title="Meters and more">
            <Meter label="Throttle" value={0.92} tone="good" />
            <Meter label="Brake" value={0.4} tone="bad" />
            <Meter label="ERS" value={0.66} tone="info" />
            <Meter label="Fuel" value={0.12} tone="warn" detail="4.1 L" />
            <Meter stacked label="RISE Motordrome, Short layout" value={0.62} tone="info" detail="12.3 h, 45 sessions" />
            <Disclosure moreLabel="More telemetry" lessLabel="Less telemetry" count={2} forceCursor>
              <Meter label="Clutch" value={0} tone="neutral" />
              <Meter label="Battery" value={0.8} tone="best" />
            </Disclosure>
            <SettingRow label="Delete all ghosts" hint="A destructive action asks first">
              <Button variant="danger" size="sm" icon={icon16(Trash2)} onClick={() => setConfirm(true)}>
                Delete
              </Button>
            </SettingRow>
          </Card>
        </Sheet>
      </Scene>
      <ConfirmDialog
        open={confirm}
        title="Delete all ghosts?"
        confirmLabel="Delete ghosts"
        icon={<TriangleAlert size={24} strokeWidth={2} />}
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setBusy(true);
          window.setTimeout(() => {
            setBusy(false);
            setConfirm(false);
            onToast("Ghosts deleted", "neutral");
          }, 700);
        }}
      >
        Every saved ghost lap on this device goes. Your lap times stay.
      </ConfirmDialog>
      <div className="flex flex-col gap-2">
            <Meter label="Throttle" value={0.92} tone="good" />
            <Meter label="Brake" value={0.4} tone="bad" />
          </div>
    </Group>
  );
}

/* ------------------------------------------------------------------------------------------------------------------
 * The composed example: a settings screen as it would look in the game
 * ---------------------------------------------------------------------------------------------------------------- */

type Value = number | boolean | string;
interface Opt {
  id: string;
  label: string;
  detail?: string;
}
interface RowBase {
  id: string;
  label: string;
  hint?: string;
  advanced?: boolean;
  /** Off (and says why) while another setting is off */
  needs?: { id: string; reason: string };
}
type RowDef =
  | (RowBase & { kind: "toggle"; def: boolean })
  | (RowBase & { kind: "slider"; def: number; min: number; max: number; step: number; format: (v: number) => string })
  | (RowBase & { kind: "segmented"; def: string; options: readonly Opt[] })
  | (RowBase & { kind: "select"; def: string; options: readonly Opt[] })
  | (RowBase & { kind: "stepper"; def: number; min: number; max: number; format?: (v: number) => string })
  | (RowBase & { kind: "resetBindings" });
interface CardDef {
  title: string;
  rows: readonly RowDef[];
}
interface TabDef {
  id: string;
  label: string;
  cards: readonly CardDef[];
}
interface CategoryDef {
  id: string;
  label: string;
  icon: React.ReactNode;
  tabs: readonly TabDef[];
}

const pct = (v: number) => `${v}%`;
const deg = (v: number) => `${v}°`;

const CATEGORIES: readonly CategoryDef[] = [
  {
    id: "display",
    label: "Display",
    icon: icon20(Monitor),
    tabs: [
      {
        id: "graphics",
        label: "Graphics",
        cards: [
          {
            title: "Quality",
            rows: [
              {
                kind: "segmented",
                id: "quality",
                label: "Graphics quality",
                hint: "Low drops shadows and bloom, for laptops and phones",
                def: "high",
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                ],
              },
              { kind: "slider", id: "renderScale", label: "Render resolution", hint: "Lower is faster", def: 100, min: 50, max: 150, step: 5, format: pct },
              {
                kind: "segmented",
                id: "shadows",
                label: "Shadow detail",
                advanced: true,
                def: "medium",
                options: [
                  { id: "off", label: "Off" },
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                ],
              },
              {
                kind: "select",
                id: "aa",
                label: "Anti-aliasing",
                hint: "Smooths jagged edges on kerbs and fences",
                advanced: true,
                def: "smaa",
                options: [
                  { id: "off", label: "Off" },
                  { id: "fxaa", label: "FXAA", detail: "Fastest, a little soft" },
                  { id: "smaa", label: "SMAA", detail: "Sharp, light on the GPU" },
                  { id: "msaa", label: "MSAA 4x", detail: "Sharpest, heavy" },
                ],
              },
            ],
          },
          {
            title: "Performance",
            rows: [
              {
                kind: "select",
                id: "fpsCap",
                label: "Frame rate limit",
                def: "display",
                options: [
                  { id: "display", label: "Match the display" },
                  { id: "60", label: "60 fps" },
                  { id: "90", label: "90 fps" },
                  { id: "120", label: "120 fps" },
                  { id: "144", label: "144 fps" },
                  { id: "none", label: "No limit", detail: "Runs the GPU flat out" },
                ],
              },
              { kind: "stepper", id: "detailCars", label: "Cars drawn in full detail", hint: "Cars further back use a lighter model", def: 8, min: 2, max: 24 },
              { kind: "toggle", id: "showFps", label: "Show frame rate", hint: "In the top-right corner, over the HUD", def: false },
            ],
          },
          {
            title: "View",
            rows: [
              { kind: "slider", id: "fov", label: "Field of view", hint: "For every car; each car keeps its own offset", def: 75, min: 40, max: 110, step: 1, format: deg },
              { kind: "toggle", id: "driverBody", label: "Driver body", hint: "Arms on the wheel and a body in the seat, in cars that have them", def: true },
              {
                kind: "segmented",
                id: "headMove",
                label: "Cockpit head movement",
                advanced: true,
                def: "natural",
                options: [
                  { id: "natural", label: "Natural" },
                  { id: "locked", label: "Locked" },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "hud",
        label: "HUD",
        cards: [
          {
            title: "Layout",
            rows: [
              {
                kind: "select",
                id: "hudStyle",
                label: "HUD style",
                def: "broadcast",
                options: [
                  { id: "broadcast", label: "Broadcast", detail: "Tower left, map right, inputs low" },
                  { id: "dash", label: "Dash", detail: "Everything around the wheel" },
                  { id: "minimal", label: "Minimal", detail: "Lap time and position" },
                  { id: "phone", label: "Phone", detail: "Clear of the touch pads" },
                ],
              },
              { kind: "slider", id: "hudScale", label: "HUD size", hint: "Each corner group scales about its own corner", def: 100, min: 75, max: 150, step: 5, format: pct },
              {
                kind: "segmented",
                id: "units",
                label: "Units",
                def: "metric",
                options: [
                  { id: "metric", label: "km/h" },
                  { id: "imperial", label: "mph" },
                ],
              },
            ],
          },
          {
            title: "Widgets",
            rows: [
              { kind: "toggle", id: "radar", label: "Proximity radar", hint: "Fades in when a car is alongside or within 25 m", def: true },
              { kind: "toggle", id: "deltaBar", label: "Delta bar", hint: "Live gap ribbon at the top, green while you gain on your best", def: true },
              { kind: "toggle", id: "inputTrace", label: "Input trace", hint: "Rolling throttle, brake and steering trace", def: false },
              { kind: "toggle", id: "lapSummary", label: "Lap summary card", hint: "Sectors, corner speeds and theoretical best after each lap", def: true },
              { kind: "toggle", id: "splitGaps", label: "Race split gaps", hint: "Time to the cars ahead and behind at the same point", def: true, advanced: true },
            ],
          },
          {
            title: "Timing",
            rows: [
              {
                kind: "segmented",
                id: "towerGaps",
                label: "Timing tower",
                def: "interval",
                options: [
                  { id: "interval", label: "Interval" },
                  { id: "leader", label: "To leader" },
                ],
              },
              {
                kind: "segmented",
                id: "mapMode",
                label: "Circuit map",
                def: "full",
                options: [
                  { id: "full", label: "Full lap" },
                  { id: "local", label: "Zoomed" },
                ],
              },
              { kind: "toggle", id: "mfdFold", label: "Auto-fold the MFD", hint: "Folds to its status pill 3.5 s after the last D-pad press", def: true, advanced: true },
            ],
          },
        ],
      },
      {
        id: "camera",
        label: "Camera",
        cards: [
          {
            title: "Camera",
            rows: [
              {
                kind: "select",
                id: "startCam",
                label: "Starting camera",
                def: "cockpit",
                options: [
                  { id: "cockpit", label: "Cockpit" },
                  { id: "bonnet", label: "Bonnet" },
                  { id: "chase", label: "Chase" },
                  { id: "far", label: "Chase far" },
                  { id: "tv", label: "TV cameras" },
                ],
              },
              { kind: "slider", id: "chaseDist", label: "Chase distance", def: 6, min: 3, max: 10, step: 0.5, format: (v) => `${v.toFixed(1)} m` },
              { kind: "toggle", id: "shake", label: "Camera shake", hint: "Kerbs and bumps move the view", def: true },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "controls",
    label: "Controls",
    icon: icon20(Gamepad2),
    tabs: [
      {
        id: "wheel",
        label: "Wheel",
        cards: [
          {
            title: "Force feedback",
            rows: [
              { kind: "slider", id: "ffb", label: "Force feedback strength", hint: "100% is the car's own weight at the rim", def: 100, min: 0, max: 150, step: 5, format: pct },
              { kind: "slider", id: "minForce", label: "Minimum force", hint: "Lifts small forces over the wheel's dead spot", def: 5, min: 0, max: 20, step: 1, format: pct, advanced: true },
              { kind: "slider", id: "damping", label: "Damping", def: 30, min: 0, max: 100, step: 5, format: pct, advanced: true },
              { kind: "toggle", id: "kerbVib", label: "Kerb vibration", def: true },
              { kind: "toggle", id: "slipVib", label: "Slip vibration", hint: "A buzz as the front tyres run out of grip", def: false },
            ],
          },
          {
            title: "Steering",
            rows: [
              { kind: "slider", id: "rotation", label: "Steering rotation", hint: "Match the setting in your wheel's own software", def: 540, min: 180, max: 1080, step: 10, format: deg },
              { kind: "stepper", id: "smoothing", label: "Steering smoothing", hint: "Frames averaged; more is smoother and later", def: 2, min: 0, max: 8, advanced: true },
            ],
          },
        ],
      },
      {
        id: "controller",
        label: "Controller",
        cards: [
          {
            title: "Sticks",
            rows: [
              { kind: "slider", id: "innerDz", label: "Inner dead zone", def: 8, min: 0, max: 30, step: 1, format: pct },
              { kind: "slider", id: "outerDz", label: "Outer dead zone", def: 4, min: 0, max: 30, step: 1, format: pct, advanced: true },
              { kind: "slider", id: "linearity", label: "Stick linearity", hint: "Above 1 is gentler near the centre", def: 1.4, min: 0.5, max: 3, step: 0.1, format: (v) => v.toFixed(1), advanced: true },
            ],
          },
          {
            title: "Rumble",
            rows: [
              { kind: "toggle", id: "rumble", label: "Gamepad rumble", def: true },
              { kind: "toggle", id: "trigRumble", label: "Impulse-trigger rumble", hint: "Xbox controllers", def: true, needs: { id: "rumble", reason: "Turn on Gamepad rumble first" } },
            ],
          },
        ],
      },
      {
        id: "keyboard",
        label: "Keyboard",
        cards: [
          {
            title: "Keyboard feel",
            rows: [
              { kind: "slider", id: "steerSpeed", label: "Steering speed", hint: "How fast the wheel turns while a key is held", def: 50, min: 10, max: 100, step: 5, format: pct },
              { kind: "slider", id: "steerReturn", label: "Steering return", hint: "How fast it centres when you let go", def: 60, min: 10, max: 100, step: 5, format: pct },
            ],
          },
          {
            title: "Key bindings",
            rows: [{ kind: "resetBindings", id: "resetBindings", label: "Reset key bindings", hint: "Puts every key back to the original layout" }],
          },
        ],
      },
    ],
  },
  {
    id: "audio",
    label: "Audio",
    icon: icon20(Volume2),
    tabs: [
      {
        id: "mix",
        label: "Mix",
        cards: [
          {
            title: "Volume",
            rows: [
              { kind: "slider", id: "master", label: "Master volume", def: 80, min: 0, max: 100, step: 5, format: pct },
              { kind: "slider", id: "engine", label: "Engine sound", def: 70, min: 0, max: 100, step: 5, format: pct },
              { kind: "slider", id: "tyres", label: "Tyre sound", def: 60, min: 0, max: 100, step: 5, format: pct, advanced: true },
              { kind: "toggle", id: "muteBg", label: "Mute in the background", hint: "When the game's tab or window is not in front", def: true },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "access",
    label: "Accessibility",
    icon: icon20(Accessibility),
    tabs: [
      {
        id: "vision",
        label: "Vision",
        cards: [
          {
            title: "Colour and motion",
            rows: [
              {
                kind: "select",
                id: "palette",
                label: "Colour-blind palette",
                hint: "Swaps gain and loss, and hot and cold, never the volt cursor",
                def: "off",
                options: [
                  { id: "off", label: "Off" },
                  { id: "deut", label: "Deuteranopia" },
                  { id: "prot", label: "Protanopia" },
                  { id: "trit", label: "Tritanopia" },
                ],
              },
              {
                kind: "segmented",
                id: "motion",
                label: "Reduce motion",
                def: "system",
                options: [
                  { id: "system", label: "System" },
                  { id: "on", label: "On" },
                  { id: "off", label: "Off" },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];

const allRows = (c: CategoryDef) => c.tabs.flatMap((t) => t.cards.flatMap((k) => k.rows));
const defOf = (r: RowDef): Value | undefined => ("def" in r ? r.def : undefined);
const DEFAULTS: Record<string, Value> = Object.fromEntries(
  CATEGORIES.flatMap(allRows)
    .filter((r) => defOf(r) !== undefined)
    .map((r) => [r.id, defOf(r) as Value]),
);
/** A first look with a few settings already moved, as a player's would be */
const START: Record<string, Value> = { ...DEFAULTS, renderScale: 85, ffb: 120, inputTrace: true, rumble: false };

const defaultText = (r: RowDef): string => {
  switch (r.kind) {
    case "toggle":
      return r.def ? "on" : "off";
    case "slider":
      return r.format(r.def);
    case "stepper":
      return r.format ? r.format(r.def) : String(r.def);
    case "segmented":
    case "select":
      return r.options.find((o) => o.id === r.def)?.label ?? r.def;
    default:
      return "";
  }
};

function SettingsDemo({ onToast }: { onToast: (message: string, tone: ToastTone) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [navActive, setNavActive] = useState(false);
  const [detail, setDetail] = useState<SettingsDetail>("simple");
  const [catId, setCatId] = useState(CATEGORIES[0].id);
  const [tabByCat, setTabByCat] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, Value>>(START);
  const [confirm, setConfirm] = useState(false);

  const category = CATEGORIES.find((c) => c.id === catId) ?? CATEGORIES[0];
  const tabId = tabByCat[category.id] ?? category.tabs[0].id;
  const tab = category.tabs.find((t) => t.id === tabId) ?? category.tabs[0];
  const set = (id: string, v: Value) => setValues((all) => ({ ...all, [id]: v }));
  const setTab = (id: string) => setTabByCat((all) => ({ ...all, [category.id]: id }));

  const changedIn = (c: CategoryDef) => allRows(c).filter((r) => "def" in r && values[r.id] !== r.def).length;
  const changedTotal = useMemo(
    () => CATEGORIES.reduce((n, c) => n + allRows(c).filter((r) => "def" in r && values[r.id] !== r.def).length, 0),
    [values],
  );

  // The screen's own navigation, live only while the focus is inside it (so it never takes the kit page's arrow keys)
  useFocusNav(rootRef, {
    enabled: navActive,
    autoFocus: false,
    onBack: () => {
      if (!focusInZone(rootRef.current, "settings-nav")) focusZone(rootRef.current, "settings-nav");
    },
    onPrevTab: () => switchTab(-1),
    onNextTab: () => switchTab(1),
  });

  // Between the tab strip and the cards the nearest-box search would drift sideways (the strip sits left, the
  // controls right): up from the top row goes to the strip, down from the strip to the pane's row
  useMoveHandler((dir) => {
    const root = rootRef.current;
    const active = document.activeElement as HTMLElement | null;
    if (!root || !active || !root.contains(active) || category.tabs.length < 2) return false;
    if (dir === "down" && focusInZone(root, "settings-tabs")) return focusZone(root, "settings-cards");
    const cards = root.querySelector('[data-nav-zone="settings-cards"]');
    if (dir !== "up" || !cards?.contains(active)) return false;
    const top = active.getBoundingClientRect().top;
    if (focusables(cards).some((el) => el.getBoundingClientRect().bottom <= top + 2)) return false;
    return focusZone(root, "settings-tabs");
  });

  /** Q / E (LB / RB): the next tab. A cursor on a row of the old tab moves to the new tab's first row */
  function switchTab(dir: 1 | -1) {
    if (category.tabs.length < 2) return;
    const inCards = focusInZone(rootRef.current, "settings-cards");
    setTab(adjacentTab(category.tabs, tabId, dir));
    refocusCards.current = inCards;
  }
  const refocusCards = useRef(false);
  useEffect(() => {
    if (!refocusCards.current) return;
    refocusCards.current = false;
    focusZone(rootRef.current, "settings-cards");
  }, [tab.id]);

  const renderRow = (r: RowDef, navDefault: boolean) => {
    const v = values[r.id];
    const blocked = r.needs ? values[r.needs.id] === false : false;
    const common = {
      label: r.label,
      hint: r.hint,
      advanced: r.advanced,
      navDefault,
      disabled: blocked,
      disabledReason: blocked ? r.needs?.reason : undefined,
      changed: "def" in r && v !== r.def,
      onReset: "def" in r ? () => set(r.id, r.def) : undefined,
      resetLabel: `Reset ${r.label.toLowerCase()} to ${defaultText(r)}`,
    };
    switch (r.kind) {
      case "toggle":
        return (
          <SettingRow key={r.id} {...common}>
            <Toggle checked={v === true} onChange={(c) => set(r.id, c)} />
          </SettingRow>
        );
      case "slider":
        return (
          <SettingRow key={r.id} {...common}>
            <Slider value={Number(v)} onChange={(n) => set(r.id, n)} min={r.min} max={r.max} step={r.step} format={r.format} defaultValue={r.def} />
          </SettingRow>
        );
      case "segmented":
        return (
          <SettingRow key={r.id} {...common}>
            <Segmented value={String(v)} onChange={(id) => set(r.id, id)} options={r.options} />
          </SettingRow>
        );
      case "select":
        return (
          <SettingRow key={r.id} {...common}>
            <Select value={String(v)} onChange={(id) => set(r.id, id)} options={r.options} />
          </SettingRow>
        );
      case "stepper":
        return (
          <SettingRow key={r.id} {...common}>
            <Stepper value={Number(v)} onChange={(n) => set(r.id, n)} min={r.min} max={r.max} format={r.format} />
          </SettingRow>
        );
      case "resetBindings":
        return (
          <SettingRow key={r.id} label={r.label} hint={r.hint} navDefault={navDefault}>
            <Button variant="danger" size="sm" icon={icon16(KeyRound)} onClick={() => setConfirm(true)}>
              Reset
            </Button>
          </SettingRow>
        );
    }
  };

  return (
    <div
      ref={rootRef}
      id="kit-core-settings"
      // React focus events also bubble out of portals (the open list, the dialog): only the screen's own DOM counts
      onFocusCapture={(e) => {
        if (rootRef.current?.contains(e.target as Node)) setNavActive(true);
      }}
      onBlurCapture={(e) => {
        if (!rootRef.current?.contains(e.target as Node)) return;
        const to = e.relatedTarget as Node | null;
        if (!to || !rootRef.current.contains(to)) setNavActive(false);
      }}
    >
      <Scene className="sm:p-8">
        <Sheet className="flex flex-col gap-5 p-5 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <h2 className="lc-h2">Settings</h2>
              <p className="lc-hint m-0" aria-live="polite">
                {changedTotal === 0
                  ? "Everything is at the default"
                  : `${changedTotal} ${changedTotal === 1 ? "setting" : "settings"} changed from the default`}
              </p>
            </div>
            <Segmented
              aria-label="Settings shown"
              size="sm"
              value={detail}
              onChange={setDetail}
              options={[
                { id: "simple", label: "Simple" },
                { id: "advanced", label: "Advanced" },
              ]}
            />
          </div>

          <div className="grid min-w-0 gap-5 md:grid-cols-[14rem_minmax(0,1fr)] lg:grid-cols-[15rem_minmax(0,1fr)]">
            <NavList
              aria-label="Settings categories"
              navZone="settings-nav"
              paneZone="settings-cards"
              panelId="kit-core-settings-pane"
              value={category.id}
              onChange={setCatId}
              className="md:self-start"
              items={CATEGORIES.map((c) => {
                const n = changedIn(c);
                return { id: c.id, label: c.label, icon: c.icon, count: n, countLabel: `${n} changed` };
              })}
            />

            <div id="kit-core-settings-pane" className="flex min-w-0 flex-col gap-4">
              {category.tabs.length > 1 ? (
                <Tabs
                  aria-label={`${category.label} sections`}
                  navZone="settings-tabs"
                  tabs={category.tabs.map((t) => ({ id: t.id, label: t.label }))}
                  value={tab.id}
                  onChange={setTab}
                  prevPrompt={<DemoKey>Q</DemoKey>}
                  nextPrompt={<DemoKey>E</DemoKey>}
                  className="max-w-xl"
                />
              ) : null}
              <SettingsDetailProvider value={detail}>
                <div data-nav-zone="settings-cards" className="flex min-w-0 flex-col gap-3">
                  {tab.cards.map((card, ci) => {
                    const advanced = card.rows.filter((r) => r.advanced);
                    const changed = card.rows.filter((r) => "def" in r && values[r.id] !== r.def);
                    return (
                      <Card
                        key={`${tab.id}-${card.title}`}
                        title={card.title}
                        action={
                          changed.length ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={icon16(RotateCcw)}
                              onClick={() =>
                                setValues((all) => {
                                  const next = { ...all };
                                  for (const r of changed) if ("def" in r) next[r.id] = r.def;
                                  return next;
                                })
                              }
                            >
                              Reset
                            </Button>
                          ) : null
                        }
                      >
                        {card.rows.map((r, ri) => renderRow(r, ci === 0 && ri === 0))}
                        {detail === "simple" && advanced.length ? (
                          <Disclosure moreLabel="More settings" lessLabel="Fewer settings" count={advanced.length}>
                            {advanced.map((r) => renderRow(r, false))}
                          </Disclosure>
                        ) : null}
                      </Card>
                    );
                  })}
                </div>
              </SettingsDetailProvider>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-5.5 gap-y-2 border-t border-lc-line pt-4 text-[13px] font-semibold text-lc-fog pointer-coarse:hidden">
            <span className="inline-flex items-center gap-2">
              <span className="inline-flex gap-1">
                <DemoKey label="Up">{icon16(ArrowUp)}</DemoKey>
                <DemoKey label="Down">{icon16(ArrowDown)}</DemoKey>
              </span>
              Move
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="inline-flex gap-1">
                <DemoKey label="Left">{icon16(ArrowLeft)}</DemoKey>
                <DemoKey label="Right">{icon16(ArrowRight)}</DemoKey>
              </span>
              Change
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="inline-flex gap-1">
                <DemoKey>Q</DemoKey>
                <DemoKey>E</DemoKey>
              </span>
              Switch tab
            </span>
            <span className="inline-flex items-center gap-2">
              <DemoKey>Enter</DemoKey>
              Select
            </span>
            <span className="inline-flex items-center gap-2">
              <DemoKey>Esc</DemoKey>
              Back
            </span>
          </div>
        </Sheet>
      </Scene>

      <ConfirmDialog
        open={confirm}
        title="Reset key bindings?"
        confirmLabel="Reset bindings"
        icon={<KeyRound size={24} strokeWidth={2} />}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          onToast("Key bindings are back to the original layout", "good");
        }}
      >
        Every key goes back to the original layout. The bindings you set for your controller and wheel stay.
      </ConfirmDialog>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------
 * The section
 * ---------------------------------------------------------------------------------------------------------------- */

/** The core control set: type roles, every control in every state, and a settings screen built from them */
export function CoreSection() {
  const { toasts, show } = useToasts();
  const toast = (message: string, tone: ToastTone) => show(message, { tone });
  return (
    <div className="flex flex-col gap-16">
      <TypeGroup />
      <ButtonGroup />
      <RowsGroup />
      <ChoicesGroup />
      <NavGroup />
      <FieldsGroup />
      <SurfacesGroup />
      <FeedbackGroup onToast={toast} />
      <EmptyListNote />
      <Group
        title="A settings screen"
        caption="Built only from the parts above: categories on the left, tabs, cards of rows. Simple hides the advanced rows behind a More row in each card. Click into it, then use the arrow keys, Enter, Q / E and Esc, or a controller."
      >
        <SettingsDemo onToast={toast} />
      </Group>
      <ToastRegion toasts={toasts} />
    </div>
  );
}

/** An empty state on its own, outside a card, as a list shows it */
function EmptyListNote() {
  return (
    <Group title="Empty lists" caption="One sentence that says what will appear and how to make it appear, and the action that does it.">
      <Scene>
        <Sheet>
          <EmptyState icon={icon20(Inbox)} action={<Button variant="secondary" icon={icon20(Search)}>Browse circuits</Button>}>
            Circuits you mark as favourites show up here. Mark one with Favourite in the circuit list.
          </EmptyState>
        </Sheet>
      </Scene>
    </Group>
  );
}
