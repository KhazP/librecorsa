"use client";

import React from "react";
import Link from "next/link";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { cx, MOTION } from "./styles";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "lg" | "md" | "sm";

/**
 * Variant looks. Primary is the screen's main action (volt); its cursor is the volt edge and halo around it. The rest
 * take the volt fill under the cursor, except danger, which fills crimson with void ink.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: cx(
    "bg-lc-volt text-lc-void shadow-lc-focus hover:bg-lc-volt-hi active:bg-lc-volt-dim",
    "focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-lc-volt",
    "in-data-[input=pad]:focus:outline-2 in-data-[input=pad]:focus:outline-offset-3 in-data-[input=pad]:focus:outline-lc-volt",
    "data-cursor:outline-2 data-cursor:outline-solid data-cursor:outline-offset-3 data-cursor:outline-lc-volt",
    // Greyed out, never a dimmed volt: a disabled main action must not look like the cursor
    "disabled:bg-lc-titanium disabled:text-lc-slate disabled:shadow-none disabled:inset-ring disabled:inset-ring-lc-line",
    "aria-disabled:bg-lc-titanium aria-disabled:text-lc-slate aria-disabled:shadow-none aria-disabled:inset-ring aria-disabled:inset-ring-lc-line",
  ),
  secondary: cx(
    "bg-lc-titanium text-lc-chalk inset-ring inset-ring-lc-line hover:bg-lc-line hover:inset-ring-lc-keyline active:bg-lc-carbon",
    "outline-none focus-visible:outline-none",
    "focus:bg-lc-volt focus:text-lc-void focus:inset-ring-transparent focus:shadow-lc-focus focus:active:bg-lc-volt-dim",
    "data-cursor:bg-lc-volt data-cursor:text-lc-void data-cursor:inset-ring-transparent data-cursor:shadow-lc-focus",
    "disabled:opacity-40 aria-disabled:opacity-40",
  ),
  ghost: cx(
    "bg-transparent text-lc-slate hover:bg-white/4 hover:text-lc-chalk active:bg-white/2",
    "outline-none focus-visible:outline-none",
    "focus:bg-lc-volt focus:text-lc-void focus:shadow-lc-focus focus:active:bg-lc-volt-dim",
    "data-cursor:bg-lc-volt data-cursor:text-lc-void data-cursor:shadow-lc-focus",
    "disabled:opacity-40 aria-disabled:opacity-40",
  ),
  danger: cx(
    "bg-transparent text-lc-crimson inset-ring inset-ring-lc-crimson/60 hover:bg-lc-crimson/10 active:bg-lc-crimson/20",
    "outline-none focus-visible:outline-none",
    "focus:bg-lc-crimson focus:text-lc-void focus:inset-ring-transparent focus:ring-5 focus:ring-lc-crimson/15 focus:active:bg-lc-crimson/80",
    "data-cursor:bg-lc-crimson data-cursor:text-lc-void data-cursor:inset-ring-transparent data-cursor:ring-5 data-cursor:ring-lc-crimson/15",
    "disabled:opacity-40 aria-disabled:opacity-40",
  ),
};

/**
 * Any variant greyed out with a reason (`disabledReason`): slate on titanium, which keeps the label readable (5.5:1)
 * where 40 % opacity would not, and the cursor is the volt outline, as on a greyed-out main action
 */
const WITH_REASON = cx(
  "bg-lc-titanium text-lc-slate inset-ring inset-ring-lc-line shadow-none",
  "focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-lc-volt",
  "in-data-[input=pad]:focus:outline-2 in-data-[input=pad]:focus:outline-offset-3 in-data-[input=pad]:focus:outline-lc-volt",
  "data-cursor:outline-2 data-cursor:outline-solid data-cursor:outline-offset-3 data-cursor:outline-lc-volt",
);

const SIZE: Record<ButtonSize, { box: string; label: string; withPrompt: string; icon: string }> = {
  lg: { box: "h-13 gap-3 px-6.5 phone:h-11 phone:px-5", label: "text-[20px] phone:text-[17px]", withPrompt: "pl-2.5", icon: "[&_svg]:size-5" },
  md: { box: "h-11 gap-2.5 px-5", label: "text-[16px]", withPrompt: "pl-2", icon: "[&_svg]:size-5" },
  sm: { box: "h-9 gap-2 px-4 pointer-coarse:h-11", label: "text-[14px]", withPrompt: "pl-1.5", icon: "[&_svg]:size-4" },
};

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (20 px, 16 px at `sm`) */
  icon?: React.ReactNode;
  /** Key cap or pad glyph inside on the left; hidden on touch screens, which have no keys to show */
  prompt?: React.ReactNode;
  /** Swaps the label for a three-dot pulse, keeping the width; presses do nothing meanwhile */
  loading?: boolean;
  /** Why the action is unavailable: keeps the button reachable (aria-disabled) and describes it */
  disabledReason?: string;
  /** Shows the cursor without the focus (the kit's state sheets) */
  forceCursor?: boolean;
  /** Stretches to the width of its container */
  block?: boolean;
  children: React.ReactNode;
  className?: string;
}

type NativeButton = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps | "type"> & {
  href?: undefined;
  native?: undefined;
  type?: "button" | "submit" | "reset";
  ref?: React.Ref<HTMLButtonElement>;
};
type NativeLink = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps | "href"> & {
  href: string;
  /**
   * A plain <a> instead of the router's link: no prefetch, no client-side navigation, the href used as written.
   * Automatic for a download, for mailto: / tel: and for another site; set it for a file or for a page that must load
   * fresh (the game entry).
   */
  native?: boolean;
  disabled?: undefined;
  ref?: React.Ref<HTMLAnchorElement>;
};

/** Hrefs the router has no business with: another site, a mail or phone link */
const OUTSIDE_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export type ButtonProps = CommonProps & (NativeButton | NativeLink);

/** The three dots of a loading button */
const Dots: React.FC = () => (
  <span aria-hidden className="absolute inset-0 flex items-center justify-center gap-1.5">
    <span className="lc-dot size-1.5 rounded-full bg-current" />
    <span className="lc-dot size-1.5 rounded-full bg-current" />
    <span className="lc-dot size-1.5 rounded-full bg-current" />
  </span>
);

/**
 * The one button: `primary` (the screen's main action), `secondary`, `ghost` and `danger`, in `lg` 52, `md` 44 and
 * `sm` 36 px pills. With `href` it is a link with the same look.
 */
export function Button(props: ButtonProps) {
  const {
    variant = "secondary",
    size = "md",
    icon,
    prompt,
    loading,
    disabledReason,
    forceCursor,
    block,
    children,
    className,
    ...rest
  } = props;
  const s = SIZE[size];
  const reasonId = React.useId();
  // A link has no disabled state; a button greyed out with a reason wears the readable recipe
  const withReason = Boolean(disabledReason) && rest.href === undefined;
  const classes = cx(
    "relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full whitespace-nowrap select-none",
    "disabled:cursor-not-allowed aria-disabled:cursor-not-allowed",
    MOTION,
    withReason ? WITH_REASON : VARIANT[variant],
    s.box,
    s.icon,
    prompt ? s.withPrompt : undefined,
    block ? "w-full" : undefined,
    className,
  );
  const inner = (
    <>
      {prompt ? <span className="inline-flex shrink-0 items-center pointer-coarse:hidden">{prompt}</span> : null}
      <span className={cx("inline-flex min-w-0 items-center gap-2.5", loading ? "invisible" : undefined)}>
        {icon ? <span className="inline-flex shrink-0" aria-hidden>{icon}</span> : null}
        <span className={cx("lc-title truncate leading-none", s.label)}>{children}</span>
      </span>
      {loading ? <Dots /> : null}
      {disabledReason ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
    </>
  );

  if (rest.href !== undefined) {
    const { href, native, onPointerEnter, ...anchor } = rest as NativeLink;
    const shared = {
      ...anchor,
      "data-cursor": forceCursor ? "" : undefined,
      onPointerEnter: (e: React.PointerEvent<HTMLAnchorElement>) => {
        focusOnHover(e);
        onPointerEnter?.(e);
      },
      className: classes,
    };
    if (native || anchor.download !== undefined || OUTSIDE_HREF.test(href)) {
      return (
        <a href={href} {...shared}>
          {inner}
        </a>
      );
    }
    return (
      <Link href={href} {...shared}>
        {inner}
      </Link>
    );
  }

  const { onClick, onPointerEnter, disabled, type = "button", ...button } = rest as NativeButton;
  const inert = Boolean(loading || disabledReason);
  return (
    <button
      type={type}
      {...button}
      disabled={disabledReason ? undefined : disabled}
      aria-disabled={disabledReason ? true : button["aria-disabled"]}
      aria-busy={loading || undefined}
      aria-describedby={cx(button["aria-describedby"], disabledReason ? reasonId : undefined) || undefined}
      title={button.title ?? disabledReason}
      data-cursor={forceCursor ? "" : undefined}
      onPointerEnter={(e) => {
        focusOnHover(e);
        onPointerEnter?.(e);
      }}
      onClick={(e) => {
        if (inert) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      className={classes}
    >
      {inner}
    </button>
  );
}

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type"> {
  /** Required: an icon button has no words to read */
  "aria-label": string;
  icon: React.ReactNode;
  variant?: ButtonVariant;
  /** `md` 44 px, `sm` 36 px (44 on touch screens) */
  size?: "md" | "sm";
  forceCursor?: boolean;
}

/** A round button holding one icon, in the same variants as `Button` */
export function IconButton({
  icon,
  variant = "ghost",
  size = "md",
  forceCursor,
  className,
  onPointerEnter,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      data-cursor={forceCursor ? "" : undefined}
      onPointerEnter={(e) => {
        focusOnHover(e);
        onPointerEnter?.(e);
      }}
      className={cx(
        "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full disabled:cursor-not-allowed aria-disabled:cursor-not-allowed",
        MOTION,
        VARIANT[variant],
        size === "md" ? "size-11 [&_svg]:size-5" : "size-9 pointer-coarse:size-11 [&_svg]:size-4",
        className,
      )}
    >
      <span aria-hidden className="inline-flex">
        {icon}
      </span>
    </button>
  );
}
