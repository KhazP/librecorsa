"use client";

import React from "react";
import { Segmented, Select } from "@/components/ui";

/** Layouts a segmented row still fits on a circuit card; a venue with three or more (Okayama, VIR's seven) gets a list */
const SEGMENTED_UP_TO = 2;

/**
 * A venue's layout picker, on the home page's circuit cards and in the game's circuit browser: a segmented row for a
 * few layouts, a `Select` for more. Inside a `SettingRow` the row names it; elsewhere pass `aria-label`.
 */
export function LayoutChoice({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
}: {
  options: readonly { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  "aria-label"?: string;
}) {
  return options.length <= SEGMENTED_UP_TO ? (
    <Segmented fill size="sm" options={options} value={value} onChange={onChange} aria-label={ariaLabel} />
  ) : (
    <Select options={options} value={value} onChange={onChange} aria-label={ariaLabel} className="w-full" />
  );
}
