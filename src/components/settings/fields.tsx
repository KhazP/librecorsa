"use client";

import React, { useState } from "react";
import {
  Button,
  Card,
  ConfirmDialog,
  OptionTile,
  OptionTileGroup,
  Segmented,
  Select,
  SettingRow,
  Slider,
  Toggle,
  useReportAdvanced,
  useSettingsDetail,
} from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import { DEFAULT_PLAYER_SETTINGS, type PlayerSettings } from "@/lib/settings/player-settings";
import { useSettingsEnv, type SettingsEnv } from "./env";

/**
 * One definition per setting: its label, hint, control, how to read and write it and its default. The Settings
 * screen and first-run setup draw the same definition, so a setting has one label and one control everywhere.
 */

type Text = string | ((env: SettingsEnv) => string | undefined);

interface RowBase<T> {
  id: string;
  label: string;
  hint?: Text;
  /** Hidden in Simple mode */
  advanced?: boolean;
  /** Why the row cannot be used right now (missing hardware); null or undefined when it can */
  off?: (env: SettingsEnv) => string | null | undefined;
  // Method syntax on purpose: a row of a narrower value type (a union of ids) still fits
  read(env: SettingsEnv): T;
  write(env: SettingsEnv, value: T): void;
  initial(env: SettingsEnv): T;
}

export interface ToggleDef extends RowBase<boolean> {
  kind: "toggle";
}

export interface SliderDef extends RowBase<number> {
  kind: "slider";
  min: number;
  max: number | ((env: SettingsEnv) => number);
  step: number;
  bigStep?: number;
  format?: (value: number, env: SettingsEnv) => string;
}

export interface ChoiceOption {
  id: string;
  label: string;
  /** One line under the label (tiles, the select's list) */
  detail?: string;
  disabled?: boolean;
}

export interface ChoiceDef extends RowBase<string> {
  /** Segmented: cheap, changes as the cursor moves. Select and tiles: change once, on A / Enter / click */
  kind: "segmented" | "select" | "tiles";
  options: readonly ChoiceOption[] | ((env: SettingsEnv) => readonly ChoiceOption[]);
  /** Tiles: columns from `sm` up */
  columns?: 2 | 3 | 4;
  /** Tiles: a picture above each title */
  media?: (id: string, chosen: boolean) => React.ReactNode;
}

export type RowDef = ToggleDef | SliderDef | ChoiceDef;

type S = PlayerSettings;

/** Read, write and default of a value inside the saved settings */
export function lens<T>(get: (s: S) => T, put: (s: S, value: T) => S) {
  return {
    read: (env: SettingsEnv) => get(env.settings),
    write: (env: SettingsEnv, value: T) => env.update((s) => put(s, value)),
    initial: () => get(DEFAULT_PLAYER_SETTINGS),
  };
}

type Group = "hud" | "graphics" | "touch" | "wheel" | "padTuning" | "keyboardTuning" | "audio" | "profile";

/** A field of one of the settings' groups (`hud.radar`, `wheel.ffbGain`) */
const inGroup =
  <G extends Group>(group: G) =>
  <K extends keyof S[G]>(key: K) =>
    lens<S[G][K]>(
      (s) => s[group][key],
      (s, value) => ({ ...s, [group]: { ...(s[group] as object), [key]: value } }) as S,
    );

export const hud = inGroup("hud");
export const graphics = inGroup("graphics");
export const touch = inGroup("touch");
export const wheel = inGroup("wheel");
export const pad = inGroup("padTuning");
export const kb = inGroup("keyboardTuning");
export const audio = inGroup("audio");
export const profile = inGroup("profile");
export const top = <K extends keyof S>(key: K) => lens<S[K]>((s) => s[key], (s, value) => ({ ...s, [key]: value }));

export const toggle = (d: Omit<ToggleDef, "kind">): ToggleDef => ({ kind: "toggle", ...d });
export const slider = (d: Omit<SliderDef, "kind">): SliderDef => ({ kind: "slider", ...d });
export const choice = (kind: ChoiceDef["kind"], d: Omit<ChoiceDef, "kind">): ChoiceDef => ({ kind, ...d });

export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const pctOrOff = (v: number) => (v <= 0 ? "Off" : pct(v));

const same = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : a === b;

const textOf = (t: Text | undefined, env: SettingsEnv) => (typeof t === "function" ? t(env) : t);

/** The row's state: whether it differs from its default, and putting the default back */
export function rowState(def: RowDef, env: SettingsEnv) {
  const value = def.read(env);
  const initial = def.initial(env);
  return {
    value,
    changed: !same(value, initial),
    reset: () => (def as RowBase<typeof initial>).write(env, initial),
  };
}

/** A setting, drawn from its definition: a `SettingRow` with the control its kind asks for */
export function SettingField({ def, first }: { def: RowDef; first?: boolean }) {
  const env = useSettingsEnv();
  const { value, changed, reset } = rowState(def, env);
  const off = def.off?.(env) ?? null;
  const row = {
    label: def.label,
    hint: textOf(def.hint, env),
    advanced: def.advanced,
    disabled: off !== null,
    disabledReason: off ?? undefined,
    changed,
    onReset: reset,
    resetLabel: `Reset ${def.label.toLowerCase()} to the default`,
    navDefault: first,
  };
  switch (def.kind) {
    case "toggle":
      return (
        <SettingRow {...row}>
          <Toggle checked={value as boolean} onChange={(v) => def.write(env, v)} />
        </SettingRow>
      );
    case "slider": {
      const max = typeof def.max === "function" ? def.max(env) : def.max;
      return (
        <SettingRow {...row}>
          <Slider
            value={Math.min(max, value as number)}
            min={def.min}
            max={max}
            step={def.step}
            bigStep={def.bigStep}
            defaultValue={def.initial(env)}
            format={def.format ? (v) => def.format!(v, env) : undefined}
            onChange={(v) => def.write(env, v)}
          />
        </SettingRow>
      );
    }
    default: {
      const options = typeof def.options === "function" ? def.options(env) : def.options;
      if (def.kind === "segmented") {
        return (
          <SettingRow {...row}>
            <Segmented
              size="sm"
              options={options.map((o) => ({ id: o.id, label: o.label, disabled: o.disabled }))}
              value={value as string}
              onChange={(id) => def.write(env, id)}
            />
          </SettingRow>
        );
      }
      if (def.kind === "select") {
        return (
          <SettingRow {...row}>
            <Select options={options} value={value as string} onChange={(id) => def.write(env, id)} />
          </SettingRow>
        );
      }
      return (
        <SettingRow {...row} stacked>
          <OptionTileGroup aria-label={def.label} columns={def.columns ?? 3} className="w-full">
            {options.map((o) => {
              const chosen = o.id === value;
              return (
                <OptionTile
                  key={o.id}
                  checked={chosen}
                  onSelect={() => def.write(env, o.id)}
                  title={o.label}
                  description={o.detail}
                  media={def.media?.(o.id, chosen)}
                  disabled={off !== null}
                  navDefault={first && chosen}
                />
              );
            })}
          </OptionTileGroup>
        </SettingRow>
      );
    }
  }
}

/** Every row in a card, laid out in order (the first one is where the cursor lands on the tab) */
export function Fields({ rows, first }: { rows: readonly RowDef[]; first?: boolean }) {
  const detail = useSettingsDetail();
  const shown = detail === "simple" ? rows.filter((r) => !r.advanced) : rows;
  return (
    <>
      {rows.map((def) => (
        <SettingField key={def.id} def={def} first={first && def === shown[0]} />
      ))}
    </>
  );
}

export interface SettingsCardProps {
  title: string;
  /** One line under the title */
  description?: React.ReactNode;
  /** The card's rows, drawn in order; its Reset puts these back */
  rows?: readonly RowDef[];
  /** Where the cursor lands on the tab: the first visible row */
  first?: boolean;
  /** The whole card is for Advanced */
  advanced?: boolean;
  /** Content before / after the rows (lists, live meters, actions) */
  before?: React.ReactNode;
  children?: React.ReactNode;
  /** More the card's Reset puts back, beyond its rows: whether any of it differs, and how */
  extraReset?: { changed: boolean; reset: () => void };
  /** What the confirm says goes back (default: "the settings in this card") */
  resetWhat?: string;
  className?: string;
}

/**
 * A titled card of settings with one Reset that asks first. In Simple mode a card whose rows are all advanced (or
 * that is marked advanced) is not drawn.
 */
export function SettingsCard({
  title,
  description,
  rows = [],
  first,
  advanced,
  before,
  children,
  extraReset,
  resetWhat,
  className,
}: SettingsCardProps) {
  const env = useSettingsEnv();
  const detail = useSettingsDetail();
  const [asking, setAsking] = useState(false);
  const advancedCard = Boolean(advanced) || (rows.length > 0 && rows.every((r) => r.advanced));
  // Hidden in Simple with its rows unmounted, so the card itself says that Advanced has more here
  useReportAdvanced(advancedCard);
  if (detail === "simple" && advancedCard) {
    return null;
  }
  const states = rows.map((r) => rowState(r, env));
  const changed = states.some((s) => s.changed) || Boolean(extraReset?.changed);
  return (
    <Card
      title={title}
      description={description}
      className={className}
      action={
        changed ? (
          <Button variant="ghost" size="sm" icon={<Icon name="reset" />} onClick={() => setAsking(true)} data-card-reset="">
            Reset
          </Button>
        ) : undefined
      }
    >
      {before}
      <Fields rows={rows} first={first} />
      {children}
      <ConfirmDialog
        open={asking}
        title={`Reset ${title.toLowerCase()}?`}
        confirmLabel="Reset"
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          for (const s of states) if (s.changed) s.reset();
          if (extraReset?.changed) extraReset.reset();
          setAsking(false);
        }}
      >
        {`This puts ${resetWhat ?? "the settings in this card"} back to their defaults.`}
      </ConfirmDialog>
    </Card>
  );
}

/**
 * Simple mode's pointer to what it hides: one line and the switch. Alone on a tab whose settings are all advanced
 * (the cursor lands on it), or as the last card of a tab that has more in Advanced (`more`).
 */
export function AdvancedOnly({ onShowAdvanced, what, more }: { onShowAdvanced: () => void; what: string; more?: boolean }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="lc-body m-0">{what} are in Advanced.</p>
        <Button variant="secondary" size="sm" onClick={onShowAdvanced} data-nav-default={more ? undefined : ""}>
          Show advanced
        </Button>
      </div>
    </Card>
  );
}
