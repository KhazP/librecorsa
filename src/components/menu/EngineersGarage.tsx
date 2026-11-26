"use client";

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { useTranslations } from "use-intl/react";
import type { AeroSetupPreset, LiveTunerPatch, LiveTunerState, TireCompound } from "@/types/f1";
import {
  DEFAULT_CHASSIS_SETUP,
  FACTORY_PRESETS,
  GARAGE_PRESETS_MAX,
  loadGaragePresets,
  saveGaragePresets,
  type FactoryPreset,
  type GaragePreset,
  type GarageTuner,
} from "@/lib/sim/car-setup";
import { clampSetupToSheet, setupSheet, type SetupGroup, type SetupParam, type SetupState } from "@/lib/sim/setup-sheet";
import {
  buildSharedSetup,
  copyTextToClipboard,
  decodeSetupShareCode,
  encodeSetupShareCode,
  exportSetupFile,
  presetToSharedSetup,
  resolveSetupForCar,
  summarizeSharedSetup,
  type SharedCarSetup,
} from "@/lib/sim/setup-share";
import { clampTyreSetup, TYRE_SETUP_LIMITS } from "@/lib/sim/tyre-setup";
import type { PauseMenuProps } from "@/components/hud/PauseMenu";
import { Button, Card, IconButton, Segmented, SettingRow, Slider, Tabs, TextField, Toast } from "@/components/ui";
import { StatusDot } from "@/components/ui/Badge";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { COMPOUND_ORDER, COMPOUNDS } from "@/components/ui/badges/compounds";
import { Icon } from "@/components/ui/icons";
import { PadGlyph } from "@/components/ui/prompts";
import { useUnits } from "@/lib/settings/ui-prefs";
import { PRESSURE_LABEL, pressureDecimals, pressureIn } from "@/lib/settings/units";
import { CarPhysicsSwitch } from "./CarPicker";
import { CarBrowser, CarThumb } from "./CarBrowser";
import { carBoardTag, CarClassTag, CarQualityBadge, CarSkinPicker, LiveryPicker } from "./menu-content-ui";
import { currentInputMode, useInputMode } from "./input-mode";
import { focusables, useMoveHandler } from "./useFocusNav";
import { carTakesPhysicsSwitch } from "@/lib/cars/f1-mod-physics";
import { TyreBrakeGrid } from "@/components/hud/TyreBrakeWidget";
import { liveriesForCar } from "@/lib/track-data";
import { FACTORY_LIVERY_NOTE, carById, carClass, carTakesLivery, type CarId } from "@/lib/cars/car-registry";
import { vehicleModelSpec } from "@/lib/cars/vehicle-models";

/** Short tab names (message keys) for the pages whose full name would push the strip onto a second row, by page id */
const TAB_NAME = { aero: "tabAero", geometry: "tabGeometry", mechanical: "tabMechanical" } as const;

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
const AERO_PRESET_HINT = {
  low_downforce: "lowDownforceHint",
  balanced: "balancedHint",
  high_downforce: "highDownforceHint",
} as const satisfies Record<AeroSetupPreset, string>;

const FALLBACK_TUNER: Pick<
  LiveTunerState,
  "tcLevel" | "tc2Level" | "absLevel" | "brakeBiasPct" | "brakeMigrationPct" | "diffEntry" | "diffMid" | "diffExit" | "engineMap" | "hasErs"
> = { tcLevel: 5, tc2Level: 6, absLevel: 5, brakeBiasPct: 56, brakeMigrationPct: 2.5, diffEntry: 3, diffMid: 5, diffExit: 5, engineMap: 2, hasErs: true };

/** Changed from the car's baseline (the electronics have no fixed baseline: each car and assist level brings its own) */
const isChanged = (q: SetupParam, st: SetupState) => q.writes !== "tuner" && Math.abs(q.get(st) - q.base) > 1e-6;

/** The electronics' dials, named as on the MFD (the sheet's own labels name them differently): message keys by param id */
const DIAL_NAMES = {
  tcLevel: "dialTc",
  tc2Level: "dialTc2",
  absLevel: "dialAbs",
  brakeBiasPct: "dialBias",
  diffEntry: "dialDiffEntry",
  diffExit: "dialDiffExit",
  engineMap: "dialEngineMap",
} as const;
const dialKey = (id: string) => (Object.hasOwn(DIAL_NAMES, id) ? DIAL_NAMES[id as keyof typeof DIAL_NAMES] : null);

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
  const tx = useTranslations("menu.garage");
  const tuner = q.writes === "tuner";
  const base = tuner ? undefined : q.base;
  // Without a baseline (the electronics' dials), the text follows the way the slider last moved
  const [moved, setMoved] = useState(0);
  const [near, setNear] = useState(false);
  const invert = q.invert ? -1 : 1;
  const dir = (base === undefined ? moved : Math.sign(value - base)) * invert;
  const right = invert > 0 ? q.fx.more : q.fx.less;
  const left = invert > 0 ? q.fx.less : q.fx.more;
  const hint = near ? tx("hintBothWays", { right: plain(right), left: plain(left) }) : dir > 0 ? plain(q.fx.more) : dir < 0 ? plain(q.fx.less) : undefined;
  const dial = dialKey(q.id);
  const label = dial ? tx(dial) : q.label;
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
        label={label}
        hint={hint}
        disabled={disabled}
        changed={changed}
        onReset={changed ? () => change(q.base) : undefined}
        resetLabel={tx("resetRow", { setting: label.toLowerCase(), value: format(q.base) })}
      >
        {q.toggle ? (
          <Segmented<"off" | "on">
            value={value >= 1 ? "on" : "off"}
            onChange={(id) => change(id === "on" ? 1 : 0)}
            options={[
              { id: "off", label: tx("toggleOff") },
              { id: "on", label: tx("toggleOn") },
            ]}
          />
        ) : (
          <Slider value={value} min={q.min} max={q.max} step={q.step} defaultValue={base} format={format} onChange={change} />
        )}
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
  const tx = useTranslations("menu.garage");
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
  const [importOpen, setImportOpen] = useState(false);
  const [importCode, setImportCode] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);
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
    tcSlipAngleLevel: tuner.tcSlipAngleLevel,
    absLevel: tuner.absLevel,
    brakeBiasPct: tuner.brakeBiasPct,
    brakeMigrationPct: tuner.brakeMigrationPct,
    diffEntry: tuner.diffEntry,
    diffMid: tuner.diffMid,
    diffExit: tuner.diffExit,
    engineMap: tuner.engineMap,
    // The hybrid's kW dials, on a car with them (null: none)
    ...(tuner.motorDeployKw != null ? { motorDeployKw: tuner.motorDeployKw } : {}),
    ...(tuner.regenKw != null ? { regenKw: tuner.regenKw } : {}),
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
    setNote(tx("pageReset", { page: g.label }), () => restore(before));
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
    // A full list takes no new setup (it would push the oldest out unseen); a save over an existing name still works
    if (!existing && presets.length >= GARAGE_PRESETS_MAX) {
      setNote(tx("listFull", { max: GARAGE_PRESETS_MAX }));
      return;
    }
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
    const next = [preset, ...presets.filter((x) => x.id !== preset.id)].slice(0, GARAGE_PRESETS_MAX);
    setPresets(next);
    setName("");
    setNote(saveGaragePresets(p.vehicleModel, next) ? tx("saved", { name: preset.name }) : tx("saveBlocked"));
  };
  const loadPreset = (x: GaragePreset) => {
    const before = snapshot();
    // Saved presets come from storage: every value goes back through the sheet's own range (as the sliders would),
    // so a hand-edited or older preset cannot hand the car a value no slider can produce
    const loaded = clampSetupToSheet(
      p.vehicleModel,
      {
        chassis: x.chassis ?? chassis,
        tyre: x.tyre ?? p.tyreSetup,
        tuner: { ...currentTuner, ...(x.tuner ?? {}) },
      },
      TYRE_SETUP_LIMITS[p.vehicleModel],
      p.defaultTyreSetup,
    );
    p.onChangeChassisSetup?.(loaded.chassis);
    p.onChangeTyreSetup(loaded.tyre);
    if (TIRE_COMPOUNDS.includes(x.compound)) p.onChangeTireCompound(x.compound);
    if (AERO_PRESETS.includes(x.aero)) p.onChangeAeroPreset(x.aero);
    p.onChangeLiveTuner?.(loaded.tuner);
    setNote(tx("loaded", { name: x.name }), () => restore(before));
  };
  /** A factory setup: the car's baseline with the preset's changes, loaded as a saved one is */
  const loadFactoryPreset = (f: FactoryPreset) =>
    loadPreset({
      id: f.id,
      name: f.name,
      savedAt: 0,
      vehicle: p.vehicleModel,
      chassis: { ...DEFAULT_CHASSIS_SETUP, ...f.chassis },
      tyre: { ...p.defaultTyreSetup, camberDeg: f.camberDeg ?? p.defaultTyreSetup.camberDeg },
      compound: p.tireCompound,
      aero: f.aero,
      tuner: {},
    });
  const factoryPresets = FACTORY_PRESETS[p.vehicleModel] ?? [];
  const decodedImport = useMemo(
    () => (importCode.trim() ? decodeSetupShareCode(importCode) : null),
    [importCode],
  );
  const currentSharedSetup = (): SharedCarSetup =>
    buildSharedSetup({
      vehicle: p.vehicleModel,
      name: name.trim() || undefined,
      chassis,
      tyre: p.tyreSetup,
      compound: p.tireCompound,
      aero: p.aeroPreset,
      tuner: currentTuner,
    });
  /** `copied` is the note once the code is on the clipboard */
  const copyShareCode = async (setup: SharedCarSetup, tag: string, copied: string) => {
    const code = encodeSetupShareCode(setup);
    const ok = await copyTextToClipboard(code);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    if (ok) {
      setCopiedId(tag);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopiedId(null);
      }, 2000);
      setNote(copied);
    } else {
      setCopiedId(null);
      setNote(tx("copyFailed"));
    }
  };
  const applySharedSetup = (shared: SharedCarSetup, save = false) => {
    const resolved = resolveSetupForCar(
      shared,
      p.vehicleModel,
      p.tyreSetup,
      (t) => clampTyreSetup(p.vehicleModel, t),
      p.tireCompound,
      p.aeroPreset,
      currentTuner,
      chassis.fuelDeltaKg,
    );
    const rawLabel = (shared.name || `Imported (${carBoardTag(shared.vehicle).label})`).slice(0, 32);
    // Avoid overwriting an existing user preset on name collision when saving an imported setup
    let finalName = rawLabel;
    if (save) {
      const taken = new Set(presets.map((x) => x.name.toLowerCase()));
      if (taken.has(finalName.toLowerCase())) {
        let n = 2;
        while (n < 100) {
          const suffix = ` (${n})`;
          const candidate = `${rawLabel.slice(0, 32 - suffix.length)}${suffix}`;
          if (!taken.has(candidate.toLowerCase())) {
            finalName = candidate;
            break;
          }
          n++;
        }
      }
    }
    const asPreset: GaragePreset = {
      id: `${Date.now().toString(36)}`,
      name: finalName,
      savedAt: Date.now(),
      vehicle: p.vehicleModel,
      chassis: resolved.chassis,
      tyre: resolved.tyre,
      compound: resolved.compound,
      aero: resolved.aero,
      tuner: resolved.tuner,
    };
    const before = snapshot();
    loadPreset(asPreset);
    if (save) {
      if (presets.length >= GARAGE_PRESETS_MAX) {
        setNote(tx("appliedListFull", { name: finalName, max: String(GARAGE_PRESETS_MAX) }), () => restore(before));
      } else {
        const next = [asPreset, ...presets].slice(0, GARAGE_PRESETS_MAX);
        setPresets(next);
        if (!saveGaragePresets(p.vehicleModel, next)) {
          setNote(tx("appliedSaveBlocked", { name: finalName }), () => restore(before));
        }
      }
    }
    setImportCode("");
    setImportOpen(false);
  };
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || file.size > 64 * 1024) {
      if (file) setNote(tx("fileTooLarge"));
      return;
    }
    try {
      const text = await file.text();
      const parsed = decodeSetupShareCode(text);
      if (!parsed) {
        setNote(tx("fileInvalid"));
        return;
      }
      setImportCode(encodeSetupShareCode(parsed));
      setImportOpen(true);
    } catch {
      setNote(tx("fileUnreadable"));
    }
  };
  const deletePreset = (x: GaragePreset) => {
    const before = presets;
    const next = presets.filter((y) => y.id !== x.id);
    setPresets(next);
    saveGaragePresets(p.vehicleModel, next);
    setNote(tx("deleted", { name: x.name }), () => {
      setPresets(before);
      saveGaragePresets(p.vehicleModel, before);
    });
  };
  const resetAll = () => {
    const before = snapshot();
    p.onChangeChassisSetup?.({ ...DEFAULT_CHASSIS_SETUP });
    p.onChangeTyreSetup(p.defaultTyreSetup);
    p.onChangeAeroPreset("balanced");
    setNote(tx("allReset"), () => restore(before));
  };

  // The car browser takes the garage's place while it is open; Ⓑ / Esc (or Garage) comes back to the Change car button
  const [browsing, setBrowsing] = useState(false);
  const browseRef = useRef<HTMLButtonElement | null>(null);
  const { mode, family } = useInputMode();
  // The car is fixed for an online race and for a career drive, the season's (the shell refuses the swap too)
  const careerCar = p.careerDrive === true;
  const carLocked = careerCar || p.telemetry.race?.multiplayer === true || p.raceRunning === true;
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
  const [hoveredLivery, setHoveredLivery] = useState<{ carId: CarId; id: string } | null>(null);
  const [hoveredSkin, setHoveredSkin] = useState<{ carId: CarId; id: string } | null>(null);
  const previewLiveryId = carTakesLivery(p.carId)
    ? hoveredLivery?.carId === p.carId
      ? hoveredLivery.id
      : p.selectedLivery.id
    : undefined;
  const previewSkinId = car.skins?.length && hoveredSkin?.carId === p.carId ? hoveredSkin.id : undefined;

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
      return <SettingRow key={x} label={tx("tyreCompound")} hint={tx("specCompound", { tyre: onlyTyre })}>{null}</SettingRow>;
    if (x === "compound")
      return (
        <SettingRow key={x} label={tx("tyreCompound")} stacked>
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
        <SettingRow key={x} label={tx("aeroPackage")} hint={tx(AERO_PRESET_HINT[p.aeroPreset])} stacked>
          <Segmented<AeroSetupPreset>
            fill
            value={p.aeroPreset}
            onChange={p.onChangeAeroPreset}
            options={[
              { id: "low_downforce", label: tx("lowDownforce"), title: tx("lowDownforceHint") },
              { id: "balanced", label: tx("balanced"), title: tx("balancedHint") },
              { id: "high_downforce", label: tx("highDownforce"), title: tx("highDownforceHint") },
            ]}
          />
        </SettingRow>
      );
    if (x === "assists") {
      // Words for the assist preset, as Settings > Driving names them
      const assistWords: Record<string, string> = { pro: tx("assistOff"), semi_pro: tx("assistTcAbs"), assisted: tx("assistFull") };
      const assists = assistWords[p.assistPreset] ?? p.assistPreset;
      // The TC & ABS preset lives in Settings > Driving now: the Garage shows it and links there
      return (
        <SettingRow
          key={x}
          label={tx("assists")}
          hint={
            // A class without ABS runs the middle preset on TC alone, and ABS only on Full
            tuner.absAllowed === false
              ? tx("noFactoryAbs", { assists: p.assistPreset === "semi_pro" ? tx("tcOnly") : assists })
              : assists
          }
        >
          {p.onOpenSettings ? (
            <Button size="sm" variant="secondary" icon={<Icon name="settings" />} onClick={() => p.onOpenSettings?.("driving")}>
              {tx("settings")}
            </Button>
          ) : null}
        </SettingRow>
      );
    }
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
              aria-label={tx("backAria")}
              prompt={mode === "pad" ? <PadGlyph button="b" family={family} /> : undefined}
              icon={mode === "pad" ? undefined : <Icon name="back" />}
            >
              {tx("back")}
            </Button>
          }
        />
      </div>
    );
  }

  // A car with liveries or skins to pick: the picker sits beside the picture (it previews on it), not under it
  const hasPicker = Boolean(car.skins?.length || carTakesLivery(p.carId));

  return (
    <div className={sheetClass}>
      {/* The car, across the sheet: its picture and badges on the left, the livery on the right, so neither card stands
          beside an empty block (the car and the saved setups grow by different amounts per car and per list).
          data-nav-columns: up / down read down the left column (the physics switch), then the livery */}
      <Card
        title={car.title}
        description={tx("carFacts", { carClass: carClass(car.classId).title, year: String(car.year) })}
        action={
          <Button
            ref={browseRef}
            size="sm"
            variant="secondary"
            // Where the garage starts: the car, not the setup name field
            data-nav-default=""
            onClick={openBrowser}
            disabledReason={careerCar ? tx("carSeasonReason") : carLocked ? tx("carFixedReason") : undefined}
            icon={<Icon name="car" />}
          >
            {careerCar ? tx("carSeason") : carLocked ? tx("carFixed") : tx("changeCar")}
          </Button>
        }
      >
        <div
          data-nav-columns=""
          className={`grid items-start gap-x-5 gap-y-1 ${hasPicker ? "sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]" : ""}`}
        >
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex flex-wrap gap-1.5 pb-1">
              <CarClassTag car={car} />
              <CarQualityBadge car={car} size="sm" />
            </span>
            {carTakesPhysicsSwitch(p.carId) ? <CarPhysicsSwitch /> : null}
            {/* Shorter on a landscape phone, so a setting shows on the first screen under it */}
            <span className="relative my-1 block aspect-video max-h-44 w-full overflow-hidden rounded-lc-tile bg-lc-well short:max-h-28 [&>img]:size-full">
              <CarThumb car={car} liveryId={previewLiveryId} skinId={previewSkinId} className="p-2" />
            </span>
          </div>
          <SettingRow label={tx("livery")} hint={!hasPicker ? FACTORY_LIVERY_NOTE : undefined} stacked={hasPicker}>
            {car.skins?.length ? (
              <CarSkinPicker
                carId={p.carId}
                onHover={(skinId) =>
                  setHoveredSkin((prev) =>
                    skinId ? { carId: p.carId, id: skinId } : prev?.carId === p.carId ? null : prev,
                  )
                }
                surface="var(--color-lc-carbon)"
              />
            ) : carTakesLivery(p.carId) ? (
              <LiveryPicker
                liveries={liveriesForCar(p.carId)}
                value={p.selectedLivery}
                onChange={p.onChangeLivery}
                onHover={(livery) =>
                  setHoveredLivery((prev) =>
                    livery ? { carId: p.carId, id: livery.id } : prev?.carId === p.carId ? null : prev,
                  )
                }
                surface="var(--color-lc-carbon)"
              />
            ) : null}
          </SettingRow>
        </div>
      </Card>

      {/* Named setups: across the sheet too, the name field and its actions on one line where they fit */}
      <Card
        title={tx("savedSetups")}
        action={
          <Button size="sm" variant="ghost" icon={<Icon name="reset" />} onClick={resetAll} title={tx("resetAllTitle")}>
            {tx("resetAll")}
          </Button>
        }
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-0 flex-[1_1_18rem] items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextField
                label={tx("name")}
                value={name}
                onChange={setName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") savePreset();
                }}
                placeholder={tx("namePlaceholder")}
                maxLength={32}
                autoComplete="off"
              />
            </div>
            <Button size="md" variant="secondary" onClick={savePreset} icon={<Icon name="add" />}>
              {tx("save")}
            </Button>
          </div>
          {/* The field's height (44 px), so the row reads as one line beside it */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="md"
              variant="secondary"
              icon={<Icon name={copiedId === "current" ? "copied" : "share"} />}
              onClick={() => void copyShareCode(currentSharedSetup(), "current", tx("copiedCurrent"))}
              title={tx("shareCodeTitle")}
            >
              {copiedId === "current" ? tx("shareCodeCopied") : tx("shareCode")}
            </Button>
            <Button
              size="md"
              variant={importOpen ? "primary" : "secondary"}
              icon={<Icon name="copy" />}
              onClick={() => setImportOpen((o) => !o)}
              aria-expanded={importOpen}
            >
              {tx("import")}
            </Button>
            <IconButton
              size="md"
              variant="secondary"
              icon={<Icon name="download" />}
              aria-label={tx("exportAria")}
              title={tx("exportTitle")}
              onClick={() => {
                exportSetupFile(currentSharedSetup(), car.title);
                setNote(tx("exported"));
              }}
            />
          </div>
        </div>
        {importOpen ? (
          <div className="mt-2 flex flex-col gap-2 rounded-lc-tile border border-lc-line bg-lc-well/80 p-3">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextField
                  label={tx("pasteLabel")}
                  value={importCode}
                  onChange={setImportCode}
                  placeholder="LC1-..."
                  autoComplete="off"
                />
              </div>
              <Button size="sm" variant="secondary" onClick={() => importFileRef.current?.click()}>
                {tx("loadFile")}
              </Button>
              <input
                ref={importFileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => void handleImportFile(e)}
              />
            </div>
            {importCode.trim() ? (
              decodedImport ? (
                <div className="flex flex-col gap-2 rounded-lc-row border border-white/10 bg-lc-carbon/80 p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-semibold text-lc-chalk">
                      {decodedImport.name ?? tx("sharedSetup")}
                    </span>
                    <span className="lc-mono text-[11px] font-semibold text-lc-fog">
                      {carBoardTag(decodedImport.vehicle).label}
                    </span>
                  </div>
                  <p className="lc-hint m-0">{summarizeSharedSetup(decodedImport)}</p>
                  {decodedImport.vehicle !== p.vehicleModel ? (
                    <p className="m-0 text-[12px] text-lc-caution">
                      {tx("builtFor", { car: carBoardTag(decodedImport.vehicle).label })}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    <Button size="sm" variant="primary" onClick={() => applySharedSetup(decodedImport, false)}>
                      {tx("apply")}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => applySharedSetup(decodedImport, true)}>
                      {tx("saveApply")}
                    </Button>
                  </div>
                </div>
              ) : (
                <p role="alert" className="m-0 text-[12px] text-lc-loss">
                  {tx("invalidCode")}
                </p>
              )
            ) : null}
          </div>
        ) : null}
        {presets.length > 0 || factoryPresets.length > 0 ? (
          // Two columns across a wide sheet, so a row is not a line of empty ghost button
          <ul className="m-0 grid list-none grid-cols-1 gap-x-3 gap-y-1 p-0 pt-2 md:grid-cols-2">
            {/* The car's own setups first, which cannot be deleted */}
            {factoryPresets.map((f) => (
              <li key={f.id} className="flex items-center gap-1">
                <span className="min-w-0 flex-1">
                  <Button size="sm" variant="ghost" block onClick={() => loadFactoryPreset(f)} aria-label={tx("loadFactoryAria", { name: f.name })}>
                    <span className="truncate">{f.name}</span>
                    <span className="lc-hint ms-2 shrink-0">{tx("factory")}</span>
                  </Button>
                </span>
              </li>
            ))}
            {presets.map((x) => (
              <li key={x.id} className="flex items-center gap-1">
                <span className="min-w-0 flex-1">
                  <Button size="sm" variant="ghost" block onClick={() => loadPreset(x)} aria-label={tx("loadAria", { name: x.name })}>
                    <span className="truncate" title={x.name}>{x.name}</span>
                  </Button>
                </span>
                <IconButton
                  size="sm"
                  variant="ghost"
                  aria-label={tx("copyAria", { name: x.name })}
                  title={tx("copyTitle")}
                  icon={<Icon name={copiedId === x.id ? "copied" : "share"} />}
                  onClick={() => void copyShareCode(presetToSharedSetup(x), x.id, tx("copiedPreset", { name: x.name }))}
                />
                <IconButton size="sm" variant="ghost" aria-label={tx("deleteAria", { name: x.name })} icon={<Icon name="delete" />} onClick={() => deletePreset(x)} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="lc-hint m-0 pt-1">{tx("noSetups")}</p>
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
                      {tx("undo")}
                    </Button>
                    <IconButton size="sm" variant="ghost" aria-label={tx("dismiss")} icon={<Icon name="close" />} onClick={() => setNoteState(null)} />
                  </span>
                ) : undefined
              }
            >
              {note.text}
            </Toast>
          </div>
        ) : null}
      </Card>

      {/* The sheet's pages */}
      <div ref={tabsRef} className="min-w-0">
      <Tabs<string>
        aria-label={tx("pages")}
        navZone="garage-pages"
        // One row always: the tabs share the width (short names for the long pages); on a phone, and wherever they
        // still do not fit, the strip scrolls sideways
        fill={!phone}
        size="sm"
        value={group.id}
        onChange={setTab}
        tabs={sheet.map((g) => {
          const n = changedIn(g);
          const shortKey = Object.hasOwn(TAB_NAME, g.id) ? TAB_NAME[g.id as keyof typeof TAB_NAME] : null;
          // A page whose own name is already short keeps it (the GT3s' Aero)
          const short = shortKey && tx(shortKey) !== g.label ? tx(shortKey) : undefined;
          return {
            id: g.id,
            label: short ?? g.label,
            title: short ? g.label : undefined,
            badge: n ? <StatusDot tone="info" label={tx("changed", { count: n })} /> : undefined,
          };
        })}
      />
      </div>

      <div ref={pageRef} className={`grid items-start gap-3 ${live ? "xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]" : ""}`}>
        <Card
          aria-label={group.label}
          action={
            groupChanged ? (
              <Button size="sm" variant="ghost" icon={<Icon name="reset" />} onClick={() => resetGroup(group)} title={tx("resetPageTitle")}>
                {tx("resetPage", { count: String(groupChanged) })}
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
          <Card title={tx("tyresNow")}>
            <TyreBrakeGrid t={p.telemetry} compound={p.tireCompound} dense />
          </Card>
        ) : null}
      </div>
    </div>
  );
};
