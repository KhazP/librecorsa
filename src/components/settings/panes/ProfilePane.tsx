"use client";

import React, { useEffect, useRef, useState } from "react";
import { Button, ConfirmDialog, SettingRow, TextField } from "@/components/ui";
import { CHOSEN_TILE, cx, MOTION } from "@/components/ui/styles";
import { Icon } from "@/components/ui/icons";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { CLAIMED_TELEMETRY_PORTS, DEFAULT_TELEMETRY_PORT } from "@/lib/input/device-input";
import { sanitizeColor, sanitizeDriverCode, sanitizeDriverName } from "@/lib/settings/player-settings";
import { autoUpload, telemetryOut } from "../defs";
import { useSettingsEnv } from "../env";
import { SettingsCard } from "../fields";
import { clearSavedData, resetAllSettings } from "../storage";

// ui-allow: hex-in-style driver colours are data: the colour other players see on the timing tower
const DRIVER_COLORS = ["#E10600", "#00D2BE", "#FF8700", "#0600EF", "#006F62", "#2B4562", "#B6BABD", "#CCFF00"] as const;
/** What each swatch above is called, in the same order, for a screen reader (a hex code says nothing) */
const COLOR_NAMES = ["Red", "Teal", "Orange", "Blue", "Racing green", "Navy", "Silver", "Lime"] as const;

/** The driver's colour: eight swatches and a picker for any other */
function ColourRow() {
  const env = useSettingsEnv();
  const current = env.settings.profile.color;
  const set = (c: string) => env.update((s) => ({ ...s, profile: { ...s.profile, color: sanitizeColor(c) } }));
  return (
    <SettingRow label="Colour" hint="Shown to other players in multiplayer and on the lap boards" stacked>
      <div role="radiogroup" aria-label="Colour" className="flex flex-wrap items-center gap-2">
        {DRIVER_COLORS.map((c, i) => {
          const chosen = current.toUpperCase() === c;
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={chosen}
              aria-label={COLOR_NAMES[i]}
              onClick={() => set(c)}
              onPointerEnter={focusOnHover}
              className={cx(
                "inline-flex size-9 cursor-pointer items-center justify-center rounded-full border-[1.5px] pointer-coarse:size-11",
                MOTION,
                chosen ? CHOSEN_TILE : "border-transparent",
                "outline-none focus-visible:outline-none focus:border-lc-volt focus:shadow-lc-focus",
              )}
            >
              {/* ui-allow: hex-in-style the swatch is the driver colour itself (data) */}
              <span aria-hidden className="size-6 rounded-full inset-ring inset-ring-white/15" style={{ backgroundColor: c }} />
            </button>
          );
        })}
        <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full px-3 text-[13px] font-semibold text-lc-fog inset-ring inset-ring-lc-line hover:text-lc-chalk focus-within:inset-ring-lc-volt focus-within:shadow-lc-focus pointer-coarse:h-11">
          <input
            type="color"
            value={current.toLowerCase()}
            onChange={(e) => set(e.target.value)}
            className="size-5.5 cursor-pointer rounded-full border-0 bg-transparent p-0 [&::-moz-color-swatch]:rounded-full [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
          />
          Other colour
        </label>
      </div>
    </SettingRow>
  );
}

/** Settings > Profile and data > Driver: who other players see */
export function DriverTab() {
  const env = useSettingsEnv();
  const { profile } = env.settings;
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [codeDraft, setCodeDraft] = useState<string | null>(null);
  /** The name last sent to the board: Enter then leaving the field, or the screen closing, must not send it again */
  const sentName = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const commitName = () => {
    if (nameDraft === null) return;
    if (env.onRenameDriver) {
      // The board has the last word: the field keeps the typed name until it has taken, or says why it did not
      const typed = nameDraft;
      // Sent once per edit (in flight, taken or turned down); typing in the field again allows another try
      if (sentName.current === typed) return;
      sentName.current = typed;
      void env.onRenameDriver(typed).then((error) => {
        if (!alive.current) return;
        setNameError(error);
        if (error === null) setNameDraft((d) => (d === typed ? null : d));
      });
      return;
    }
    const name = sanitizeDriverName(nameDraft);
    if (name !== profile.name) env.update((s) => ({ ...s, profile: { ...s.profile, name, generated: false } }));
    setNameDraft(null);
  };
  const commitCode = () => {
    if (codeDraft === null) return;
    env.update((s) => ({ ...s, profile: { ...s.profile, code: sanitizeDriverCode(codeDraft) } }));
    setCodeDraft(null);
  };
  // An edit is saved on Enter, on leaving the field, and when the screen goes away mid-edit
  const commits = useRef({ commitName, commitCode });
  commits.current = { commitName, commitCode };
  useEffect(
    () => () => {
      commits.current.commitName();
      commits.current.commitCode();
    },
    [],
  );
  const onEnter = (commit: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commit();
  };

  return (
    <SettingsCard title="Driver" rows={[autoUpload]} before={
      <>
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 pb-2">
        <TextField
          label="Name"
          maxLength={16}
          autoComplete="off"
          spellCheck={false}
          value={nameDraft ?? profile.name}
          onChange={(v) => {
            sentName.current = null;
            setNameDraft(v);
            setNameError(null);
          }}
          onKeyDown={onEnter(commitName)}
          onBlur={commitName}
          error={nameError ?? undefined}
          data-nav-default=""
        />
        <TextField
          label="Code"
          maxLength={3}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={codeDraft ?? profile.code}
          onChange={(v) => setCodeDraft(v.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3))}
          onKeyDown={onEnter(commitCode)}
          onBlur={commitCode}
          className="[&_input]:lc-mono [&_input]:text-center [&_input]:tracking-[0.14em]"
        />
      </div>
      <ColourRow />
      </>
    }>
    </SettingsCard>
  );
}

/** The telemetry port: typed as text, so a half-typed number never snaps to the range's edge */
function PortRow() {
  const env = useSettingsEnv();
  const w = env.settings.wheel;
  const [text, setText] = useState(String(w.telemetryPort));
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(String(w.telemetryPort));
  }, [w.telemetryPort]);
  const claimed = CLAIMED_TELEMETRY_PORTS[w.telemetryPort];
  return (
    <SettingRow
      label="UDP port"
      advanced
      hint={claimed ? `Port ${w.telemetryPort} is ${claimed}: tools there will misread it. The default is ${DEFAULT_TELEMETRY_PORT}` : "Where the bridge sends it, on this computer"}
      disabled={!w.telemetryOut}
      disabledReason="Needs Telemetry out on"
      changed={w.telemetryPort !== DEFAULT_TELEMETRY_PORT}
      onReset={() => env.update((s) => ({ ...s, wheel: { ...s.wheel, telemetryPort: DEFAULT_TELEMETRY_PORT } }))}
    >
      <input
        ref={ref}
        type="number"
        inputMode="numeric"
        min={1024}
        max={65535}
        step={1}
        aria-label="UDP port"
        disabled={!w.telemetryOut}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= 1024 && n <= 65535) env.update((s) => ({ ...s, wheel: { ...s.wheel, telemetryPort: n } }));
        }}
        onBlur={() => setText(String(w.telemetryPort))}
        className="lc-mono h-10 w-28 rounded-full border border-lc-line bg-lc-well px-4 text-right text-[14px] text-lc-chalk outline-none focus:border-lc-volt focus:shadow-lc-focus disabled:cursor-not-allowed disabled:opacity-40"
      />
    </SettingRow>
  );
}

/** Settings > Profile and data > Data: the driver key, telemetry out, and putting everything back */
export function DataTab() {
  const env = useSettingsEnv();
  const [asking, setAsking] = useState<"reset" | "clear" | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      {env.driverKey ? (
        <SettingsCard title="Driver key">
          <SettingRow
            label="Driver key"
            hint={env.driverKey.notice ?? "Signs your laps on the online boards. Keep a copy to post from another browser"}
            navDefault
          >
            <Button size="sm" variant="secondary" icon={<Icon name="download" />} onClick={env.driverKey.onExport} data-nav-default="">
              Save
            </Button>
            <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
              Load
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) env.driverKey?.onImport(f);
                e.target.value = "";
              }}
            />
          </SettingRow>
        </SettingsCard>
      ) : null}
      <SettingsCard title="Telemetry out" rows={[telemetryOut]} first={!env.driverKey}>
        <PortRow />
      </SettingsCard>
      <SettingsCard title="Start over">
        <SettingRow label="Reset all settings" hint="Controls, key bindings, assists, force feedback, display and sound go back to their defaults">
          <Button size="sm" variant="danger" onClick={() => setAsking("reset")}>
            Reset
          </Button>
        </SettingRow>
        <SettingRow label="Clear saved data" hint="Removes everything the game saved in this browser and starts it as a first visit">
          <Button size="sm" variant="danger" icon={<Icon name="delete" />} onClick={() => setAsking("clear")}>
            Clear
          </Button>
        </SettingRow>
      </SettingsCard>
      <ConfirmDialog
        open={asking === "reset"}
        title="Reset all settings?"
        confirmLabel="Reset all"
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          env.update(resetAllSettings);
          if (!env.rumble) env.onToggleRumble();
          setAsking(null);
        }}
      >
        Every setting on this screen goes back to its default, key bindings and calibration too. Your name, colour,
        favourites, car setups, race choices and lap times stay.
      </ConfirmDialog>
      <ConfirmDialog
        open={asking === "clear"}
        title="Clear saved data?"
        confirmLabel="Clear everything"
        busy={busy}
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          setBusy(true);
          void clearSavedData();
        }}
      >
        This removes every setting, your driver name and key, lap history and ghosts, car setups, favourites, race history
        and multiplayer server details from this browser, and reloads the game. Without the driver key your online lap
        times can no longer be claimed from here. It cannot be undone.
      </ConfirmDialog>
    </>
  );
}
