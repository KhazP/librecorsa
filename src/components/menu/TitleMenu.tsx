"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { PauseMenuProps } from "@/components/hud/PauseMenu";
import { carById, carClass } from "@/lib/cars/car-registry";
import { carSkinFor } from "@/lib/cars/car-skins";
import { EngineersGarage } from "./EngineersGarage";
import { MultiplayerPanel } from "@/components/hud/MultiplayerPanel";
import { ChallengePanel, type ChallengePanelProps } from "@/components/menu/ChallengePanel";
import { timeLeftLabel } from "@/lib/net/weekly-challenge";
import { LeaderboardPanel } from "@/components/hud/LeaderboardPanel";
import { buildHudMap } from "@/components/hud/styles/hud-style-parts";
import { ACTIVE_TRACK_ID, getActivePointToPoint, getTrackData } from "@/lib/track-data";
import { getTrackInfo, DEFAULT_TRACK_ID, TRACKS, type TrackInfo } from "@/lib/track-registry";
import { SCENERY_CREDITS } from "@/lib/render/scenery-credits";
import { isLikelyWheel, padDisplayName } from "@/lib/input/device-input";
import { isTouchDevice } from "@/lib/input/touch-input";
import type { HudPreset, SpeedUnit } from "@/lib/settings/player-settings";
import { useUnits } from "@/lib/settings/ui-prefs";
import { DISTANCE_LABEL, distanceIn } from "@/lib/settings/units";
import { useGamepads, type PadState } from "./useMenuNav";
import { focusInZone, focusZone, useFocusNav } from "./useFocusNav";
import { useInputMode } from "./input-mode";
import { Button, Sheet } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import type { IconName } from "@/components/ui/icons/registry";
import { KeyCap } from "@/components/ui/prompts/KeyCap";
import { PadGlyph } from "@/components/ui/prompts/PadGlyph";
import type { Prompt } from "@/components/ui/prompts/PromptBar";
import { CarClassTag, TrackQualityBadge } from "./menu-content-ui";
import { HeroAction, RailRow, RESET_ROW_PROMPT, ShellPrompts, usePanelReadingOrder, useRowResettable } from "./menu-shell";
import { RequestPanel, type FeedbackContext } from "./RequestPanel";
import { CircuitBrowser } from "./CircuitBrowser";
import { CarBrowser } from "./CarBrowser";
import { TrackOutline } from "./circuit-outline";
import { ConditionsPanel } from "./ConditionsPanel";
import { RaceSetupPanel } from "./RaceSetupPanel";
import { DEFAULT_RACE_SETUP, RACE_START_LABELS } from "@/lib/sim/race-setup";
import { TIME_OF_DAY_LABELS, WEATHER_LABELS } from "@/lib/sim/weather";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { AI_SKILL_DEFAULT, aiSkillLabel } from "@/lib/sim/ai-tuning";
import { REPO_URL, SUPPORT_URL, TAKEDOWN_URL } from "@/lib/site";
import { withBasePath } from "@/lib/base-path";
import { EmbeddedBadge } from "./EmbeddedBadge";

type TitlePanel = "race" | "circuit" | "car" | "conditions" | "garage" | "multiplayer" | "challenge" | "leaderboard" | "display" | "credits" | "request";

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
}

const linkClass = "text-lc-chalk underline decoration-lc-keyline underline-offset-2 hover:decoration-lc-chalk";

const ASSIST_LABELS: Record<PauseMenuProps["assistPreset"], string> = {
  pro: "No assists",
  semi_pro: "TC + ABS",
  assisted: "Full assists",
};

const HUD_LABELS: Record<HudPreset, string> = {
  broadcast: "Broadcast",
  dash: "Wheel dash",
  telemetry: "Telemetry",
  classic: "Classic",
  minimal: "Minimal",
};

/** A circuit's length in the player's units ("5.34 km") */
const lengthOf = (t: TrackInfo, unit: SpeedUnit) => `${distanceIn(t.lengthM / 1000, unit).toFixed(2)} ${DISTANCE_LABEL[unit]}`;

const CreditRow: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex flex-col gap-1.5 border-t border-lc-line py-4">
    <h3 className="lc-row-label m-0">{title}</h3>
    <p className="lc-body m-0">{children}</p>
  </div>
);

const Credits: React.FC = () => (
  <div className="flex flex-col gap-4.5">
    <p className="m-0 max-w-[760px] text-[18px] leading-snug font-semibold text-lc-chalk sm:text-[20px]">
      LibreCorsa is an open-source browser racing sim with open-wheel prototypes, GT3 cars, road cars and an open
      circuit pipeline.
    </p>

    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-x-8">
      <div>
        <CreditRow title="Physics & dynamics">
          500 Hz 6-DOF rigid-body solver, Pacejka Magic Formula &amp; normalized-slip tyre models with 9-node thermal
          dynamics, active aerodynamics, and hybrid ERS.
        </CreditRow>
        <CreditRow title="Graphics & audio">
          WebGL2 PBR rendering with GPU tyre deformation, golden-hour lighting and multi-layer Web Audio synthesis.
        </CreditRow>
      </div>
      <div>
        <CreditRow title="3D car models">
          2026 Prototype: &ldquo;F1 2026 concept (polygon model)&rdquo; by{" "}
          <a href="https://qvistdesigns.framer.website/" target="_blank" rel="noreferrer" className={linkClass}>
            Qvist Designs
          </a>
          , steering wheel from DeX&apos;s AM26 (
          <a href="https://skfb.ly/pKNCK" target="_blank" rel="noreferrer" className={linkClass}>
            skfb.ly/pKNCK
          </a>
          ) ·{" "}
          <a href="http://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" className={linkClass}>
            CC BY 4.0
          </a>
          . Its Oracle Red Bull Racing livery uses pictures from an Assetto Corsa skin made for VRC&apos;s Formula Alpha
          2026; the logos are their owners&apos; trademarks
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
          <a href="http://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer" className={linkClass}>
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
          <a href="http://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer" className={linkClass}>
            CC BY-NC-SA 4.0
          </a>
        </CreditRow>
        <CreditRow title="Tyres">
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
          <a href="http://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer" className={linkClass}>
            CC BY-NC-SA 4.0
          </a>{" "}
          · used with permission
        </CreditRow>
        <CreditRow title="MTRacing 496R">
          Model, sound and physics from &ldquo;MTRacing 496R&rdquo; by{" "}
          <a href="https://www.overtake.gg/members/munyuturbo.1202939/" target="_blank" rel="noreferrer" className={linkClass}>
            munyuturbo
          </a>{" "}
          · used with permission
        </CreditRow>
        <CreditRow title="Classic Nissans">
          Models, liveries, sound and physics of the Skyline GT-R R33 JGTC and Skyline GT-R R32 JTCC by{" "}
          <a href="https://www.patreon.com/gregsediting" target="_blank" rel="noreferrer" className={linkClass}>
            gregsediting
          </a>{" "}
          · used with permission. R32 liveries also by Shin956 (UNISIA, Castrol), TOHIRA official (OTX, WISE SPORTS) and
          tomo 427 S/C (427 Motorsports, Tamiya); R32 sound by Neko Taisen
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
        {TRACKS.some((t) => t.credit) ? (
          <CreditRow title="Circuits">
            {TRACKS.filter((t, i, arr) => t.credit && arr.findIndex((o) => o.credit?.url === t.credit?.url) === i).map((t) => (
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
                <a href={t.credit!.licenseUrl} target="_blank" rel="noreferrer" className={linkClass}>
                  {t.credit!.license}
                </a>
                <br />
              </React.Fragment>
            ))}
            Converted for the simulator (rescaled, recentred, textures re-encoded, physics colliders added).
          </CreditRow>
        ) : null}
        <CreditRow title="Trackside scenery (RISE Motordrome)">
          {SCENERY_CREDITS.map((c) => (
            <React.Fragment key={c.id}>
              &ldquo;{c.title}&rdquo; (
              <a href={c.url} target="_blank" rel="noreferrer" className={linkClass}>
                sketchfab.com
              </a>
              ) by {c.author} ·{" "}
              <a href={c.licenseUrl} target="_blank" rel="noreferrer" className={linkClass}>
                {c.license}
              </a>
              <br />
            </React.Fragment>
          ))}
          Simplified, textures re-encoded, placed at the circuit&apos;s tree, bush and helicopter spots. The stands
          and other props are the project&apos;s own.
        </CreditRow>
      </div>
    </div>

    <div className="flex flex-wrap items-center justify-between gap-4 rounded-lc-tile border border-lc-line bg-lc-well px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex max-w-[600px] min-w-0 flex-col gap-1">
        <h3 className="lc-row-label m-0">Rights holders and takedown</h3>
        <p className="lc-body m-0">
          If you made a model, texture, sound or other asset used here and it is uncredited, credited wrongly, under the
          wrong license, or not meant to be in LibreCorsa, tell me: I will fix it or take it down, usually within 7 days.
        </p>
      </div>
      <Button href={TAKEDOWN_URL} target="_blank" rel="noopener noreferrer" variant="secondary" size="md" icon={<Icon name="externalLink" />}>
        Rights or takedown request
      </Button>
    </div>

    <p className="lc-hint m-0 max-w-[620px] border-t border-lc-line pt-3.5">
      Built with Next.js, React, Three.js and Tailwind CSS. Source code licensed under MIT; 3D and audio assets are for
      non-commercial educational use only.
    </p>
  </div>
);

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
  return (
    <div className="lc-title-frame lc-glass flex min-w-0 flex-col gap-4.5 rounded-lc-sheet p-5 text-lc-chalk sm:px-7 sm:pt-6 sm:pb-6.5 phone:gap-3.5 phone:p-3.5">
      {title ? (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 className="lc-h2 text-lc-chalk">{title}</h2>
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
            Close
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
  detail: string;
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

/** The input in use, as one quiet line: what drives the menus, and how to switch */
const InputHint: React.FC<{ pad: PadState | undefined }> = ({ pad }) => {
  // A phone or tablet drives with the on-screen controls until a pad is plugged in
  const touch = !pad && isTouchDevice();
  const wheel = pad ? isLikelyWheel(pad) : false;
  const kind = pad ? (wheel ? "Wheel" : "Controller") : touch ? "Touch" : "Keyboard";
  const icon: IconName = pad ? (wheel ? "wheel" : "controller") : touch ? "touch" : "keyboard";
  const rest = pad ? padDisplayName(pad.id).slice(0, 40) : "press any button on a controller or wheel to use it";
  return (
    <p className="m-0 flex min-w-0 items-center gap-2 text-[13px] text-lc-slate">
      <Icon name={icon} className="text-lc-fog" />
      <span className="min-w-0 truncate">
        <span className="font-semibold text-lc-fog">{kind}</span>
        <span className="max-sm:hidden short:hidden">
          {pad ? ": " : ", or "}
          {rest}
        </span>
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const { mode } = useInputMode();
  const units = useUnits();
  // The circuit panel opened from the race setup's Event card: loading a circuit then returns to the race setup
  const fromRaceRef = useRef(false);

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
  const openPanel = (next: TitlePanel, opts: { fromRace?: boolean } = {}) => {
    fromRaceRef.current = Boolean(opts.fromRace);
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
  const items: MenuItem[] = [
    {
      id: "drive",
      label: "Drive",
      detail: firstRun ? "Quick setup, then out on track" : hillClimb ? "Timed runs, start to finish" : "Practice from the grid",
      icon: "drive" as const,
      run: onDrive,
      primary: true,
    },
    ...(hillClimb ? [] : [{
      id: "race",
      label: "Race AI",
      detail: `${raceSetup.opponents} AI ${raceSetup.opponents === 1 ? "car" : "cars"} · ${raceSetup.laps} ${raceSetup.laps === 1 ? "lap" : "laps"} · ${aiSkillLabel(props.aiSkill ?? AI_SKILL_DEFAULT)} · ${RACE_START_LABELS[raceSetup.start].toLowerCase()} start`,
      icon: "race" as const,
      // The race is set up first; its panel has the start (without a setter there is nothing to set: straight to the lights)
      ...(props.onChangeRaceSetup ? { panel: "race" as const, run: () => openPanel("race") } : { run: onRaceAi }),
    } satisfies MenuItem]),
    {
      id: "multiplayer",
      label: "Multiplayer",
      detail: props.races ? "Open races · rooms with friends" : "Race friends peer-to-peer",
      icon: "multiplayer" as const,
      panel: "multiplayer",
      run: () => openPanel("multiplayer"),
      badge: props.races?.entry.state === "joined" ? "In the next race" : lobbyPlayers > 1 ? `${lobbyPlayers} in lobby` : undefined,
    },
    ...(props.challengePanel
      ? [
          {
            id: "challenge",
            label: "Weekly challenge",
            short: "Challenge",
            detail: `${props.challengePanel.trackName} · ${props.challengePanel.carTitle} · ${timeLeftLabel(props.challengePanel.challenge.endsMs, Date.now())} left`,
            icon: "challenge" as const,
            panel: "challenge" as const,
            run: () => openPanel("challenge"),
          },
        ]
      : []),
    {
      id: "circuit",
      label: "Circuit",
      detail: `${track.name} · ${lengthOf(track, units.speed)}`,
      icon: "circuit" as const,
      panel: "circuit",
      run: () => openPanel("circuit"),
    },
    {
      id: "car",
      label: "Car",
      detail: carLocked ? `${vehicle.title} · fixed for this race` : vehicle.title,
      icon: "car" as const,
      panel: "car",
      run: () => openPanel("car"),
    },
    ...(props.conditionsPanel
      ? [
          {
            id: "conditions",
            label: "Conditions",
            detail: `${WEATHER_LABELS[props.conditionsPanel.conditions.weather].label} · ${TIME_OF_DAY_LABELS[props.conditionsPanel.conditions.timeOfDay]}`,
            icon: "conditions" as const,
            panel: "conditions" as const,
            run: () => openPanel("conditions"),
          },
        ]
      : []),
    { id: "garage", label: "Garage", detail: "Setup, presets and livery", icon: "garage" as const, panel: "garage", run: () => openPanel("garage") },
    ...(props.leaderboardPanel
      ? [{ id: "leaderboard", label: "Lap times", detail: "Leaderboard and ghosts", icon: "lapTimes" as const, panel: "leaderboard" as const, run: () => openPanel("leaderboard") }]
      : []),
    {
      id: "settings",
      label: "Settings",
      detail: "Controls, assists, display, sound",
      icon: "settings" as const,
      // A screen over this one: closing it lands back on this entry, with the panel that was open still open
      run: () => (props.onOpenSettings ? props.onOpenSettings() : onControls()),
    },
    { id: "credits", label: "Credits", detail: "Open-source sim · asset sources", icon: "credits" as const, panel: "credits", run: () => openPanel("credits") },
    {
      id: "request",
      label: "Feedback & requests",
      short: "Feedback",
      detail: "Bugs, ideas, cars and tracks",
      icon: "feedback" as const,
      panel: "request",
      run: () => openPanel("request"),
    },
    { id: "press", label: "Press & media", detail: "Coverage and press kit", icon: "press" as const, href: withBasePath("/press") },
    { id: "privacy", label: "Privacy", detail: "What the game keeps and sends", icon: "privacy" as const, href: withBasePath("/privacy") },
    { id: "support", label: "Buy me a coffee", detail: "Support development", icon: "support" as const, href: SUPPORT_URL },
    { id: "github", label: "GitHub", detail: "Source code", icon: "source" as const, href: REPO_URL },
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
    fromRaceRef.current = false;
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
  // What a bug report gets without the player typing it
  const playerSettings = props.displayPanel?.settings;
  const feedbackContext: FeedbackContext = {
    circuit: `${track.name}${track.layout ? `, ${track.layout}` : ""}`,
    car: vehicle.title,
    device: playerSettings ? { keyboard: "Keyboard", controller: "Controller", wheel: "Wheel" }[playerSettings.device] : "Unknown",
    graphics: playerSettings
      ? `${playerSettings.graphics.quality[0].toUpperCase()}${playerSettings.graphics.quality.slice(1)} · render ${Math.round(playerSettings.graphics.renderScale * 100)}%`
      : "Unknown",
  };

  // A rail entry for the title screen or the slim rail: the open panel's entry is chosen
  const row = (item: MenuItem, size: "lg" | "md" | "sm", slim = false) => (
    <RailRow
      key={item.id}
      id={item.id}
      label={slim ? (item.short ?? item.label) : item.label}
      detail={slim || size === "sm" ? undefined : item.detail}
      icon={item.icon}
      size={size}
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
    { action: "move", label: "Move" },
    { action: "select", label: "Select" },
    ...(rowResettable ? [RESET_ROW_PROMPT] : []),
    ...(panel ? [{ action: "back" as const, label: panelTitle ? `Close ${panelTitle}` : "Back" }] : []),
    { action: "tabs", label: "Switch panel" },
    // A controller's Menu button has no key: shown with a pad only
    ...(mode === "pad" && (raceOpen || !panel) ? [{ action: "start" as const, label: raceOpen ? "Start race" : "Drive" }] : []),
  ];
  const phonePrompts = prompts.filter((p) => p.action !== "move" && p.action !== "tabs");

  return (
    <div
      ref={rootRef}
      className={`lc-ui-zoom pointer-events-auto fixed inset-0 z-40 flex flex-col overflow-y-auto pr-[max(1.25rem,env(safe-area-inset-right))] pb-[max(1.25rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(2.5rem,env(safe-area-inset-right))] sm:pl-[max(2.5rem,env(safe-area-inset-left))] ${
        panel
          ? "bg-linear-to-r from-lc-void/97 via-lc-void/90 via-60% to-lc-void/40 pt-[max(1.75rem,env(safe-area-inset-top))] short:pt-[max(1rem,env(safe-area-inset-top))]"
          : "bg-linear-to-r from-lc-void/97 via-lc-void/80 via-35% to-transparent to-70% pt-[max(clamp(1.5rem,3.6vh,2.5rem),env(safe-area-inset-top))] max-lg:bg-lc-void/80 max-lg:bg-none short:pt-[max(1rem,env(safe-area-inset-top))]"
      } ${raceOpen ? "scroll-pb-24" : ""}`}
    >
      <div className={`flex w-full flex-1 flex-col ${panel ? "gap-5.5" : "gap-[clamp(20px,3vh,32px)]"} short:gap-4`}>
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
            <LibreCorsaLogo variant="compact" size={panel ? "sm" : "md"} />
            <EmbeddedBadge />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
            <InputHint pad={pad} />
            {panel || !props.profile ? null : props.displayPanel ? (
              <Button
                variant="ghost"
                size="sm"
                // The name shown comes first, so saying it presses the button
                aria-label={`${props.profile.name}, edit driver profile`}
                onClick={() => props.onOpenSettings?.("profile")}
                icon={
                  <span
                    className="size-4 rounded-full inset-ring-2 inset-ring-white/25"
                    // The driver's own colour is data
                    style={{ background: props.profile.color }}
                  />
                }
              >
                <span className="max-w-[10rem] truncate">{props.profile.name}</span>
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
          <div className="grid flex-1 grid-cols-1 items-start gap-5 lg:grid-cols-[240px_minmax(0,1000px)] lg:gap-7">
            {/* Below lg the rail would stack 13 rows above the panel: the panel takes the screen, Close goes back */}
            <nav className="flex flex-col gap-0.5 max-lg:hidden" data-nav-zone="rail" aria-label="Main menu">
              <HeroAction id={drive.id} label={drive.label} onClick={drive.run!} size="slim" />
              {byId(["race", "multiplayer", "challenge"]).map((item) => row(item, "md", true))}
              <div aria-hidden className="h-3" />
              {byId(["circuit", "car", "conditions", "garage", "leaderboard", "settings"]).map((item) => row(item, "md", true))}
              <div aria-hidden className="h-3" />
              {byId(["credits", "request", "press", "privacy", "support", "github"]).map((item) => row(item, "md", true))}
            </nav>

            <section ref={panelRef} className="min-h-0 min-w-0 scroll-mt-4" data-nav-zone="panel" aria-label={panelTitle}>
              <div key={panel} className="lc-panel-in">
                <PanelFrame
                  subtitle={panelSubtitle[panel]}
                  title={panel === "request" ? undefined : panelTitle}
                  onClose={closePanel}
                >
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
                      onOpenCircuit={() => openPanel("circuit", { fromRace: true })}
                      onOpenConditions={props.conditionsPanel ? () => openPanel("conditions", { fromRace: true }) : undefined}
                      onOpenGarage={() => openPanel("car", { fromRace: true })}
                      onStart={onRaceAi}
                    />
                  ) : null}
                  {panel === "circuit" ? (
                    <CircuitBrowser
                      trackId={trackId}
                      onSelect={
                        onSelectTrack
                          ? (id) => {
                              // The scene reloads: come back to the race setup if that is where the player came from
                              const back: TitlePanel = fromRaceRef.current && props.onChangeRaceSetup ? "race" : "circuit";
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
                        if (fromRaceRef.current && props.onChangeRaceSetup) openPanel("race");
                      }}
                      selectedLivery={props.selectedLivery}
                      onChangeLivery={props.onChangeLivery}
                      library={props.library}
                      lockedReason={carLocked ? "Fixed for this race" : undefined}
                    />
                  ) : null}
                  {panel === "garage" ? <EngineersGarage {...props} onOpenCarBrowser={() => openPanel("car")} /> : null}
                  {panel === "multiplayer" ? <MultiplayerPanel {...props} /> : null}
                  {panel === "challenge" && props.challengePanel ? <ChallengePanel {...props.challengePanel} /> : null}
                  {panel === "leaderboard" && props.leaderboardPanel ? <LeaderboardPanel {...props.leaderboardPanel} /> : null}
                  {panel === "credits" ? <Credits /> : null}
                  {panel === "request" ? <RequestPanel context={feedbackContext} /> : null}
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
              aria-label="Main menu"
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

            <Sheet role="region" aria-label="Up next" className="flex w-full max-w-[340px] flex-col gap-4 short:hidden">
              <div className="flex items-center gap-4">
                {map ? <TrackOutline map={map} thin className="h-[84px] w-[104px] shrink-0" /> : null}
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 className="lc-h3 line-clamp-2 text-balance">{track.name}</h2>
                  <p className="lc-hint m-0 line-clamp-2">{[track.layout, track.city].filter(Boolean).join(" · ")}</p>
                  <p className="lc-hint m-0">
                    <span className="lc-mono text-lc-fog">{lengthOf(track, units.speed)}</span>
                    {" · "}
                    <span className="lc-mono text-lc-fog">{track.turns}</span> turns
                  </p>
                  <div className="pt-1">
                    <TrackQualityBadge track={track} size="sm" />
                  </div>
                </div>
              </div>
              <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 border-t border-lc-line pt-3.5">
                <dt className="lc-hint">Car</dt>
                <dd className="m-0 flex min-w-0 items-center justify-end gap-2 text-[14px] font-semibold">
                  <CarClassTag car={vehicle} size="sm" />
                  <span className="line-clamp-2 text-right">{vehicle.title}</span>
                </dd>
                {livery ? (
                  <>
                    <dt className="lc-hint">Livery</dt>
                    <dd className="m-0 flex min-w-0 items-center justify-end gap-2 text-[14px] font-semibold">
                      {skin ? (
                        <>
                          <span
                            aria-hidden
                            className="h-3 w-7 shrink-0 rounded-full"
                            // A livery's own swatch is data
                            style={{ background: `linear-gradient(135deg, ${skin.swatch[0]} 0 60%, ${skin.swatch[1]} 60% 100%)` }}
                          />
                          <span className="line-clamp-2 text-right">{skin.name}</span>
                        </>
                      ) : vehicle.modelUrl ? (
                        <span className="truncate">Factory</span>
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
                          <span className="line-clamp-2 text-right">{livery.name}</span>
                        </>
                      )}
                    </dd>
                  </>
                ) : null}
                <dt className="lc-hint">Assists</dt>
                <dd className="m-0 line-clamp-2 text-right text-[14px] font-semibold">
                  {ASSIST_LABELS[props.assistPreset] ?? props.assistPreset}
                  {props.showRacingLine ? ", racing line" : ""}
                </dd>
                {hudPreset ? (
                  <>
                    <dt className="lc-hint">HUD</dt>
                    <dd className="m-0 line-clamp-2 text-right text-[14px] font-semibold">{HUD_LABELS[hudPreset] ?? hudPreset}</dd>
                  </>
                ) : null}
              </dl>
            </Sheet>
          </div>
        )}

        {/* Touch screens have no keys to show: the footer comes back with a pad */}
        <footer className={`flex items-center justify-between gap-3 border-t border-lc-line pt-3 ${mode === "pad" ? "" : "pointer-coarse:hidden"}`}>
          <ShellPrompts prompts={prompts} phonePrompts={phonePrompts} />
        </footer>
      </div>
    </div>
  );
};
