"use client";

import React, { useId } from "react";
import { Icon } from "./icons/Icon";
import { cx } from "./styles";

export interface TextFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "size" | "children"> {
  /** The field's name, above it in `lc-field-label` */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** One line under the field */
  hint?: React.ReactNode;
  /** What is wrong and how to fix it; turns the edge crimson */
  error?: React.ReactNode;
  /** Icon inside on the left (16 px) */
  icon?: React.ReactNode;
  /** A node inside on the right (a clear button, a unit) */
  trailing?: React.ReactNode;
  /** A text area on the same well, `rows` lines tall (default 4) and resizable downwards; no icon or trailing node */
  multiline?: boolean;
  rows?: number;
  /** Shows the focused look without the focus (the kit's state sheets) */
  forceCursor?: boolean;
  /** Classes for the outer block */
  className?: string;
}

/**
 * A 44 px text field (or, with `multiline`, a text area) on a well: the label above in `lc-field-label` (sentence case), the hint or the error
 * under it. Focus is the volt edge and halo. Esc or B leaves the field (the menu navigation moves the cursor on).
 */
export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  icon,
  trailing,
  multiline,
  rows = 4,
  forceCursor,
  className,
  id,
  disabled,
  ...input
}: TextFieldProps) {
  const auto = useId();
  const fieldId = id ?? `${auto}-input`;
  const hintId = hint ? `${auto}-hint` : undefined;
  const errorId = error ? `${auto}-error` : undefined;
  return (
    <div className={cx("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={fieldId} className="lc-field-label">
        {label}
      </label>
      <div
        data-cursor={forceCursor ? "" : undefined}
        className={cx(
          "flex min-w-0 gap-2.5 rounded-lc-row border bg-lc-well px-3.5 transition-[border-color,box-shadow] duration-200 ease-lc",
          multiline ? "items-start py-2.5" : "h-11 items-center",
          "focus-within:border-lc-volt focus-within:shadow-lc-focus data-cursor:border-lc-volt data-cursor:shadow-lc-focus",
          error ? "border-lc-loss" : "border-lc-line hover:border-lc-keyline",
          disabled ? "cursor-not-allowed opacity-40" : undefined,
          "[&_svg]:size-4 [&_svg]:shrink-0",
        )}
      >
        {multiline ? (
          <textarea
            {...(input as unknown as React.TextareaHTMLAttributes<HTMLTextAreaElement>)}
            id={fieldId}
            rows={rows}
            value={value}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={cx(errorId, hintId, input["aria-describedby"]) || undefined}
            onChange={(e) => onChange(e.target.value)}
            className="min-h-6 min-w-0 flex-1 resize-y bg-transparent text-[15px] leading-normal font-medium text-lc-chalk outline-none placeholder:text-lc-slate focus-visible:outline-none disabled:cursor-not-allowed in-data-[input=pad]:focus:shadow-none in-data-[input=pad]:focus:outline-none"
          />
        ) : (
          <>
            {icon ? (
              <span aria-hidden className="inline-flex text-lc-slate">
                {icon}
              </span>
            ) : null}
            <input
              {...input}
              id={fieldId}
              value={value}
              disabled={disabled}
              aria-invalid={error ? true : undefined}
              aria-describedby={cx(errorId, hintId, input["aria-describedby"]) || undefined}
              onChange={(e) => onChange(e.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent text-[15px] font-medium text-lc-chalk outline-none placeholder:text-lc-slate focus-visible:outline-none disabled:cursor-not-allowed in-data-[input=pad]:focus:shadow-none in-data-[input=pad]:focus:outline-none"
            />
            {trailing}
          </>
        )}
      </div>
      {/* Always in the page, so an error that appears (a failed join, a check on submit) is read out; empty, its
          negative margin cancels the column's gap */}
      <div aria-live="polite" className={error ? undefined : "-mt-1.5"}>
        {error ? (
          <span id={errorId} className="flex items-start gap-1.5 text-[12px] leading-[1.4] font-medium text-lc-loss">
            <Icon name="error" size="xs" className="mt-px" />
            <span>{error}</span>
          </span>
        ) : null}
      </div>
      {hint ? (
        <span id={hintId} className="lc-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
