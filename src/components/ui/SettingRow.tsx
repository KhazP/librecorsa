"use client";

import React, { createContext, useContext, useEffect, useId } from "react";
import { IconButton } from "./Button";
import { Icon } from "./icons/Icon";
import { cx } from "./styles";

/**
 * What a row tells the control inside it: the id its label points at, the ids that name and describe it, whether it
 * is disabled, and whether it is where a pad enters the pane. Every control of the standard reads this, so a control
 * dropped into a `SettingRow` is labelled, described and disabled with no extra props.
 */
export interface SettingRowContextValue {
  controlId: string;
  labelId: string;
  hintId: string | undefined;
  disabled: boolean;
  navDefault: boolean;
}

const RowContext = createContext<SettingRowContextValue | null>(null);

/** The row a control sits in, or null on its own */
export const useSettingRow = (): SettingRowContextValue | null => useContext(RowContext);

/** Simple shows the essentials; Advanced also shows the rows marked `advanced` */
export type SettingsDetail = "simple" | "advanced";

const DetailContext = createContext<SettingsDetail>("advanced");

/** Sets Simple or Advanced for every `SettingRow` below it (a Disclosure can reopen its advanced rows inline) */
export const SettingsDetailProvider: React.FC<{ value: SettingsDetail; children: React.ReactNode }> = ({ value, children }) => (
  <DetailContext.Provider value={value}>{children}</DetailContext.Provider>
);

export const useSettingsDetail = (): SettingsDetail => useContext(DetailContext);

/**
 * Tells the screen above that a setting only Advanced shows is on the page, in either mode, so Simple can say that
 * more is there and the switch never looks as if it did nothing. The provider's value is called once per such
 * setting and returns its undo.
 */
const AdvancedPresenceContext = createContext<(() => () => void) | null>(null);
export const AdvancedPresenceProvider = AdvancedPresenceContext.Provider;
export function useReportAdvanced(present: boolean): void {
  const report = useContext(AdvancedPresenceContext);
  useEffect(() => (present && report ? report() : undefined), [present, report]);
}

/** Props every control of the standard takes to name itself when it is used outside a row */
export interface ControlA11yProps {
  id?: string;
  /** Accessible name when the control is not in a `SettingRow` (a row names its control) */
  "aria-label"?: string;
  "aria-describedby"?: string;
  disabled?: boolean;
}

/**
 * Resolves a control's id, name, description and disabled state from its own props and the row around it. `a11y` goes
 * on the focusable element.
 */
export function useRowControl(props: ControlA11yProps) {
  const row = useSettingRow();
  const ownId = useId();
  const id = props.id ?? row?.controlId ?? ownId;
  const describedBy = [props["aria-describedby"], row?.hintId].filter(Boolean).join(" ") || undefined;
  const disabled = Boolean(props.disabled ?? row?.disabled);
  return {
    row,
    id,
    disabled,
    navDefault: Boolean(row?.navDefault),
    a11y: {
      id,
      "aria-label": props["aria-label"],
      "aria-labelledby": props["aria-label"] ? undefined : row?.labelId,
      "aria-describedby": describedBy,
      "aria-disabled": disabled || undefined,
    },
  };
}

export interface SettingRowProps {
  label: React.ReactNode;
  /** One line under the label */
  hint?: React.ReactNode;
  /** The control: Toggle, Slider, Segmented, Stepper, Select, a Button */
  children: React.ReactNode;
  /** Hidden in Simple mode (`SettingsDetailProvider`) */
  advanced?: boolean;
  /** Greys the control out; it stays reachable so the reason can be read */
  disabled?: boolean;
  /** Why the setting is off, shown in place of the hint while disabled */
  disabledReason?: React.ReactNode;
  /** The value differs from the default: shows a dot by the label */
  changed?: boolean;
  /** With `changed`: a reset button that puts the default back (pointer: the button; keys: Delete; pad: X) */
  onReset?: () => void;
  /** Name of the default, for the reset button's label ("Reset to 100 %") */
  resetLabel?: string;
  /** Where a controller lands when it enters the pane this row is in */
  navDefault?: boolean;
  /** Always put the control under the label (wide controls: a long segmented row, option tiles) */
  stacked?: boolean;
  /** The control's id (generated when left out) */
  id?: string;
  /** Shows the cursor ring without the focus (the kit's state sheets) */
  forceCursor?: boolean;
  className?: string;
}

/**
 * The one row every setting uses: label and hint on the left, the control on the right; the whole row takes the cursor
 * ring when its control has the focus. On phones the control drops under the label when it needs more than 45 % of
 * the row.
 */
export function SettingRow({
  label,
  hint,
  children,
  advanced,
  disabled = false,
  disabledReason,
  changed,
  onReset,
  resetLabel,
  navDefault = false,
  stacked,
  id,
  forceCursor,
  className,
}: SettingRowProps) {
  const detail = useSettingsDetail();
  const autoId = useId();
  const controlId = id ?? `${autoId}-control`;
  const labelId = `${autoId}-label`;
  const shownHint = disabled && disabledReason ? disabledReason : hint;
  const hintId = shownHint ? `${autoId}-hint` : undefined;
  useReportAdvanced(Boolean(advanced));
  if (advanced && detail === "simple") return null;
  const labelText = typeof label === "string" ? label : "this setting";
  return (
    <RowContext.Provider value={{ controlId, labelId, hintId, disabled, navDefault }}>
      <div
        data-cursor={forceCursor ? "" : undefined}
        data-setting-row=""
        data-advanced={advanced ? "" : undefined}
        className={cx(
          "lc-row-ring -mx-2 flex min-h-13 items-center gap-x-4 gap-y-2.5 rounded-lc-row px-2 py-2 transition-[background-color] duration-200 ease-lc hover:bg-white/4",
          stacked ? "flex-wrap" : "phone:flex-wrap",
          className,
        )}
      >
        <div className={cx("flex min-w-0 flex-1 flex-col gap-0.5", stacked ? "basis-full" : "phone:basis-[55%]")}>
          <span className="flex min-w-0 items-center gap-2">
            <label
              id={labelId}
              htmlFor={controlId}
              className={cx("lc-row-label min-w-0", disabled ? "cursor-not-allowed text-lc-fog" : "cursor-pointer")}
            >
              {label}
            </label>
            {changed ? (
              <span className="inline-flex shrink-0 items-center" title="Changed from the default">
                <span aria-hidden className="size-1.5 rounded-full bg-lc-cyan" />
                <span className="sr-only">Changed from the default</span>
              </span>
            ) : null}
          </span>
          {shownHint ? (
            <span id={hintId} className={cx("lc-hint", disabled && disabledReason ? "text-lc-fog" : undefined)}>
              {shownHint}
            </span>
          ) : null}
        </div>
        <div className={cx("flex min-w-0 shrink-0 items-center justify-end gap-2", stacked ? "basis-full" : "ml-auto max-w-full phone:grow")}>
          {changed && onReset && !disabled ? (
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={resetLabel ?? `Reset ${labelText} to the default`}
              title={resetLabel ?? "Reset to the default"}
              icon={<Icon name="reset" />}
              onClick={onReset}
              // Out of the arrows' and the D-pad's path: left / right on a row change its value. Tab still stops on
              // it (the only key route in a text or number field, and outside Settings, where Delete / X do nothing);
              // in Settings, Delete / X reset the focused row too
              data-row-reset=""
              data-nav-skip=""
            />
          ) : null}
          {children}
        </div>
      </div>
    </RowContext.Provider>
  );
}
