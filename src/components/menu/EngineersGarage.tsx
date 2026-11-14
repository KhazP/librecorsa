"use client";

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { AeroSetupPreset, LiveTunerPatch, LiveTunerState, TireCompound } from "@/types/f1";
import { DEFAULT_CHASSIS_SETUP, loadGaragePresets, saveGaragePresets, type GaragePreset, type GarageTuner } from "@/lib/sim/car-setup";
import { setupSheet, type SetupGroup, type SetupParam, type SetupState } from "@/lib/sim/setup-sheet";
import type { PauseMenuProps } from "@/components/hud/PauseMenu";
import { Button, Card, IconButton, Segmented, SettingRow, Slider, Tabs, TextField, Toast } from "@/components/ui";
import { StatusDot } from "@/components/ui/Badge";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { COMPOUND_ORDER, COMPOUNDS } from "@/components/ui/badges/compounds";
import { Icon } from "@/components/ui/icons";
import { PadGlyph } from "@/components/ui/prompts";
import { TYRE_SETUP_LIMITS } from "@/lib/sim/tyre-setup";
import { useUnits } from "@/lib/settings/ui-prefs";
import { PRESSURE_LABEL, pressureDecimals, pressureIn } from "@/lib/settings/units";
import { CarPhysicsSwitch } from "./CarPicker";
import { CarBrowser } from "./CarBrowser";
import { CarClassTag, CarQualityBadge, CarSkinPicker, LiveryPicker } from "./menu-content-ui";
import { currentInputMode, useInputMode } from "./input-mode";
import { focusables, useMoveHandler } from "./useFocusNav";
import { carTakesPhysicsSwitch } from "@/lib/cars/f1-mod-physics";
import { TyreBrakeGrid } from "@/components/hud/TyreBrakeWidget";
import { LIVERIES } from "@/lib/track-data";
import { FACTORY_LIVERY_NOTE, carById, carClass, carTakesLivery } from "@/lib/cars/car-registry";
import { vehicleModelSpec } from "@/lib/cars/vehicle-models";

/** Short tab names for the pages whose full name would push the strip onto a second row */
const TAB_NAME: Record<string, string> = {
  Aerodynamics: "Aero",
  "Suspension geometry": "Geometry",
  "Mechanical grip": "Mechanical",
};

/** The `phone:` variant's query: phones either way up */
const PHONE_QUERY = "(max-width: 40rem), (max-height: 32rem)";
const subscribePhone = (cb: () => void) => {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const isPhone = () => window.matchMedia(PHONE_QUERY).matches;

const TIRE_COMPOUNDS: readonly TireCompound[] = ["soft", "medium", "hard", "intermediate", "wet"];
const AERO_PRESETS: readonly AeroSetupPreset[] = ["low_downforce", "balanced", "high_downforce"];

const FALLBACK_TUNER: Pick<
  LiveTunerState,
  "tcLevel" | "tc2Level" | "absLevel" | "brakeBiasPct" | "brakeMigrationPct" | "diffEntry" | "diffMid" | "diffExit" | "engineMap" | "hasErs"
> = { tcLevel: 5, tc2Level: 6, absLevel: 5, brakeBiasPct: 56, brakeMigrationPct: 2.5, diffEntry: 3, diffMid: 5, diffExit: 5, engineMap: 2, hasErs: true };

/** Changed from the car's baseline (the electronics have no fixed baseline: each car and assist level brings its own) */
const isChanged = (q: SetupParam, st: SetupState) => q.writes !== "tuner" && Math.abs(q.get(st) - q.base) > 1e-6;

/** The electronics' dials, named as on the MFD (the sheet's own labels name them differently) */
const DIAL_NAMES: Record<string, string> = {
  tcLevel: "Traction control (TC1)",
  tc2Level: "TC cut (TC2)",
  absLevel: "ABS",
  brakeBiasPct: "Brake bias",
  diffEntry: "Diff entry",
  diffExit: "Diff exit",
  engineMap: "Engine map",
};

/** Words for the assist preset, as Settings > Driving names them */
const ASSIST_WORDS: Record<string, string> = { pro: "Off", semi_pro: "TC + ABS", assisted: "Full" };

/** Effect texts without a leading arrow glyph (the sheet writes some with one) */
const plain = (t: string) => t.replace(/^[\u25B2\u25BC\u25B4\u25BE]\s*/, "");

/** Pressures are kept in psi (the sheet's grid); the read-out is in the player's unit */
const PSI_PER_BAR = pressureIn(1, "psi");
const PRESSURE_IDS = new Set(["psiFL", "psiFR", "psiRL", "psiRR"]);

/**
 * One setup row: the label, a hint, the slider with the baseline ticked. The hint says what the way the slider has
 * moved does; with the cursor on the row it says both ways. A changed row shows the dot and resets (Delete / pad X).
 */
const SetupRow: React.FC<{
  q: SetupParam;
  value: number;
  disabled: boolean;
  format: (v: number) => string;
  onChange: (v: number) => void;
}> = ({ q, value, disabled, format, onChange }) => {
  const tuner = q.writes === "tuner";
  const base = tuner ? undefined : q.base;
  // Without a baseline (the electronics' dials), the text follows the way the slider last moved
  const [moved, setMoved] = useState(0);
  const [near, setNear] = useState(false);
  const invert = q.invert ? -1 : 1;
  const dir = (base === undefined ? moved : Math.sign(value - base)) * invert;
  const right = invert > 0 ? q.fx.more : q.fx.less;
  const left = invert > 0 ? q.fx.less : q.fx.more;
  const hint = near ? `Right: ${plain(right)}. Left: ${plain(left)}.` : dir > 0 ? plain(q.fx.more) : dir < 0 ? plain(q.fx.less) : undefined;
  const changed = !tuner && Math.abs(value - q.base) > 1e-6;
  const change = (v: number) => {
    if (v !== value) setMoved(Math.sign(v - value));
    onChange(v);
  };
  return (
    <div
      onFocus={() => setNear(true)}
      onBlur={() => setNear(false)}
      onPointerEnter={() => setNear(true)}
      onPointerLeave={(e) => {
        if (!e.currentTarget.contains(document.activeElement)) setNear(false);
      }}
    >
      <SettingRow
        label={DIAL_NAMES[q.id] ?? q.label}
        hint={hint}
        disabled={disabled}
        changed={changed}
        onReset={changed ? () => change(q.base) : undefined}
        resetLabel={`Reset ${(DIAL_NAMES[q.id] ?? q.label).toLowerCase()} to the baseline, ${format(q.base)}`}
      >
        <Slider value={value} min={q.min} max={q.max} step={q.step} defaultValue={base} format={format} onChange={change} />
      </SettingRow>
    </div>
  );
};

/**
 * The Garage: the car's setup sheet (one layout for the open-wheelers, another for the GT3s, shared by every car of
 * the class), and named setups saved per car. Opened from the title menu's Garage and from the pause menu's Garage.
 */
export const EngineersGarage: React.FC<
  PauseMenuProps & {
    /** Change car opens this instead of the garage's own car browser (the title menu's Car panel) */
    onOpenCarBrowser?: () => void;
    /** Opens Settings at a category (the assists live in Settings > Driving) */
    onOpenSettings?: (category: "driving") => void;
  }
> = (p) => {
  const sheet = useMemo(() => setupSheet(p.vehicleModel, TYRE_SETUP_LIMITS[p.vehicleModel], p.defaultTyreSetup), [p.vehicleModel, p.defaultTyreSetup]);
  const [tabId, setTab] = useState(sheet[0].id);
  const group: SetupGroup = sheet.find((g) => g.id === tabId) ?? sheet[0];
  const chassis = p.chassisSetup ?? DEFAULT_CHASSIS_SETUP;
  const tuner = { ...FALLBACK_TUNER, ...(p.telemetry.liveTuner ?? {}) };
  const canTune = Boolean(p.onChangeLiveTuner);
  const canChassis = Boolean(p.onChangeChassisSetup);

  // Presets, per car
  const [presets, setPresets] = useState<GaragePreset[]>([]);
  const [name, setName] = useState("");
  // Each note is its own toast: the same text twice (Reset, Reset) restarts its timer. One that can be undone stays
  // until the next note or until it is dismissed: a player reading it must not lose the Undo to a timer
  const [note, setNoteState] = useState<{ text: string; seq: number; undo?: () => void } | null>(null);
  const noteSeq = useRef(0);
  const setNote = (text: string, undo?: () => void) => setNoteState({ text, seq: ++noteSeq.current, undo });
  useEffect(() => setPresets(loadGaragePresets(p.vehicleModel)), [p.vehicleModel]);
  useEffect(() => {
    if (!note || note.undo) return;
    const id = window.setTimeout(() => setNoteState(null), 2400);
    return () => window.clearTimeout(id);
  }, [note]);

  const currentTuner: GarageTuner = {
    tcLevel: tuner.tcLevel,
    tc2Level: tuner.tc2Level,
    absLevel: tuner.absLevel,
    brakeBiasPct: tuner.brakeBiasPct,
    brakeMigrationPct: tuner.brakeMigrationPct,
    diffEntry: tuner.diffEntry,
    diffMid: tuner.diffMid,
    diffExit: tuner.diffExit,
    engineMap: tuner.engineMap,
  };
  const st: SetupState = { chassis, tyre: p.tyreSetup, tuner: currentTuner };
  /** The whole setup as it stands, so an action that overwrites it can be undone */
  const snapshot = () => ({ chassis: { ...chassis }, tyre: p.tyreSetup, compound: p.tireCompound, aero: p.aeroPreset, tuner: { ...currentTuner } });
  const restore = (s: ReturnType<typeof snapshot>) => {
    p.onChangeChassisSetup?.(s.chassis);
    p.onChangeTyreSetup(s.tyre);
    p.onChangeTireCompound(s.compound);
    p.onChangeAeroPreset(s.aero);
    p.onChangeLiveTuner?.(s.tuner);
  };
  const canWrite = (q: SetupParam) => (q.writes === "chassis" ? canChassis : q.writes === "tuner" ? canTune : true);
  const apply = (q: SetupParam, v: number) => {
    const next = q.set(st, v);
    if (q.writes === "chassis") p.onChangeChassisSetup?.(next.chassis);
    else if (q.writes === "tyre") p.onChangeTyreSetup(next.tyre);
    else p.onChangeLiveTuner?.({ [q.id]: next.tuner[q.id as keyof GarageTuner] } as LiveTunerPatch);
  };
  /** The page's settings back at the car's baseline (the electronics stay as they are) */
  const resetGroup = (g: SetupGroup) => {
    const before = snapshot();
    let next = st;
    for (const q of g.params) if (q.writes !== "tuner") next = q.set(next, q.base);
    if (g.params.some((q) => q.writes === "chassis")) p.onChangeChassisSetup?.(next.chassis);
    if (g.params.some((q) => q.writes === "tyre")) p.onChangeTyreSetup(next.tyre);
    setNote(`${g.label} back to baseline`, () => restore(before));
  };

  const savePreset = () => {
    // An unnamed save gets the first free "Setup N": counting the list could land on a name already taken (after a
    // delete), and a matching name below means overwrite
    let label = name.trim();
    if (!label) {
      const taken = new Set(presets.map((x) => x.name.toLowerCase()));
      let n = presets.length + 1;
      while (taken.has(`setup ${n}`)) n++;
      label = `Setup ${n}`;
    }
    const existing = presets.find((x) => x.name.toLowerCase() === label.toLowerCase());
    const preset: GaragePreset = {
      id: existing?.id ?? `${Date.now().toString(36)}`,
      name: label.slice(0, 32),
      savedAt: Date.now(),
      vehicle: p.vehicleModel,
      chassis,
      tyre: p.tyreSetup,
      compound: p.tireCompound,
      aero: p.aeroPreset,
      tuner: currentTuner,
    };
    const next = [preset, ...presets.filter((x) => x.id !== preset.id)];
    setPresets(next);
    setName("");
    setNote(saveGaragePresets(p.vehicleModel, next) ? `Saved “${preset.name}”` : "Could not save: storage is blocked");
  };
  const loadPreset = (x: GaragePreset) => {
    const before = snapshot();
    // Saved presets come from storage: every value goes back through the sheet's own range (as the sliders would),
    // so a hand-edited or older preset cannot hand the car a value no slider can produce
    let loaded: SetupState = {
      chassis: x.chassis ?? chassis,
      tyre: x.tyre ?? p.tyreSetup,
      tuner: { ...currentTuner, ...(x.tuner ?? {}) },
    };
    for (const group of sheet) {
      for (const param of group.params) {
        const v = param.get(loaded);
        const safe = Number.isFinite(v) ? Math.min(param.max, Math.max(param.min, v)) : param.base;
        if (safe !== v) loaded = param.set(loaded, safe);
      }
    }
    p.onChangeChassisSetup?.(loaded.chassis);
    p.onChangeTyreSetup(loaded.tyre);
    if (TIRE_COMPOUNDS.includes(x.compound)) p.onChangeTireCompound(x.compound);
    if (AERO_PRESETS.includes(x.aero)) p.onChangeAeroPreset(x.aero);
    p.onChangeLiveTuner?.(loaded.tuner);
    setNote(`Loaded “${x.name}”`, () => restore(before));
  };
  const deletePreset = (x: GaragePreset) => {
    const before = presets;
    const next = presets.filter((y) => y.id !== x.id);
    setPresets(next);
    saveGaragePresets(p.vehicleModel, next);
    setNote(`Deleted “${x.name}”`, () => {
      setPresets(before);
      saveGaragePresets(p.vehicleModel, before);
    });
  };
  const resetAll = () => {
    const before = snapshot();
    p.onChangeChassisSetup?.({ ...DEFAULT_CHASSIS_SETUP });
    p.onChangeTyreSetup(p.defaultTyreSetup);
    p.onChangeAeroPreset("balanced");
    setNote("Every setting back to baseline", () => restore(before));
  };

  // The car browser takes the garage's place while it is open; Ⓑ / Esc (or Garage) comes back to the Change car button
  const [browsing, setBrowsing] = useState(false);
  const browseRef = useRef<HTMLButtonElement | null>(null);
  const { mode, family } = useInputMode();
  // The car is fixed for an online race (the shell refuses the swap too)
  const carLocked = p.telemetry.race?.multiplayer === true || p.raceRunning === true;
  const openBrowser = () => {
    if (carLocked) return;
    if (p.onOpenCarBrowser) return p.onOpenCarBrowser();
    flushSync(() => setBrowsing(true));
    if (currentInputMode() === "pointer") return;
    const card = document.querySelector<HTMLElement>(`[data-browser-item="${CSS.escape(p.carId)}"]`);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "nearest" });
  };
  const closeBrowser = () => {
    flushSync(() => setBrowsing(false));
    if (currentInputMode() !== "pointer") browseRef.current?.focus({ preventScroll: true });
  };
  const car = carById(p.carId);

  const changedIn = (g: SetupGroup) => g.params.filter((q) => isChanged(q, st)).length;
  const groupChanged = changedIn(group);
  const live = Boolean(group.extras?.includes("liveTyres"));

  const units = useUnits();
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const phone = useSyncExternalStore(subscribePhone, isPhone, () => false);
  // The page strip may wrap onto a second row: up / down leave the strip (down into the page, up to the car) instead
  // of walking into the other row, which would switch the page under the cursor
  useMoveHandler((dir) => {
    const active = document.activeElement;
    if (!active || !tabsRef.current?.contains(active) || (dir !== "up" && dir !== "down")) return false;
    const target = dir === "down" ? (pageRef.current ? focusables(pageRef.current)[0] : undefined) : browseRef.current;
    if (!target) return false;
    // A segmented row is entered on the option it is set to
    const chosen = target.closest('[role="radiogroup"]')?.querySelector<HTMLElement>('[aria-checked="true"]');
    (chosen ?? target).focus({ preventScroll: false, focusVisible: true } as FocusOptions);
    return true;
  });
  /** A pressure in the player's unit, the rest as the sheet writes them */
  const formatOf = (q: SetupParam) =>
    PRESSURE_IDS.has(q.id)
      ? (v: number) => `${pressureIn(v / PSI_PER_BAR, units.pressure).toFixed(pressureDecimals(units.pressure))} ${PRESSURE_LABEL[units.pressure]}`
      : q.format;

  const extra = (x: string) => {
    const onlyTyre = vehicleModelSpec(car.physics).onlyTyre;
    if (x === "compound" && onlyTyre)
      return <SettingRow key={x} label="Tyre compound" hint={`${onlyTyre}: this car runs on one compound`}>{null}</SettingRow>;
    if (x === "compound")
      return (
        <SettingRow key={x} label="Tyre compound" hint="The weather picks one for you; change it here" stacked>
          <Segmented<TireCompound>
            fill
            byContent
            value={p.tireCompound}
            onChange={p.onChangeTireCompound}
            options={COMPOUND_ORDER.map((c) => ({
              id: c,
              label: COMPOUNDS[c].name,
              icon: <CompoundGlyph compound={c} size={18} decorative />,
            }))}
          />
        </SettingRow>
      );
    if (x === "aeroPackage")
      return (
        <SettingRow key={x} label="Aero package" stacked>
          <Segmented<AeroSetupPreset>
            fill
            value={p.aeroPreset}
            onChange={p.onChangeAeroPreset}
            options={[
              { id: "low_downforce", label: "Low downforce" },
              { id: "balanced", label: "Balanced" },
              { id: "high_downforce", label: "High downforce" },
            ]}
          />
        </SettingRow>
      );
    if (x === "assists")
      // The TC & ABS preset lives in Settings > Driving now: the Garage shows it and links there
      return (
        <SettingRow key={x} label="Traction control & ABS" hint={`${ASSIST_WORDS[p.assistPreset] ?? p.assistPreset}, set in Settings`}>
          {p.onOpenSettings ? (
            <Button size="sm" variant="secondary" icon={<Icon name="settings" />} onClick={() => p.onOpenSettings?.("driving")}>
              Settings
            </Button>
          ) : null}
        </SettingRow>
      );
    return null;
  };

  const sheetClass =
    "lc-glass flex flex-col gap-3 rounded-lc-sheet p-5 text-lc-chalk sm:px-7 sm:pt-6 sm:pb-6.5 short:p-4 [.lc-title-frame_&]:border-0 [.lc-title-frame_&]:bg-transparent [.lc-title-frame_&]:p-0 [.lc-title-frame_&]:shadow-none [.lc-title-frame_&]:[backdrop-filter:none]";

  if (browsing) {
    return (
      <div className={sheetClass}>
        <CarBrowser
          carId={p.carId}
          onChangeCar={p.onChangeCar}
          selectedLivery={p.selectedLivery}
          onChangeLivery={p.onChangeLivery}
          library={p.library}
          onClose={closeBrowser}
          toolbar={
            /* A pointer / touch affordance: a controller steps back with Ⓑ, so the focus skips it */
            <Button
              size="md"
              variant="secondary"
              data-nav-skip=""
              onClick={closeBrowser}
              aria-label="Back to the Garage"
              prompt={mode === "pad" ? <PadGlyph button="b" family={family} /> : undefined}
              icon={mode === "pad" ? undefined : <Icon name="back" />}
            >
              Garage
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className={sheetClass}>
      {/* data-nav-columns: up / down read down the car card, then the saved setups (menu-shell's reading order) */}
      <div data-nav-columns="" className="grid items-start gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        {/* The car */}
        <Card
          title={car.title}
          description={`${carClass(car.classId).title}, ${car.year}`}
          action={
            <Button
              ref={browseRef}
              size="sm"
              variant="secondary"
              // Where the garage starts: the car, not the setup name field
              data-nav-default=""
              onClick={openBrowser}
              disabledReason={carLocked ? "The car is fixed for this race" : undefined}
              icon={<Icon name="car" />}
            >
              {carLocked ? "Fixed for this race" : "Change car"}
            </Button>
          }
        >
          <span className="flex flex-wrap gap-1.5 pb-1">
            <CarClassTag car={car} />
            <CarQualityBadge car={car} size="sm" />
          </span>
          {carTakesPhysicsSwitch(p.carId) ? <CarPhysicsSwitch /> : null}
          <SettingRow label="Livery" hint={!carTakesLivery(p.carId) && !car.skins?.length ? FACTORY_LIVERY_NOTE : undefined} stacked={Boolean(car.skins?.length || carTakesLivery(p.carId))}>
            {car.skins?.length ? (
              <CarSkinPicker carId={p.carId} surface="var(--color-lc-carbon)" />
            ) : carTakesLivery(p.carId) ? (
              <LiveryPicker liveries={LIVERIES} value={p.selectedLivery} onChange={p.onChangeLivery} surface="var(--color-lc-carbon)" />
            ) : null}
          </SettingRow>
        </Card>

        {/* Named setups */}
        <Card
          title="Saved setups"
          action={
            <Button size="sm" variant="ghost" icon={<Icon name="reset" />} onClick={resetAll} title="Every chassis setting, tyre pressure and camber back to the car's baseline">
              Reset all
            </Button>
          }
        >
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
            <TextField
              label="Name"
              value={name}
              onChange={setName}
              onKeyDown={(e) => {
                if (e.key === "Enter") savePreset();
              }}
              placeholder="Setup name"
              maxLength={32}
              autoComplete="off"
            />
            </div>
            <Button size="md" variant="secondary" onClick={savePreset} icon={<Icon name="add" />}>
              Save
            </Button>
          </div>
          {presets.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 pt-2">
              {presets.map((x) => (
                <li key={x.id} className="flex items-center gap-1">
                  <span className="min-w-0 flex-1">
                    <Button size="sm" variant="ghost" block onClick={() => loadPreset(x)} aria-label={`Load ${x.name}`}>
                      <span className="truncate">{x.name}</span>
                    </Button>
                  </span>
                  <IconButton size="sm" variant="ghost" aria-label={`Delete ${x.name}`} icon={<Icon name="delete" />} onClick={() => deletePreset(x)} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="lc-hint m-0 pt-1">Name a setup and save it to come back to it on this car.</p>
          )}
          {note ? (
            <div role="status" className="pt-2">
              <Toast
                tone="neutral"
                className="w-full"
                action={
                  note.undo ? (
                    <span className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          note.undo?.();
                          setNoteState(null);
                        }}
                      >
                        Undo
                      </Button>
                      <IconButton size="sm" variant="ghost" aria-label="Dismiss" icon={<Icon name="close" />} onClick={() => setNoteState(null)} />
                    </span>
                  ) : undefined
                }
              >
                {note.text}
              </Toast>
            </div>
          ) : null}
        </Card>
      </div>

      {/* The sheet's pages */}
      <div ref={tabsRef} className="min-w-0">
      <Tabs<string>
        aria-label="Garage pages"
        navZone="garage-pages"
        // One row always: the tabs share the width (short names for the long pages); on a phone, and wherever they
        // still do not fit, the strip scrolls sideways
        fill={!phone}
        size="sm"
        value={group.id}
        onChange={setTab}
        tabs={sheet.map((g) => {
          const n = changedIn(g);
          const short = TAB_NAME[g.label];
          return {
            id: g.id,
            label: short ?? g.label,
            title: short ? g.label : undefined,
            badge: n ? <StatusDot tone="info" label={`${n} changed`} /> : undefined,
          };
        })}
      />
      </div>

      <div ref={pageRef} className={`grid items-start gap-3 ${live ? "xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]" : ""}`}>
        <Card
          aria-label={group.label}
          action={
            groupChanged ? (
              <Button size="sm" variant="ghost" icon={<Icon name="reset" />} onClick={() => resetGroup(group)} title="This page back to the car's baseline">
                Reset page ({groupChanged})
              </Button>
            ) : undefined
          }
        >
          {group.extras?.map(extra)}
          {group.params.map((q) => (
            <SetupRow key={q.id} q={q} value={q.get(st)} disabled={!canWrite(q)} format={formatOf(q)} onChange={(v) => apply(q, v)} />
          ))}
        </Card>
        {live ? (
          <Card title="Tyres and brakes now">
            <TyreBrakeGrid t={p.telemetry} compound={p.tireCompound} dense />
          </Card>
        ) : null}
      </div>
    </div>
  );
};
