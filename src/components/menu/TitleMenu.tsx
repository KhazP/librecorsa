"use client";
import { useTranslations } from "use-intl/react";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { PauseMenuProps } from "@/components/hud/PauseMenu";
import type { VehicleModelId } from "@/types/f1";
import { carById, carClass, carSkinSwatchBackground } from "@/lib/cars/car-registry";
import { carSkinFor } from "@/lib/cars/car-skins";
import { vehicleModelSpec } from "@/lib/cars/vehicle-models";
import { COMPOUNDS } from "@/components/ui/badges/compounds";
import { formatLapTime } from "@/components/hud/hud-format";
import { EngineersGarage } from "./EngineersGarage";
import { MultiplayerPanel } from "@/components/hud/MultiplayerPanel";
import { ChallengePanel, type ChallengePanelProps } from "@/components/menu/ChallengePanel";
import { timeLeftLabel } from "@/lib/net/weekly-challenge";
import { LeaderboardPanel } from "@/components/hud/LeaderboardPanel";
import { buildHudMap } from "@/components/hud/styles/hud-style-parts";
import { ACTIVE_TRACK_ID, getActivePointToPoint, getTrackData } from "@/lib/track-data";
import { getTrackInfo, DEFAULT_TRACK_ID, LISTED_TRACKS, type TrackInfo } from "@/lib/track-registry";
import { SCENERY_CREDITS } from "@/lib/render/scenery-credits";
import { isLikelyWheel, padDisplayName } from "@/lib/input/device-input";
import { isTouchDevice } from "@/lib/input/touch-input";
import type { SpeedUnit } from "@/lib/settings/player-settings";
import { HUD_LICENSE_URL, THIRD_PARTY_HUD_LAYOUTS, hudLayout, type HudLayoutCredit } from "@/lib/settings/hud-layouts";
import { useUnits } from "@/lib/settings/ui-prefs";
import { DISTANCE_LABEL, distanceIn } from "@/lib/settings/units";
import { useGamepads, type PadState } from "./useMenuNav";
import { focusInZone, focusZone, useFocusNav } from "./useFocusNav";
import { useInputMode } from "./input-mode";
import { Button, IconButton, Sheet } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import type { IconName } from "@/components/ui/icons/registry";
import { KeyCap } from "@/components/ui/prompts/KeyCap";
import { PadGlyph } from "@/components/ui/prompts/PadGlyph";
import type { Prompt } from "@/components/ui/prompts/PromptBar";
import { CarClassTag, TrackQualityBadge } from "./menu-content-ui";
import { HeroAction, RailRow, RESET_ROW_PROMPT, ShellPrompts, usePanelReadingOrder, useRowResettable } from "./menu-shell";
import { feedbackContextOf, RequestPanel, type FeedbackContext } from "./RequestPanel";
import { CircuitBrowser } from "./CircuitBrowser";
import { CarBrowser } from "./CarBrowser";
import { TrackOutline } from "./circuit-outline";
import { ConditionsPanel } from "./ConditionsPanel";
import { RaceSetupPanel } from "./RaceSetupPanel";
import { DEFAULT_RACE_SETUP, raceStartSuffix } from "@/lib/sim/race-setup";
import { bestLapForCircuit } from "@/lib/sim/ghost-store";
import { useBestLapSummaries } from "@/lib/sim/use-best-laps";
import { TIME_OF_DAY_LABELS, WEATHER_LABELS } from "@/lib/sim/weather";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { AI_SKILL_DEFAULT, aiSkillLabel } from "@/lib/sim/ai-tuning";
import { REPO_URL, SUPPORT_URL, TAKEDOWN_URL } from "@/lib/site";
import { useStoreBuild } from "@/lib/use-store-build";
import { moddersList } from "@/lib/modders";
import type { PromptItem } from "@/lib/support-prompt";
import { SupportButton } from "@/components/SupportButton";
import { cx } from "@/components/ui/styles";
import { withBasePath } from "@/lib/base-path";
import { EmbeddedBadge } from "./EmbeddedBadge";
import { InstallAppButton } from "./InstallAppButton";
import { LiveLine } from "./LiveLine";
import { UpdateReady } from "./UpdateReady";
import { TitleMusic } from "./TitleMusic";

type TitlePanel = "race" | "circuit" | "car" | "conditions" | "garage" | "multiplayer" | "challenge" | "leaderboard" | "display" | "credits" | "request";

/**
 * How far a panel reaches beside the rail, in CSS px (the big-screen zoom scales them): each as wide as its content
 * reads well, so a wide screen gains what the panel can use and no stretched rows. The circuit and car walls fit four
 * tiles beside the details; a panel of two columns gives each about 540 px; the feedback form a form's width and its
 * notes; a timing list a list's width; and the garage leaves the car in view on the right while its setup and livery
 * change.
 */
const PANEL_WIDTH = "lg:grid-cols-[240px_minmax(0,1160px)]";
const PANEL_COLUMNS: Partial<Record<TitlePanel, string>> = {
  circuit: "lg:grid-cols-[240px_minmax(0,1480px)]",
  car: "lg:grid-cols-[240px_minmax(0,1480px)]",
  leaderboard: "lg:grid-cols-[240px_minmax(0,1200px)]",
  request: "lg:grid-cols-[240px_minmax(0,1080px)]",
  garage: "lg:grid-cols-[240px_minmax(0,1000px)]",
};
/**
 * Multiplayer before there is a room or an open race: the one column of the room card (MultiplayerPanel's `max-w-xl`,
 * 576 px, plus the sheet's padding), not a sheet twice its width with nothing on the right. A lobby or the open races
 * take the full width again, in columns.
 */
const MULTIPLAYER_ALONE = "lg:grid-cols-[240px_minmax(0,640px)]";

/**
 * Where the title menu picks up when it comes back: Controls is a screen of its own, and loading a circuit reloads the
 * whole scene, so both unmount the menu. Kept outside React for that reason; only honoured for the circuit it was meant
 * for (a failed load stays on the old one and must not reopen a panel later) and for a few minutes.
 */
let resumeAt: { panel: TitlePanel | null; focus: string; trackId: string; at: number } | null = null;
const peekResume = (trackId: string) =>
  resumeAt && resumeAt.trackId === trackId && Date.now() - resumeAt.at < 10 * 60_000 ? resumeAt : null;

export interface TitleMenuProps extends PauseMenuProps {
  firstRun: boolean;
  onDrive: () => void;
  /** Starts the AI race (from the race setup panel's Start race) */
  onRaceAi: () => void;
  onControls: () => void;
  initialPanel?: TitlePanel | null;
  /** Active circuit id */
  trackId?: string;
  /** Switches circuit (reloads the scene); settles when the load fails or lands */
  onSelectTrack?: (id: string) => void | Promise<void>;
  /** This week's challenge (only with an online board) */
  challengePanel?: ChallengePanelProps;
  /** The note after a drive (support-prompt.ts): the circuit and car just driven whose makers take donations */
  supportNote?: PromptItem[] | null;
  onCloseSupportNote?: () => void;
  /** A maker's donate button was pressed in the note */
  onSupportThanked?: (maker: string) => void;
}

const linkClass = "text-lc-chalk underline decoration-lc-keyline underline-offset-2 hover:decoration-lc-chalk";
/** A licence's name never breaks at its hyphen or space ("CC BY-NC-" / "SA 4.0") */
const licenceClass = cx(linkClass, "whitespace-nowrap");

/** A circuit's length in the player's units ("5.34 km") */
const lengthOf = (t: TrackInfo, unit: SpeedUnit) => `${distanceIn(t.lengthM / 1000, unit).toFixed(2)} ${DISTANCE_LABEL[unit]}`;

const CreditRow: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex flex-col gap-1.5 border-t border-lc-line py-4">
    <h3 className="lc-row-label m-0">{title}</h3>
    <p className="lc-body m-0">{children}</p>
  </div>
);

/** sagatron918's PayPal donation link: left out in the Android store build (Google Play payment rules) */
const SagatronDonateLink: React.FC = () =>
  useStoreBuild() ? null : (
    <>
      {" "}
      (
      <a href="https://www.paypal.me/SagarNaikB" target="_blank" rel="noreferrer" className={linkClass}>
        paypal.me/SagarNaikB
      </a>
      )
    </>
  );

/** "Monaco, Red Bull Ring, Chang and 7 more" */
const worksLine = (works: readonly string[], more: (works: string, count: number) => string) =>
  works.length > 3 ? more(works.slice(0, 3).join(", "), works.length - 3) : works.join(", ");

/**
 * The modders who take donations, first in the Credits: their name, what of theirs is in the game, and their
 * support link. Not in the Android app, which leaves payment links out.
 */
const ModderSupport: React.FC = () => {
  const store = useStoreBuild();
  const tx = useTranslations("menu.credits");
  const modders = useMemo(() => moddersList().filter((m) => m.support), []);
  if (store || !modders.length) return null;
  return (
    <section aria-labelledby="support-modders" className="flex flex-col gap-1.5 border-t border-lc-line py-4">
      <h3 id="support-modders" className="lc-row-label m-0">
        {tx("supportModders")}
      </h3>
      <p className="lc-body m-0 max-w-[70ch]">{tx("supportModdersBody")}</p>
      {/* The buttons share one width from sm up, so their left edges line up down each column (the labels differ:
          "Donate via PayPal", "Support on Streamlabs"); a column is wide enough for a name beside the widest. On a
          narrow phone each button goes under its name, at the left */}
      <ul className="m-0 mt-2 grid list-none grid-cols-[repeat(auto-fill,minmax(min(380px,100%),1fr))] gap-x-6 p-0">
        {modders.map((m) => (
          <li
            key={m.name}
            className="flex min-w-0 flex-col items-start gap-2 border-t border-white/5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
          >
            <span className="flex max-w-full min-w-0 flex-col">
              <a href={m.url} target="_blank" rel="noreferrer" className={cx(linkClass, "self-start font-semibold")}>
                {m.name}
              </a>
              <span className="lc-hint truncate" title={m.works.join(", ")}>
                {worksLine(m.works, (works, count) => tx("moreWorks", { works, count }))}
              </span>
            </span>
            <SupportButton support={m.support} maker={m.name} variant="secondary" className="shrink-0 sm:min-w-60" />
          </li>
        ))}
      </ul>
    </section>
  );
};

/**
 * The note after a drive, beside Up next on the main menu: who made the circuit and car just driven, with their
 * donation links. It never takes the cursor (Drive keeps it) and goes with Close, a donation, or the next drive.
 */
const SupportNote: React.FC<{ items: PromptItem[]; onClose?: () => void; onThanked?: (maker: string) => void }> = ({
  items,
  onClose,
  onThanked,
}) => {
  const tx = useTranslations("menu.supportNote");
  const circuit = items.find((i) => i.kind === "circuit");
  const car = items.find((i) => i.kind === "car");
  // "Circuit de Monaco by Mitja Bonca", "the Suzuki Liana 1.6, physics by alekabul": in the credit's own words
  const values = {
    circuit: circuit?.title ?? "",
    circuitMaker: circuit?.maker ?? "",
    car: car?.title ?? "",
    carMaker: car?.maker ?? "",
    role: car?.role.toLowerCase() ?? "",
    maker: (chunks: React.ReactNode) => <span className="font-semibold text-lc-chalk">{chunks}</span>,
  };
  const role = car?.role === "Model" ? "" : car?.role === "Physics" ? "Physics" : "Role";
  const drove = circuit
    ? car
      ? tx.rich(`both${role}` as const, values)
      : tx.rich("circuit", values)
    : car
      ? tx.rich(role ? (`car${role}` as const) : "car", values)
      : null;
  return (
    <Sheet role="region" aria-label={tx("region")} className="flex w-full flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <p className="lc-body m-0 text-[15px] leading-snug text-lc-fog">{drove}</p>
        {onClose ? <IconButton size="sm" variant="ghost" icon={<Icon name="close" />} aria-label={tx("close")} onClick={onClose} className="-mt-1 -me-1 shrink-0" /> : null}
      </div>
      <p className="lc-hint m-0">{tx("thanks")}</p>
      <div className="flex flex-wrap gap-2">
        {items.map((i) => (
          <SupportButton key={i.key} support={i.support} maker={i.maker} named variant="secondary" onOpen={() => onThanked?.(i.maker)} />
        ))}
      </div>
    </Sheet>
  );
};

const Credits: React.FC = () => {
  const tx = useTranslations("menu.credits");
  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 max-w-[760px] text-[18px] leading-snug font-semibold text-lc-chalk sm:text-[20px]">{tx("intro")}</p>

      <ModderSupport />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-x-8">
        <div>
          <CreditRow title={tx("physicsTitle")}>{tx("physicsBody")}</CreditRow>
          <CreditRow title={tx("graphicsTitle")}>{tx("graphicsBody")}</CreditRow>
          <CreditRow title={tx("hudTitle")}>
            {tx("hudBody")}
            <br />
            {THIRD_PARTY_HUD_LAYOUTS.map((l) => {
              const credit: HudLayoutCredit = l.credit;
              return (
                <React.Fragment key={l.id}>
                  &ldquo;{l.label}&rdquo; (
                  <a href={credit.repoUrl} target="_blank" rel="noreferrer" className={linkClass}>
                    github.com
                  </a>
                  ) by {credit.author} ·{" "}
                  {credit.site ? (
                    <>
                      <a href={credit.site.url} target="_blank" rel="noreferrer" className={linkClass}>
                        {credit.site.name}
                      </a>{" "}
                      ·{" "}
                    </>
                  ) : null}
                  <a href={HUD_LICENSE_URL[credit.license]} target="_blank" rel="noreferrer" className={licenceClass}>
                    {credit.license === "MIT" ? "MIT" : "GPL v3"}
                  </a>
                  <br />
                </React.Fragment>
              );
            })}
            {tx.rich("hudLicences", {
              link: (chunks) => (
                <a href={`${REPO_URL}/blob/main/THIRD_PARTY_NOTICES.md`} target="_blank" rel="noreferrer" className={linkClass}>
                  {chunks}
                </a>
              ),
            })}
          </CreditRow>
        </div>
        <div>
          <CreditRow title={tx("carModelsTitle")}>
            2026 Prototype: &ldquo;F1 2026 concept (polygon model)&rdquo; by{" "}
            <a href="https://qvistdesigns.framer.website/" target="_blank" rel="noreferrer" className={linkClass}>
              Qvist Designs
            </a>
            , steering wheel from DeX&apos;s AM26 (
            <a href="https://skfb.ly/pKNCK" target="_blank" rel="noreferrer" className={linkClass}>
              skfb.ly/pKNCK
            </a>
            ) ·{" "}
            <a href="http://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" className={licenceClass}>
              CC BY 4.0
            </a>
            <br />
            Mercedes-AMG GT3 Evo: &ldquo;Mercedes-AMG GT3&rdquo; (
            <a
              href="https://sketchfab.com/3d-models/mercedes-amg-gt3-wwwvecarzcom-6a3f7e3455064721b74b7f0b66427a07"
              target="_blank"
              rel="noreferrer"
              className={linkClass}
            >
              sketchfab.com
            </a>
            ) by{" "}
            <a href="https://vecarz.com/" target="_blank" rel="noreferrer" className={linkClass}>
              Vecarz
            </a>
            , Red Bull Racing livery from toddeppe&apos;s and VTX&apos;s versions ·{" "}
            <a href="http://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer" className={licenceClass}>
              CC BY-NC-SA 4.0
            </a>
            <br />
            &ldquo;2025 BMW M4 GT3 EVO G82&rdquo; (
            <a
              href="https://sketchfab.com/3d-models/2025-bmw-m4-gt3-evo-g82-113f83dd87064697a5ec2511d280b9d5"
              target="_blank"
              rel="noreferrer"
              className={linkClass}
            >
              sketchfab.com
            </a>
            ) by Ddiaz Design ·{" "}
            <a href="http://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer" className={licenceClass}>
              CC BY-NC-SA 4.0
            </a>
          </CreditRow>
          <CreditRow title={tx("tyresTitle")}>
            &ldquo;2025 Pirelli tyres&rdquo; by{" "}
            <a href="https://www.overtake.gg/members/purple-sector.3636642/" target="_blank" rel="noreferrer" className={linkClass}>
              Purple Sector
            </a>{" "}
            (
            <a href="https://www.patreon.com/cw/PurpleSector" target="_blank" rel="noreferrer" className={linkClass}>
              patreon.com/cw/PurpleSector
            </a>
            ) · the 2026 car&apos;s tyres · used with permission
            <br />
            &ldquo;2026 Pirelli Tire Pack&rdquo; (
            <a
              href="https://www.overtake.gg/downloads/pirelli-tire-pack-for-formula-hybrid-x-2026.81209/"
              target="_blank"
              rel="noreferrer"
              className={linkClass}
            >
              overtake.gg
            </a>
            ) by{" "}
            <a href="https://www.overtake.gg/members/cxjovich.4261212/" target="_blank" rel="noreferrer" className={linkClass}>
              Cxjovich
            </a>{" "}
            ·{" "}
            <a href="http://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer" className={licenceClass}>
              CC BY-NC-SA 4.0
            </a>{" "}
            · used with permission
            <br />
            &ldquo;RSS GT-M Tyre Extension Packs&rdquo; (Pirelli, Michelin, Goodyear, Bridgestone, Yokohama, Falken) by
            sagatron918
            <SagatronDonateLink /> · GT, prototype and classic racing tyres · used with permission
          </CreditRow>
          <CreditRow title="MTRacing 496R">
            Model, sound and physics from &ldquo;MTRacing 496R&rdquo; by{" "}
            <a href="https://www.overtake.gg/members/munyuturbo.1202939/" target="_blank" rel="noreferrer" className={linkClass}>
              munyuturbo
            </a>{" "}
            · used with permission
          </CreditRow>
          <CreditRow title={tx("nissansTitle")}>
            Models, liveries, sound and physics of the Skyline GT-R R33 JGTC and Skyline GT-R R32 JTCC by{" "}
            <a href="https://www.gtplanet.net/forum/members/greg_st.314907/" target="_blank" rel="noreferrer" className={linkClass}>
              gregsediting
            </a>{" "}
            (
            <a href="https://www.patreon.com/cw/gregsediting" target="_blank" rel="noreferrer" className={linkClass}>
              Patreon
            </a>
            ) · used with permission. R32 liveries also by Shin956 (UNISIA, Castrol), TOHIRA official (OTX, WISE SPORTS) and
            tomo 427 S/C (427 Motorsports, Tamiya); R32 sound by Neko Taisen
          </CreditRow>
          <CreditRow title={tx("pfalzdriverTitle")}>
            Models, liveries, sound and physics of the BMW M1 Procar, the Volkswagen Scirocco GTX 16V and the Porsche 934 Turbo
            RSR by{" "}
            <a href="https://www.gtplanet.net/forum/members/pfalzdriver.315633/" target="_blank" rel="noreferrer" className={linkClass}>
              Pfalzdriver
            </a>{" "}
            · used with permission. M1 Procar with DaWallace, its liveries by Johnny23, its sound by Ama FMOD
          </CreditRow>
          <CreditRow title="Chaparral 2D">
            Models, liveries, sound and physics of the 1966 and 1967 Chaparral 2D by{" "}
            <a href="https://www.overtake.gg/members/npanic.761347/" target="_blank" rel="noreferrer" className={linkClass}>
              NPanic
            </a>{" "}
            (
            <a href="https://www.paypal.com/paypalme/williampasta" target="_blank" rel="noreferrer" className={linkClass}>
              the team&rsquo;s PayPal
            </a>
            ) · used with permission. 3D model by Nugget &amp; NPanic, LoDs by Dodge33, skins by Pasta, physics by Bazza, CSP
            config by Valentin K, sound by Felix789
          </CreditRow>
          <CreditRow title="Suzuki Liana">
            Physics from &ldquo;Physics reworked for Top Gear Liana 1.6 GLX&rdquo; (
            <a
              href="https://www.overtake.gg/downloads/physics-reworked-for-top-gear-liana-1-6-glx.28636/"
              target="_blank"
              rel="noreferrer"
              className={linkClass}
            >
              overtake.gg
            </a>
            ) by{" "}
            <a href="https://www.overtake.gg/members/alekabul.294399/" target="_blank" rel="noreferrer" className={linkClass}>
              alekabul
            </a>{" "}
            · used with permission
          </CreditRow>
          {LISTED_TRACKS.some((t) => t.credit) ? (
            <CreditRow title={tx("circuitsTitle")}>
              {LISTED_TRACKS.filter((t, i, arr) => t.credit && arr.findIndex((o) => o.credit?.url === t.credit?.url) === i).map((t) => (
                <React.Fragment key={t.id}>
                  &ldquo;{t.credit!.title}&rdquo; (
                  <a href={t.credit!.short ?? t.credit!.url} target="_blank" rel="noreferrer" className={linkClass}>
                    {t.credit!.short ? t.credit!.short.replace(/^https?:\/\//, "") : t.credit!.url.replace(/^https?:\/\/(www\.)?([^/]+).*$/, "$2")}
                  </a>
                  ) by{" "}
                  {t.credit!.authorUrl ? (
                    <a href={t.credit!.authorUrl} target="_blank" rel="noreferrer" className={linkClass}>
                      {t.credit!.author}
                    </a>
                  ) : (
                    t.credit!.author
                  )}{" "}
                  ·{" "}
                  <a href={t.credit!.licenseUrl} target="_blank" rel="noreferrer" className={licenceClass}>
                    {t.credit!.license}
                  </a>
                  <br />
                </React.Fragment>
              ))}
              {tx("circuitsConverted")}
            </CreditRow>
          ) : null}
          <CreditRow title={tx("sceneryTitle")}>
            {SCENERY_CREDITS.map((c) => (
              <React.Fragment key={c.id}>
                &ldquo;{c.title}&rdquo; (
                <a href={c.url} target="_blank" rel="noreferrer" className={linkClass}>
                  sketchfab.com
                </a>
                ) by {c.author} ·{" "}
                <a href={c.licenseUrl} target="_blank" rel="noreferrer" className={licenceClass}>
                  {c.license}
                </a>
                <br />
              </React.Fragment>
            ))}
            {tx("sceneryNote")}
          </CreditRow>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lc-tile border border-lc-line bg-lc-well px-4 py-3.5 sm:px-5 sm:py-4">
        <div className="flex max-w-[600px] min-w-0 flex-col gap-1">
          <h3 className="lc-row-label m-0">{tx("rightsTitle")}</h3>
          <p className="lc-body m-0">{tx("rightsBody")}</p>
        </div>
        <Button href={TAKEDOWN_URL} target="_blank" rel="noopener noreferrer" variant="secondary" size="md" icon={<Icon name="externalLink" />}>
          {tx("rightsButton")}
        </Button>
      </div>

      <p className="lc-hint m-0 max-w-[620px] border-t border-lc-line pt-3.5">{tx("builtWith")}</p>
    </div>
  );
};

/**
 * The frosted sheet an open panel sits on, with its heading and a Close button. `.lc-title-frame` lets the
 * shared panels (also shown in the pause menu) switch their cards to the inset look of this sheet.
 */
const PanelFrame: React.FC<{
  /** A line under the heading where the panel is about one thing (the circuit a race is on) */
  subtitle?: string;
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ subtitle, title, onClose, children }) => {
  const { mode, family } = useInputMode();
  const tx = useTranslations("menu.panel");
  return (
    <div className="lc-title-frame lc-glass flex min-w-0 flex-col gap-4.5 rounded-lc-sheet p-5 text-lc-chalk sm:px-7 sm:pt-6 sm:pb-6.5 phone:gap-3.5 phone:p-3.5">
      {title ? (
        <div className="flex items-start justify-between gap-x-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            {/* As tall as Close beside it (36 px, 44 on touch screens), the heading centred in it: Close sits on the
                heading's line, not under it, where the button is taller than the heading (phones) */}
            <div className="flex min-h-9 items-center pointer-coarse:min-h-11">
              <h2 className="lc-h2 text-lc-chalk">{title}</h2>
            </div>
            {subtitle ? <p className="lc-body m-0 text-pretty">{subtitle}</p> : null}
          </div>
          {/* A pointer / touch affordance: a controller steps back with B, so the cursor skips it */}
          <Button
            variant="ghost"
            size="sm"
            data-nav-skip=""
            onClick={onClose}
            prompt={mode === "pad" ? <PadGlyph button="b" family={family} /> : <KeyCap>Esc</KeyCap>}
            icon={mode === "pad" ? undefined : <Icon name="close" />}
          >
            {tx("close")}
          </Button>
        </div>
      ) : null}
      {children}
    </div>
  );
};

interface MenuItem {
  id: string;
  label: string;
  detail?: string;
  icon: IconName;
  run?: () => void;
  /** A link out instead of an action: opens in a new tab */
  href?: string;
  panel?: TitlePanel;
  primary?: boolean;
  badge?: string;
  /** Label for the slim rail beside an open panel, where the full one would be cut */
  short?: string;
}

/** The active input device in the header */
const InputHint: React.FC<{ pad: PadState | undefined }> = ({ pad }) => {
  const tx = useTranslations("menu.title");
  const touch = !pad && isTouchDevice();
  const wheel = pad ? isLikelyWheel(pad) : false;
  const kind = pad ? (wheel ? tx("inputWheel") : tx("inputController")) : touch ? tx("inputTouch") : tx("inputKeyboard");
  const icon: IconName = pad ? (wheel ? "wheel" : "controller") : touch ? "touch" : "keyboard";
  return (
    <p className="m-0 flex min-w-0 items-center gap-2 text-[13px] text-lc-slate">
      <Icon name={icon} className="text-lc-fog" />
      <span className="min-w-0 truncate">
        <span className="font-semibold text-lc-fog">{kind}</span>
        {pad ? <span className="max-sm:hidden short:hidden">: {padDisplayName(pad.id).slice(0, 32)}</span> : null}
      </span>
    </p>
  );
};

/**
 * Title menu shown on every launch, over the live 3D grid (attract camera). The rail sits left so the car
 * stays in shot on the right; panels open beside it. A controller moves through every control
 * (rail, panel, sliders), LB / RB switch panels and Ⓑ steps back out.
 */
export const TitleMenu: React.FC<TitleMenuProps> = (props) => {
  const { firstRun, onDrive, onRaceAi, onControls, trackId = DEFAULT_TRACK_ID, onSelectTrack } = props;
  const track = getTrackInfo(trackId);
  // Back from Controls or a circuit load: the panel the player was on (read once; a StrictMode re-run must see it too)
  const [resume] = useState(() => (props.initialPanel ? null : peekResume(trackId)));
  // The panel asked for; `panel` below is the one shown, which must still be on offer
  const [chosenPanel, setPanel] = useState<TitlePanel | null>(props.initialPanel ?? resume?.panel ?? null);
  const [leaderboardJump, setLeaderboardJump] = useState<{ trackId: string; vehicle: VehicleModelId; seq: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const { mode } = useInputMode();
  // The music's footer control: once a track has played, or while the music is switched off
  const musicShown = Boolean(props.onToggleMusicMute) && (Boolean(props.nowPlaying) || props.musicMuted === true);
  const units = useUnits();
  const t = useTranslations("menu.title");
  const tp = useTranslations("menu.prompts");
  const tn = useTranslations("menu.upNext");
  const storeBuild = useStoreBuild();
  // The panel the circuit, car or conditions panel was opened from (the race setup's Event card, the room's Circuit
  // row): picking there returns to it
  const returnToRef = useRef<"race" | "multiplayer" | null>(null);

  // Scrolled down a long panel, LB / RB or Ⓑ still lands on an entry the player can see
  const focusRail = (id: string) => {
    const entry = rootRef.current?.querySelector<HTMLElement>(`[data-rail-id="${id}"]`);
    entry?.focus({ preventScroll: true });
    entry?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  useEffect(() => {
    resumeAt = null;
    if (resume) focusRail(resume.focus);
    // Mount only: where the menu came back to
  }, []);

  /** Remembers where to come back to, just before something unmounts the menu */
  const resumeHere = (focus: string, panelAfter: TitlePanel | null, forTrack = trackId) => {
    resumeAt = { panel: panelAfter, focus, trackId: forTrack, at: Date.now() };
  };

  // The title screen and the panel view draw the rail differently: keep the focus on its entry across the switch
  const keepFocus = (id: string) => {
    if (!rootRef.current?.contains(document.activeElement)) focusRail(id);
  };

  // Below lg the panel opens under the rail, usually off-screen: render it now and bring it into view
  const openPanel = (next: TitlePanel, opts: { returnTo?: "race" | "multiplayer" } = {}) => {
    returnToRef.current = opts.returnTo ?? null;
    flushSync(() => setPanel(next));
    keepFocus(next);
    if (window.matchMedia("(min-width: 64rem)").matches) return;
    // Instant: the tap's own touch gesture would cancel a smooth scroll
    panelRef.current?.scrollIntoView({ block: "start" });
  };

  const closePanel = () => {
    const from = document.activeElement?.closest("[data-rail-id]")?.getAttribute("data-rail-id") ?? panel;
    flushSync(() => setPanel(null));
    if (from) focusRail(from);
  };

  const pads = useGamepads();
  const pad = pads[0];
  const lobbyPlayers = props.lobby?.players.length ?? 0;

  // Outline of the active circuit (the scene's): only once its data is the loaded track
  const activeTrackId = ACTIVE_TRACK_ID;
  const map = useMemo(() => (activeTrackId === trackId ? buildHudMap(getTrackData()) : null), [activeTrackId, trackId]);

  const raceSetup = props.raceSetup ?? DEFAULT_RACE_SETUP;
  const vehicle = carById(props.carId);
  // The car is fixed for an online race (the shell refuses the swap too)
  const carLocked = props.telemetry.race?.multiplayer === true || props.raceRunning === true;
  // A hill climb is driven one car at a time, from the start line to the finish: no races against the AI
  const hillClimb = activeTrackId === trackId && getActivePointToPoint() !== null;
  // This car's personal best on this circuit, for the Lap times entry and the Up next sheet alike: this car's own laps
  // only (another car's never stands in), a lap on the current physics before an older one. Live: a best saved or
  // deleted, here or in another tab, shows at once
  const bestLaps = useBestLapSummaries();
  const pb = useMemo(
    () => bestLapForCircuit(bestLaps.filter((s) => s.vehicle === props.vehicleModel), trackId, props.vehicleModel),
    [bestLaps, trackId, props.vehicleModel],
  );
  const items: MenuItem[] = [
    {
      id: "drive",
      label: t("drive"),
      detail: firstRun ? t("driveQuickSetup") : hillClimb ? t("driveTimedRun") : undefined,
      icon: "drive" as const,
      run: onDrive,
      primary: true,
    },
    ...(hillClimb ? [] : [{
      id: "race",
      label: t("raceAi"),
      detail: t("raceAiDetail", {
        opponents: raceSetup.opponents,
        laps: raceSetup.laps,
        skill: aiSkillLabel(props.aiSkill ?? AI_SKILL_DEFAULT),
        start: raceStartSuffix(raceSetup.startMode, " · "),
      }),
      icon: "race" as const,
      // The race is set up first; its panel has the start (without a setter there is nothing to set: straight to the lights)
      ...(props.onChangeRaceSetup ? { panel: "race" as const, run: () => openPanel("race") } : { run: onRaceAi }),
    } satisfies MenuItem]),
    {
      id: "multiplayer",
      label: t("multiplayer"),
      icon: "multiplayer" as const,
      panel: "multiplayer",
      run: () => openPanel("multiplayer"),
      badge: props.races?.entry.state === "joined" ? t("multiplayerEntered") : lobbyPlayers > 1 ? t("multiplayerInLobby", { count: lobbyPlayers }) : undefined,
    },
    ...(props.challengePanel
      ? [
          {
            id: "challenge",
            label: t("challenge"),
            short: t("challengeShort"),
            detail: t("challengeDetail", {
              timeLeft: timeLeftLabel(props.challengePanel.challenge.endsMs, Date.now()),
              circuit: props.challengePanel.trackName,
            }),
            icon: "challenge" as const,
            panel: "challenge" as const,
            run: () => openPanel("challenge"),
          },
        ]
      : []),
    {
      id: "circuit",
      label: t("circuit"),
      detail: `${track.name} · ${lengthOf(track, units.speed)}`,
      icon: "circuit" as const,
      panel: "circuit",
      run: () => openPanel("circuit"),
    },
    {
      id: "car",
      label: t("car"),
      detail: carLocked ? t("carLocked", { car: vehicle.title }) : vehicle.title,
      icon: "car" as const,
      panel: "car",
      run: () => openPanel("car"),
    },
    ...(props.conditionsPanel
      ? [
          {
            id: "conditions",
            label: t("conditions"),
            detail: `${WEATHER_LABELS[props.conditionsPanel.conditions.weather].label} · ${TIME_OF_DAY_LABELS[props.conditionsPanel.conditions.timeOfDay]}`,
            icon: "conditions" as const,
            panel: "conditions" as const,
            run: () => openPanel("conditions"),
          },
        ]
      : []),
    {
      id: "garage",
      label: t("garage"),
      // The tyres the car goes out on (a road car's street tyres can't be changed)
      detail: vehicleModelSpec(vehicle.physics).onlyTyre ?? t("garageTyres", { compound: COMPOUNDS[props.tireCompound].name }),
      icon: "garage" as const,
      panel: "garage",
      run: () => openPanel("garage"),
    },
    ...(props.leaderboardPanel
      ? [
          {
            id: "leaderboard",
            label: t("lapTimes"),
            // This car's best on this circuit, when there is one
            detail: pb ? t("lapTimesBest", { time: formatLapTime(pb.lapTimeMs) }) : undefined,
            icon: "lapTimes" as const,
            panel: "leaderboard" as const,
            run: () => openPanel("leaderboard"),
          },
        ]
      : []),
    {
      id: "settings",
      label: t("settings"),
      icon: "settings" as const,
      // A screen over this one: closing it lands back on this entry, with the panel that was open still open
      run: () => (props.onOpenSettings ? props.onOpenSettings() : onControls()),
    },
    { id: "credits", label: t("credits"), icon: "credits" as const, panel: "credits", run: () => openPanel("credits") },
    {
      id: "request",
      label: t("feedback"),
      short: t("feedback"),
      icon: "feedback" as const,
      panel: "request",
      run: () => openPanel("request"),
    },
    { id: "press", label: t("press"), icon: "press" as const, href: withBasePath("/press") },
    { id: "privacy", label: t("privacy"), icon: "privacy" as const, href: withBasePath("/privacy") },
    // Not in the Android app (store-mode.ts)
    ...(storeBuild
      ? []
      : [{ id: "support", label: t("support"), icon: "support" as const, href: SUPPORT_URL }]),
    { id: "github", label: "GitHub", icon: "source" as const, href: REPO_URL },
  ];
  const panelItems = items.filter((i) => i.panel);
  // Some panels exist only while their props do: when an open one's go away, back to the title screen (and it stays
  // closed, rather than springing open again if they come back)
  const panel = chosenPanel && panelItems.some((i) => i.panel === chosenPanel) ? chosenPanel : null;
  useEffect(() => {
    if (chosenPanel && !panel) setPanel(null);
  }, [chosenPanel, panel]);
  const byId = (ids: readonly string[]) => ids.flatMap((id) => items.filter((i) => i.id === id));

  // Ⓑ: out of the panel to its rail entry, then close the panel (straight out where the rail is hidden: phones)
  const back = () => {
    if (panel && focusInZone(rootRef.current, "panel")) {
      const entry = rootRef.current?.querySelector<HTMLElement>(`[data-rail-id="${panel}"]`);
      if (entry && entry.offsetParent !== null) return focusRail(panel);
    }
    if (panel) closePanel();
  };
  // LB / RB: the neighbouring panel, with the focus on its rail entry
  const cycle = (step: number) => {
    const i = panelItems.findIndex((p) => p.panel === panel);
    // No panel open: RB starts at the first, LB at the last (from -1, a step back would land on the one before last)
    const from = i >= 0 ? i : step > 0 ? -1 : 0;
    const next = panelItems[(from + step + panelItems.length) % panelItems.length] ?? panelItems[0];
    if (!next?.panel) return;
    returnToRef.current = null;
    flushSync(() => setPanel(next.panel!));
    const entry = rootRef.current?.querySelector<HTMLElement>(`[data-rail-id="${next.id}"]`);
    // Below lg the slim rail is hidden: the cursor goes into the panel instead of nowhere
    if (entry && entry.offsetParent === null) {
      focusZone(rootRef.current, "panel");
      panelRef.current?.scrollIntoView({ block: "start" });
    } else focusRail(next.id);
  };
  // Menu / Start is the screen's main action: the race on the race setup, Drive on the title screen
  const raceOpen = panel === "race" && Boolean(props.onChangeRaceSetup);
  useFocusNav(rootRef, {
    onBack: back,
    onPrevTab: () => cycle(-1),
    onNextTab: () => cycle(1),
    onStart: raceOpen ? onRaceAi : panel ? undefined : onDrive,
    // The Garage's rows have a reset each: Delete / X puts the row under the cursor back, and the prompt bar says so
    rowReset: panel === "garage",
  });
  const rowResettable = useRowResettable(panel === "garage");
  // Up / down inside an open panel follow reading order and never fall out to the rail
  usePanelReadingOrder(rootRef);

  const panelTitle = items.find((i) => i.panel === panel)?.label;
  // The heading speaks for itself; the race setup says which circuit it is on, under it (Lap times picks its own)
  const panelSubtitle: Partial<Record<TitlePanel, string>> = {
    race: `${track.name}${track.layout ? ` · ${track.layout}` : ""}`,
  };

  const vehicleColor = carClass(vehicle.classId).color;
  const livery = props.selectedLivery;
  // A car with liveries of its own wears the one picked for it (read on each render: the menus re-render as panels change)
  const skin = carSkinFor(vehicle.id);
  const hudPreset = props.displayPanel?.settings.hud.preset;
  const assistLabels: Record<PauseMenuProps["assistPreset"], string> = {
    pro: tn("assistsPro"),
    semi_pro: tn("assistsSemiPro"),
    assisted: tn("assistsAssisted"),
  };
  // What a bug report gets without the player typing it
  const feedbackContext: FeedbackContext = feedbackContextOf(track, vehicle.title, props.displayPanel?.settings);

  // A rail entry for the title screen or the slim rail: the open panel's entry is chosen
  const row = (item: MenuItem, size: "lg" | "md" | "sm", slim = false) => (
    <RailRow
      key={item.id}
      id={item.id}
      label={slim ? (item.short ?? item.label) : item.label}
      detail={slim || size === "sm" ? undefined : item.detail}
      icon={item.icon}
      size={size}
      // The title screen mixes rows with and without a detail line, side by side and one under another: their labels
      // stay on one line
      align={slim || size === "sm" ? "center" : "top"}
      tone={slim ? "slate" : "chalk"}
      chosen={slim && item.panel === panel}
      expanded={item.panel ? item.panel === panel : undefined}
      href={item.href}
      onClick={item.run}
      badge={
        item.badge ? (
          <Badge tone="info" size="sm" className="group-focus:bg-lc-void group-focus:text-lc-volt">
            {item.badge}
          </Badge>
        ) : undefined
      }
    />
  );
  const drive = items.find((i) => i.id === "drive")!;

  const prompts: Prompt[] = [
    { action: "move", label: tp("move") },
    { action: "select", label: tp("select") },
    ...(rowResettable ? [RESET_ROW_PROMPT] : []),
    ...(panel ? [{ action: "back" as const, label: panelTitle ? tp("closePanel", { panel: panelTitle }) : tp("back") }] : []),
    { action: "tabs", label: tp("switchPanel") },
    // The online board turns its pages with the triggers (Z / C), the shoulders stay the panels
    ...(panel === "leaderboard" && props.leaderboardPanel?.remoteEnabled ? [{ action: "pages" as const, label: tp("page") }] : []),
    // A controller's Menu button has no key: shown with a pad only
    ...(mode === "pad" && (raceOpen || !panel) ? [{ action: "start" as const, label: raceOpen ? tp("startRace") : tp("drive") }] : []),
  ];
  const phonePrompts = prompts.filter((p) => p.action !== "move" && p.action !== "tabs");

  return (
    <div
      ref={rootRef}
      className={`lc-ui-zoom pointer-events-auto fixed inset-0 z-40 flex flex-col overflow-y-auto [scrollbar-gutter:stable_both-edges] pr-[max(1.25rem,env(safe-area-inset-right))] pb-[max(1.25rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(2.5rem,env(safe-area-inset-right))] sm:pl-[max(2.5rem,env(safe-area-inset-left))] ${
        panel
          ? "bg-linear-to-r from-lc-void/97 via-lc-void/90 via-60% to-lc-void/40 pt-[max(1.75rem,env(safe-area-inset-top))] short:pt-[max(1rem,env(safe-area-inset-top))]"
          : "bg-linear-to-r from-lc-void/97 via-lc-void/80 via-35% to-transparent to-70% pt-[max(clamp(1.5rem,3.6vh,2.5rem),env(safe-area-inset-top))] max-lg:bg-lc-void/80 max-lg:bg-none short:pt-[max(1rem,env(safe-area-inset-top))]"
      } ${raceOpen ? "scroll-pb-24" : ""}`}
    >
      {/* The menu is not drawn while Settings is open over it (SettingsScreen marks <html data-settings-open>): its
          frosted panel and volt buttons glowed through Settings' scrim and cards. Its own scrim (the root's gradient)
          stays, so the scene behind Settings is as dim as before. Hidden, not removed, it keeps its panel, scroll and
          the entry Settings hands the focus back to */}
      <div
        className={`flex w-full flex-1 flex-col in-data-[settings-open]:invisible ${panel ? "gap-5.5" : "gap-[clamp(20px,3vh,32px)]"} short:gap-4`}
      >
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
            <LibreCorsaLogo variant="compact" size={panel ? "sm" : "md"} />
            {/* Beside the logo: who is driving now and how many have (gone with the online side) */}
            <LiveLine className="short:hidden" />
            <EmbeddedBadge />
            {/* Never beside the badge: a framed game offers no install */}
            <InstallAppButton />
            {/* A newer build is out: from the title screen a reload loses nothing, unless it leaves a room or a race */}
            <UpdateReady
              endsSession={
                props.lobby
                  ? t("updateLeavesRoom")
                  : props.races?.entry.state === "joined" || props.races?.entry.state === "joining"
                    ? t("updateLeavesRace")
                    : undefined
              }
            />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
            <InputHint pad={pad} />
            {panel || !props.profile ? null : props.displayPanel ? (
              // A raised button, chalk on titanium: a ghost's slate label read as greyed out beside the input hint
              <Button
                variant="secondary"
                size="sm"
                // The name shown comes first, so saying it presses the button
                aria-label={t("editProfile", { name: props.profile.name })}
                onClick={() => props.onOpenSettings?.("profile")}
                icon={
                  <span
                    className="size-4 rounded-full inset-ring-2 inset-ring-white/25"
                    // The driver's own colour is data
                    style={{ background: props.profile.color }}
                  />
                }
              >
                <span className="max-w-[10rem] truncate" title={props.profile.name}>{props.profile.name}</span>
              </Button>
            ) : (
              <span className="inline-flex items-center gap-2 text-[14px] font-semibold text-lc-chalk">
                <span
                  aria-hidden
                  className="size-4 rounded-full"
                  // The driver's own colour is data
                  style={{ background: props.profile.color }}
                />
                {props.profile.name}
              </span>
            )}
          </div>
        </header>

        {panel ? (
          /* Panel view: slim rail + the panel's sheet */
          <div
            className={`grid flex-1 grid-cols-1 items-start gap-5 lg:gap-7 ${
              panel === "multiplayer" && !props.lobby && !props.races ? MULTIPLAYER_ALONE : (PANEL_COLUMNS[panel] ?? PANEL_WIDTH)
            }`}
          >
            {/* Below lg the rail would stack 13 rows above the panel: the panel takes the screen, Close goes back */}
            <nav className="flex flex-col gap-0.5 max-lg:hidden" data-nav-zone="rail" aria-label={t("mainMenu")}>
              <HeroAction id={drive.id} label={drive.label} onClick={drive.run!} size="slim" />
              {byId(["race", "multiplayer", "challenge"]).map((item) => row(item, "md", true))}
              <div aria-hidden className="h-3" />
              {byId(["circuit", "car", "conditions", "garage", "leaderboard", "settings"]).map((item) => row(item, "md", true))}
              <div aria-hidden className="h-3" />
              {byId(["credits", "request", "press", "privacy", "support", "github"]).map((item) => row(item, "md", true))}
            </nav>

            <section ref={panelRef} className="min-h-0 min-w-0 scroll-mt-4" data-nav-zone="panel" aria-label={panelTitle}>
              <div key={panel}>
                <PanelFrame subtitle={panelSubtitle[panel]} title={panelTitle} onClose={closePanel}>
                  {panel === "race" && props.onChangeRaceSetup ? (
                    <RaceSetupPanel
                      setup={raceSetup}
                      onChange={props.onChangeRaceSetup}
                      aiSkill={props.aiSkill}
                      onChangeAiSkill={props.onChangeAiSkill}
                      track={track}
                      conditionsLabel={
                        props.conditionsPanel
                          ? `${WEATHER_LABELS[props.conditionsPanel.conditions.weather].label} · ${TIME_OF_DAY_LABELS[props.conditionsPanel.conditions.timeOfDay]}`
                          : undefined
                      }
                      car={{ id: vehicle.id, quality: vehicle.quality, title: vehicle.title, badge: vehicle.badge, color: vehicleColor }}
                      playerCode={props.profile?.code}
                      playerColor={props.profile?.color}
                      onOpenCircuit={() => openPanel("circuit", { returnTo: "race" })}
                      onOpenConditions={props.conditionsPanel ? () => openPanel("conditions", { returnTo: "race" }) : undefined}
                      onOpenGarage={() => openPanel("car", { returnTo: "race" })}
                      onStart={onRaceAi}
                    />
                  ) : null}
                  {panel === "circuit" ? (
                    <CircuitBrowser
                      trackId={trackId}
                      vehicleModel={props.vehicleModel}
                      driverName={props.profile?.name ?? props.leaderboardPanel?.driverName}
                      boardVersion={props.leaderboardPanel?.boardVersion}
                      onSelect={
                        onSelectTrack
                          ? (id) => {
                              // The scene reloads: come back to the race setup or the room if that is where the player came from
                              const from = returnToRef.current;
                              const back: TitlePanel =
                                from === "race" && props.onChangeRaceSetup ? "race" : from === "multiplayer" ? "multiplayer" : "circuit";
                              resumeHere(back, back, id);
                              return onSelectTrack(id);
                            }
                          : undefined
                      }
                      library={props.library}
                    />
                  ) : null}
                  {panel === "conditions" && props.conditionsPanel ? (
                    <ConditionsPanel {...props.conditionsPanel} onOpenSettings={props.onOpenSettings} />
                  ) : null}
                  {panel === "car" ? (
                    <CarBrowser
                      carId={props.carId}
                      onChangeCar={(id) => {
                        props.onChangeCar(id);
                        // Picked from the race setup's Event card: back to the race with its new car
                        if (returnToRef.current === "race" && props.onChangeRaceSetup) openPanel("race");
                      }}
                      selectedLivery={props.selectedLivery}
                      onChangeLivery={props.onChangeLivery}
                      library={props.library}
                      lockedReason={carLocked ? t("carFixed") : undefined}
                    />
                  ) : null}
                  {panel === "garage" ? <EngineersGarage {...props} onOpenCarBrowser={() => openPanel("car")} /> : null}
                  {panel === "multiplayer" ? (
                    <MultiplayerPanel
                      {...props}
                      onPickCircuit={onSelectTrack ? () => openPanel("circuit", { returnTo: "multiplayer" }) : undefined}
                    />
                  ) : null}
                  {panel === "challenge" && props.challengePanel ? (
                    <ChallengePanel
                      {...props.challengePanel}
                      onOpenBoard={
                        props.leaderboardPanel
                          ? (jumpTrackId, jumpVehicle) => {
                              setLeaderboardJump((prev) => ({ trackId: jumpTrackId, vehicle: jumpVehicle, seq: (prev?.seq ?? 0) + 1 }));
                              openPanel("leaderboard");
                            }
                          : undefined
                      }
                    />
                  ) : null}
                  {panel === "leaderboard" && props.leaderboardPanel ? (
                    <LeaderboardPanel {...props.leaderboardPanel} jumpTarget={leaderboardJump} />
                  ) : null}
                  {panel === "credits" ? <Credits /> : null}
                  {panel === "request" ? (
                    // The frame above names it, with Close beside the name: the panel leaves out its own heading
                    <RequestPanel
                      context={feedbackContext}
                      facts={props.reportFacts ? () => props.reportFacts!(false) : undefined}
                      heading={false}
                    />
                  ) : null}
                </PanelFrame>
              </div>
            </section>
          </div>
        ) : (
          /* Title screen: the menu bottom-left, what Drive launches bottom-right (a div: the /play page's <main> holds it) */
          <div className="flex flex-1 flex-wrap items-end justify-between gap-8 compact:items-start short:gap-5">
            {/* Landscape phones put the setup beside the actions instead of under them, so it all fits one screen */}
            <nav
              className="flex w-full max-w-[460px] flex-col gap-1 xl:max-w-[500px] short:grid short:max-w-none short:grid-cols-2 short:items-start short:gap-x-5"
              data-nav-zone="rail"
              aria-label={t("mainMenu")}
            >
              <div className="flex flex-col gap-1 phone:gap-0.5">
                <HeroAction id={drive.id} label={drive.label} detail={drive.detail} onClick={drive.run!} />
                {byId(["race", "multiplayer", "challenge"]).map((item) => row(item, "lg"))}
              </div>
              <div className="flex flex-col gap-3 pt-4 compact:pt-2 short:pt-0">
                <div className="grid grid-cols-1 gap-1 min-[360px]:grid-cols-2">
                  {byId(["circuit", "car", "conditions", "garage", "leaderboard", "settings"]).map((item) => row(item, "md"))}
                </div>
                <div className="flex flex-wrap items-center gap-x-0.5 gap-y-0.5 border-t border-lc-line pt-2.5 short:pt-1.5">
                  {byId(["credits", "request", "press", "privacy", "support", "github"]).map((item) => row(item, "sm"))}
                </div>
              </div>
            </nav>

            <div className="flex w-full max-w-[380px] flex-col gap-3">
            {props.supportNote?.length ? (
              <SupportNote items={props.supportNote} onClose={props.onCloseSupportNote} onThanked={props.onSupportThanked} />
            ) : null}
            <Sheet role="region" aria-label={tn("region")} className="flex w-full flex-col gap-4 short:hidden">
              <div className="flex items-center gap-4">
                {map ? <TrackOutline map={map} thin className="h-[84px] w-[104px] shrink-0" /> : null}
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 className="lc-h3 line-clamp-3 text-balance" title={track.name}>{track.name}</h2>
                  <p className="lc-hint m-0 line-clamp-2">{[track.layout, track.city].filter(Boolean).join(" · ")}</p>
                  <p className="lc-hint m-0">
                    <span className="lc-mono text-lc-fog">{lengthOf(track, units.speed)}</span>
                    {" · "}
                    {tn.rich("turns", { count: track.turns, n: (chunks) => <span className="lc-mono text-lc-fog">{chunks}</span> })}
                  </p>
                  <div className="pt-1">
                    <TrackQualityBadge track={track} size="sm" />
                  </div>
                </div>
              </div>
              <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 border-t border-lc-line pt-3.5">
                <dt className="lc-hint">{tn("car")}</dt>
                <dd className="m-0 flex min-w-0 items-center justify-end gap-2 text-[14px] font-semibold">
                  <CarClassTag car={vehicle} size="sm" />
                  <span className="line-clamp-2 text-end">{vehicle.title}</span>
                </dd>
                {livery ? (
                  <>
                    <dt className="lc-hint">{tn("livery")}</dt>
                    <dd className="m-0 flex min-w-0 items-center justify-end gap-2 text-[14px] font-semibold">
                      {skin ? (
                        <>
                          <span
                            aria-hidden
                            className="h-3 w-7 shrink-0 rounded-full"
                            // A livery's own swatch is data
                            style={{ background: carSkinSwatchBackground(skin) }}
                          />
                          <span className="line-clamp-2 text-end">{skin.name}</span>
                        </>
                      ) : vehicle.modelUrl ? (
                        <span className="truncate">{tn("factory")}</span>
                      ) : (
                        <>
                          <span
                            aria-hidden
                            className="h-3 w-7 shrink-0 rounded-full"
                            style={{
                              // A livery's own colours are data
                              background: `linear-gradient(135deg, ${livery.primary} 0 50%, ${livery.secondary} 50% 62%, ${livery.accent} 62% 100%)`,
                            }}
                          />
                          <span className="line-clamp-2 text-end">{livery.name}</span>
                        </>
                      )}
                    </dd>
                  </>
                ) : null}
                <dt className="lc-hint">{tn("assists")}</dt>
                <dd className="m-0 line-clamp-2 text-end text-[14px] font-semibold">
                  {(() => {
                    // A class without ABS runs the middle preset on TC alone
                    const assists =
                      props.assistPreset === "semi_pro" && props.telemetry.liveTuner?.absAllowed === false
                        ? tn("assistsTcOnly")
                        : (assistLabels[props.assistPreset] ?? props.assistPreset);
                    return props.showRacingLine ? tn("withRacingLine", { assists }) : assists;
                  })()}
                </dd>
                {hudPreset ? (
                  <>
                    <dt className="lc-hint">{tn("hud")}</dt>
                    <dd className="m-0 line-clamp-2 text-end text-[14px] font-semibold">{hudLayout(hudPreset).label}</dd>
                  </>
                ) : null}
                <dt className="lc-hint">{tn("personalBest")}</dt>
                <dd className="m-0 flex min-w-0 items-center justify-end gap-2 text-[14px] font-semibold">
                  {pb ? (
                    <>
                      {/* Only a lap from before the current physics: it says so, as the Circuits cards do */}
                      {pb.legacyPhysics ? (
                        <span className="truncate text-[12px] font-normal text-lc-slate">{tn("oldPhysics")}</span>
                      ) : null}
                      <span className={cx("lc-mono", pb.legacyPhysics && "text-lc-fog")}>{formatLapTime(pb.lapTimeMs)}</span>
                    </>
                  ) : (
                    <span className="text-lc-fog">{tn("noTimeYet")}</span>
                  )}
                </dd>
              </dl>
            </Sheet>
            </div>
          </div>
        )}

        {/* Touch screens have no keys to show: the prompts come back with a pad. The music's control stays */}
        <footer
          className={`flex items-center justify-between gap-3 border-t border-lc-line pt-3 ${mode === "pad" || musicShown ? "" : "pointer-coarse:hidden"}`}
        >
          <div className={`min-w-0 ${mode === "pad" ? "" : "pointer-coarse:hidden"}`}>
            <ShellPrompts prompts={prompts} phonePrompts={phonePrompts} />
          </div>
          {musicShown ? (
            <TitleMusic
              nowPlaying={props.nowPlaying ?? null}
              musicMuted={props.musicMuted === true}
              onSkip={props.onSkipTrack}
              onToggleMute={props.onToggleMusicMute!}
            />
          ) : null}
        </footer>
      </div>
    </div>
  );
};
