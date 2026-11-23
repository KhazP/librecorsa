"use client";

import React, { useId } from "react";
import { useTranslations } from "use-intl/react";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { Icon } from "@/components/ui/icons/Icon";
import { CHOSEN_TILE, cx, IDLE_TILE, MOTION } from "@/components/ui/styles";
import { BUILT_IN_HUD_LAYOUTS, THIRD_PARTY_HUD_LAYOUTS, type HudLayoutInfo, type HudPreset } from "@/lib/settings/hud-layouts";
import { HudPreview } from "./hud-preview";

/** The third-party layouts as plain entries (the list may be empty in a build without them) */
const THIRD_PARTY: readonly HudLayoutInfo<HudPreset>[] = THIRD_PARTY_HUD_LAYOUTS;

/** The cursor on a layout tile: the kit's tile cursor (volt edge and halo), shown on the tile while its radio has focus */
const TILE_CURSOR = cx(
  "has-[[role=radio]:focus]:border-lc-volt has-[[role=radio]:focus]:inset-ring has-[[role=radio]:focus]:inset-ring-lc-volt",
  "has-[[role=radio]:focus]:shadow-lc-focus",
);

/**
 * Tiles by the picker's own width: two across, three, or four, so on a wide picker neither group (seven of the game's
 * own, six third-party) ends on a lone tile, and each tile stays wide enough for its picture to read
 */
const GRID = "grid grid-cols-2 gap-2 @min-[480px]:grid-cols-3 @min-[620px]:grid-cols-4";

/** A credited layout's author and site links, under its name */
const CREDIT_LINK = cx(
  "pointer-events-auto inline-flex items-center gap-1 rounded-sm",
  "underline decoration-lc-keyline underline-offset-2 hover:text-lc-chalk hover:decoration-lc-chalk",
  "focus-visible:text-lc-chalk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lc-volt",
  "pointer-coarse:min-h-11",
);

/**
 * One layout: its picture and name, the whole tile one tap to choose. A third-party layout adds "by <author>", a link
 * to its source that sits over the tile (a link can't live inside the radio button); the D-pad skips the link, Tab and
 * the pointer reach it.
 */
function LayoutTile({
  layout,
  checked,
  onSelect,
  navDefault,
}: {
  layout: HudLayoutInfo<HudPreset>;
  checked: boolean;
  onSelect: (id: HudPreset) => void;
  navDefault?: boolean;
}) {
  const tx = useTranslations("settings.hudPicker");
  const credit = layout.credit;
  const description = !credit
    ? layout.detail
    : credit.site
      ? tx("descriptionSite", { detail: layout.detail, author: credit.author, site: credit.site.name })
      : tx("description", { detail: layout.detail, author: credit.author });
  return (
    <div
      className={cx(
        "group relative flex min-w-0 flex-col gap-2 rounded-lc-tile border-[1.5px] p-1.5 pb-2.5",
        MOTION,
        checked ? CHOSEN_TILE : IDLE_TILE,
        TILE_CURSOR,
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-description={description}
        data-own-ring=""
        data-nav-default={navDefault ? "" : undefined}
        onPointerEnter={focusOnHover}
        onClick={() => {
          if (!checked) onSelect(layout.id);
        }}
        className={cx(
          "flex min-w-0 cursor-pointer flex-col gap-2 text-start outline-none",
          // The whole tile is the button's hit area
          "after:absolute after:inset-0 after:rounded-lc-tile after:content-['']",
        )}
      >
        <span className="block overflow-hidden rounded-lc-nub inset-ring inset-ring-white/6">
          <HudPreview preset={layout.id} />
        </span>
        <span className="flex min-w-0 items-start justify-between gap-2 px-1">
          <span className={cx("min-w-0 truncate text-[15px] leading-tight font-semibold", checked ? "text-lc-chalk" : "text-lc-fog")}>
            {layout.label}
          </span>
          {checked ? <Icon name="success" className="mt-px shrink-0 text-lc-chalk" /> : null}
        </span>
      </button>
      {credit ? (
        // Above the tile's hit area; only the links take clicks, the gap between them selects the tile
        <span className="pointer-events-none relative z-10 -mt-1 me-auto ms-1 inline-flex max-w-full min-w-0 items-center gap-1.5 text-[12px] leading-tight text-lc-slate">
          <a
            href={credit.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-nav-skip=""
            aria-label={tx("sourceLink", { layout: layout.label, author: credit.author })}
            className={cx(CREDIT_LINK, "min-w-0")}
          >
            <span className="truncate">by {credit.author}</span>
            <Icon name="externalLink" size="xs" className="size-3 shrink-0" />
          </a>
          {credit.site ? (
            <>
              <span aria-hidden="true">·</span>
              <a
                href={credit.site.url}
                target="_blank"
                rel="noopener noreferrer"
                data-nav-skip=""
                aria-label={tx("siteLink", { site: credit.site.name, author: credit.author })}
                className={cx(CREDIT_LINK, "shrink-0")}
              >
                {credit.site.name}
                <Icon name="externalLink" size="xs" className="size-3 shrink-0" />
              </a>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function HudTouchNote() {
  const tx = useTranslations("settings.hudPicker");
  return <>{tx("touchNote")}</>;
}

/** Which layouts a touch screen shows, for the pickers on one (an element, so it reads in the current language) */
export const HUD_TOUCH_NOTE = <HudTouchNote />;

export interface HudLayoutPickerProps {
  value: HudPreset;
  onChange: (id: HudPreset) => void;
  /** The chosen tile is where a controller lands when the picker's screen opens */
  navDefault?: boolean;
  className?: string;
}

/**
 * Every HUD layout as a grid of pictures, the game's own first, then the third-party ones with their authors. One tap,
 * click, Enter or A chooses; the chosen tile has the white edge and the check. The Settings screen, the pause menu and
 * first-run setup all draw this one picker.
 */
export function HudLayoutPicker({ value, onChange, navDefault, className }: HudLayoutPickerProps) {
  const headingId = useId();
  const tx = useTranslations("settings.hudPicker");
  return (
    <div role="radiogroup" aria-label={tx("label")} className={cx("@container flex flex-col gap-4", className)}>
      <div className={GRID}>
        {BUILT_IN_HUD_LAYOUTS.map((l) => (
          <LayoutTile key={l.id} layout={l} checked={value === l.id} onSelect={onChange} navDefault={navDefault && value === l.id} />
        ))}
      </div>
      {THIRD_PARTY.length ? (
        <div role="group" aria-labelledby={headingId} className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1 px-0.5">
            <h3 id={headingId} className="lc-row-label m-0">
              {tx("thirdParty")}
            </h3>
            <p className="lc-hint m-0">{tx("thirdPartyNote")}</p>
          </div>
          <div className={GRID}>
            {THIRD_PARTY.map((l) => (
              <LayoutTile key={l.id} layout={l} checked={value === l.id} onSelect={onChange} navDefault={navDefault && value === l.id} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
