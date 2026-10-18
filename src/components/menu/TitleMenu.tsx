"use client";

import React, { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { SetupPanel, type PauseMenuProps } from "@/components/hud/PauseMenu";
import { MultiplayerPanel } from "@/components/hud/MultiplayerPanel";
import { DisplayPanel } from "@/components/hud/DisplayPanel";
import { LeaderboardPanel } from "@/components/hud/LeaderboardPanel";
import { TRACK_TOTAL_LENGTH_M, TURN_METADATA } from "@/lib/track-data";
import { getTrackInfo, RWANDA_TRACK_ID, TRACKS } from "@/lib/track-registry";
import { isLikelyWheel, padDisplayName } from "@/lib/input/device-input";
import { useGamepads } from "./useMenuNav";
import { focusInZone, useFocusNav } from "./useFocusNav";
import { Card, GameTitle, PromptBar, RailItem, SectionLabel } from "./menu-ui";
import { Flag, Gamepad2, Info, MonitorCog, Play, Route, Timer, Users, Wrench, type LucideIcon } from "lucide-react";

type TitlePanel = "circuit" | "garage" | "multiplayer" | "leaderboard" | "display" | "credits";

export interface TitleMenuProps extends PauseMenuProps {
  firstRun: boolean;
  onDrive: () => void;
  onRaceAi: () => void;
  onControls: () => void;
  initialPanel?: TitlePanel | null;
  /** Active circuit id */
  trackId?: string;
  /** Switches circuit (reloads the scene) */
  onSelectTrack?: (id: string) => void;
}

const linkClass = "underline text-[#00E5FF] hover:text-[#CCFF00]";

const CircuitPanel: React.FC<{ trackId: string; onSelect?: (id: string) => void }> = ({ trackId, onSelect }) => (
  <Card className="max-w-2xl">
    <SectionLabel>Circuit Selection</SectionLabel>
    <div className="flex flex-col gap-1.5">
      {TRACKS.map((t) => {
        const active = t.id === trackId;
        return (
          <button
            key={t.id}
            type="button"
            disabled={!onSelect}
            onClick={() => !active && onSelect?.(t.id)}
            className={`flex cursor-pointer items-baseline justify-between gap-3 rounded border px-3 py-2 text-left transition-all ${
              active
                ? "border-[#CCFF00] bg-[#CCFF00]/15 shadow-[inset_0_0_12px_rgba(204,255,0,0.12)]"
                : "border-[#262B3D] bg-[#08090D]/80 hover:border-[#8E96AA]/40 hover:bg-[#1B1F2B]"
            }`}
          >
            <span>
              <span className="flex items-center gap-2 font-f1-italic text-lg leading-tight text-[#F5F7FA] uppercase">
                {t.name}
                {t.id === RWANDA_TRACK_ID ? (
                  <span className="rounded-sm bg-[#CCFF00] px-1.5 py-0.5 font-f1-display text-[8px] font-black text-[#08090D] not-italic">
                    ORIGINAL
                  </span>
                ) : null}
              </span>
              <span className="font-f1-mono text-[11px] text-[#8E96AA]">
                {t.layout} · {t.city}, {t.country}
              </span>
            </span>
            <span
              className={`shrink-0 font-f1-mono text-[11px] font-bold ${
                active ? "text-[#CCFF00]" : "text-[#8E96AA]"
              }`}
            >
              {(t.lengthM / 1000).toFixed(2)} KM · {t.turns} TURNS{active ? " · ACTIVE" : ""}
            </span>
          </button>
        );
      })}
    </div>
    <p className="mt-3 font-f1-mono text-[11px] leading-relaxed text-[#8E96AA]">
      Real-world circuits are converted from community scans (see Credits). Corners, kerbs, run-off and barriers are
      detected automatically, so details can differ from the real venue. Switching reloads the scene; multiplayer
      peers must pick the same circuit.
    </p>
  </Card>
);

const Credits: React.FC = () => (
  <Card className="max-w-xl">
    <SectionLabel>About LibreCorsa &amp; Credits</SectionLabel>
    <div className="flex flex-col gap-3 font-f1-mono text-[12px] leading-relaxed text-[#8E96AA]">
      <p className="text-[#F5F7FA]">
        <span className="font-bold text-[#CCFF00]">LibreCorsa</span> is an open-source, multi-class browser racing
        simulator built for everyone — featuring Formula prototypes, GT3 machinery, and an open circuit pipeline.
      </p>
      <p>
        <span className="font-bold text-[#F5F7FA]">Physics &amp; Dynamics.</span> 500 Hz 6-DOF rigid-body solver, Pacejka
        Magic Formula &amp; normalized-slip tyre models with 9-node thermal dynamics, active aerodynamics, and hybrid ERS.
      </p>
      <p>
        <span className="font-bold text-[#F5F7FA]">Graphics &amp; Audio.</span> WebGL2 PBR rendering with GPU tyre
        deformation, golden-hour lighting and multi-layer Web Audio synthesis.
      </p>
      <p>
        <span className="font-bold text-[#F5F7FA]">3D Car Models.</span> &ldquo;AM26 - F1 25/F1 2026 DLC&rdquo; (
        <a href="https://skfb.ly/pKNCK" target="_blank" rel="noreferrer" className={linkClass}>
          skfb.ly/pKNCK
        </a>
        ) by DeX is licensed under Creative Commons Attribution (
        <a
          href="http://creativecommons.org/licenses/by/4.0/"
          target="_blank"
          rel="noreferrer"
          className={linkClass}
        >
          CC BY 4.0
        </a>
        ). &ldquo;2020 Mercedes-Benz AMG GT3&rdquo; (
        <a href="https://skfb.ly/pOTPL" target="_blank" rel="noreferrer" className={linkClass}>
          skfb.ly/pOTPL
        </a>
        ) by Ddiaz Design (CC BY-NC-SA 4.0).
      </p>
      <p>
        <span className="font-bold text-[#F5F7FA]">Circuits.</span>{" "}
        {TRACKS.filter((t) => t.credit).map((t, i, all) => (
          <React.Fragment key={t.id}>
            &ldquo;{t.credit!.title}&rdquo; (
            <a href={t.credit!.short ?? t.credit!.url} target="_blank" rel="noreferrer" className={linkClass}>
              {(t.credit!.short ?? t.credit!.url).replace(/^https?:\/\//, "")}
            </a>
            ) by {t.credit!.author}
            {i < all.length - 1 ? "; " : ""}
          </React.Fragment>
        ))}
        {TRACKS.some((t) => t.credit) ? (
          <>
            {" "}
            are licensed under Creative Commons Attribution (
            <a href="http://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" className={linkClass}>
              CC BY 4.0
            </a>
            ); converted for the simulator (rescaled, recentred, textures re-encoded, physics colliders added).
          </>
        ) : null}
      </p>
      <p className="text-[#8E96AA]/80">
        Built with Next.js, React, Three.js and Tailwind CSS. Source code licensed under MIT; 3D and audio assets are
        for non-commercial educational use only.
      </p>
    </div>
  </Card>
);

/**
 * Title menu shown on every launch, over the live 3D grid (attract camera). The rail sits left so the car
 * stays in shot on the right; panels open beside it. A controller moves through every control
 * (rail, panel, sliders), LB / RB switch panels and Ⓑ steps back out.
 */
export const TitleMenu: React.FC<TitleMenuProps> = (props) => {
  const { firstRun, onDrive, onRaceAi, onControls, trackId = RWANDA_TRACK_ID, onSelectTrack } = props;
  const track = getTrackInfo(trackId);
  const [panel, setPanel] = useState<TitlePanel | null>(props.initialPanel ?? null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  // Below lg the panel opens under the rail, usually off-screen: render it now and bring it into view
  const openPanel = (next: TitlePanel) => {
    if (window.matchMedia("(min-width: 64rem)").matches) return setPanel(next);
    flushSync(() => setPanel(next));
    // Instant: the tap's own touch gesture would cancel a smooth scroll
    panelRef.current?.scrollIntoView({ block: "start" });
  };
  const pads = useGamepads();
  const pad = pads[0];
  const lobbyPlayers = props.lobby?.players.length ?? 0;

  const items: { id: string; label: string; detail: string; icon: LucideIcon; run: () => void; panel?: TitlePanel; primary?: boolean; badge?: string }[] = [
    {
      id: "drive",
      label: "Drive",
      detail: firstRun ? "Quick setup, then out on track" : "Practice from the grid",
      icon: Play,
      run: onDrive,
      primary: true,
    },
    { id: "race", label: "Race AI", detail: "5 AI cars · standing start", icon: Flag, run: onRaceAi },
    {
      id: "multiplayer",
      label: "Multiplayer",
      detail: "Race friends peer-to-peer",
      icon: Users,
      panel: "multiplayer",
      run: () => openPanel("multiplayer"),
      badge: lobbyPlayers > 1 ? `${lobbyPlayers} in lobby` : undefined,
    },
    {
      id: "circuit",
      label: "Circuit",
      detail: `${track.name} · ${(track.lengthM / 1000).toFixed(2)} km`,
      icon: Route,
      panel: "circuit",
      run: () => openPanel("circuit"),
    },
    { id: "garage", label: "Garage", detail: "Car, livery, aero and tyres", icon: Wrench, panel: "garage", run: () => openPanel("garage") },
    ...(props.leaderboardPanel
      ? [{ id: "leaderboard", label: "Lap times", detail: "Leaderboard and ghosts", icon: Timer, panel: "leaderboard" as const, run: () => openPanel("leaderboard") }]
      : []),
    ...(props.displayPanel
      ? [{ id: "display", label: "Display", detail: "HUD, graphics, touch, VR", icon: MonitorCog, panel: "display" as const, run: () => openPanel("display") }]
      : []),
    { id: "controls", label: "Controls", detail: "Keyboard, controller or wheel", icon: Gamepad2, run: onControls },
    { id: "credits", label: "Credits", detail: "Open-source sim · asset sources", icon: Info, panel: "credits", run: () => openPanel("credits") },
  ];
  const panelItems = items.filter((i) => i.panel);

  const focusRail = (id: string) => {
    rootRef.current?.querySelector<HTMLElement>(`[data-rail-id="${id}"]`)?.focus({ preventScroll: true });
  };

  // Ⓑ: out of the panel to its rail entry, then close the panel
  const back = () => {
    if (panel && focusInZone(rootRef.current, "panel")) return focusRail(panel);
    if (panel) setPanel(null);
  };
  // LB / RB: the neighbouring panel, with the focus on its rail entry
  const cycle = (step: number) => {
    const i = panelItems.findIndex((p) => p.panel === panel);
    const next = panelItems[(i + step + panelItems.length) % panelItems.length] ?? panelItems[0];
    if (!next?.panel) return;
    setPanel(next.panel);
    requestAnimationFrame(() => focusRail(next.id));
  };
  useFocusNav(rootRef, { onBack: back, onPrevTab: () => cycle(-1), onNextTab: () => cycle(1) });

  const panelTitle = items.find((i) => i.panel === panel)?.label;

  return (
    <div
      ref={rootRef}
      className="pointer-events-auto fixed inset-0 z-40 flex flex-col overflow-y-auto bg-gradient-to-r from-[#08090D]/95 via-[#08090D]/75 to-transparent px-5 pt-7 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-10 short:pt-4"
    >
      <div className="flex w-full flex-1 flex-col">
        <GameTitle kicker={`${track.name} · ${track.country} · ${(track.lengthM / 1000).toFixed(2)} KM`} />

        <div className="mt-8 grid flex-1 grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(270px,310px)_minmax(0,760px)] short:mt-4">
          <nav className="flex flex-col gap-1.5" data-nav-zone="rail" aria-label="Main menu">
            {items.map((item) => (
              <RailItem
                key={item.id}
                navId={item.id}
                label={item.label}
                detail={item.detail}
                icon={item.icon}
                primary={item.primary}
                badge={item.badge}
                open={panel !== null && item.panel === panel}
                onClick={item.run}
              />
            ))}
          </nav>

          <section ref={panelRef} className="min-h-0 scroll-mt-4" data-nav-zone="panel" aria-label={panelTitle}>
            {panel ? (
              <div key={panel} className="lc-panel-in">
                {panel === "circuit" ? <CircuitPanel trackId={trackId} onSelect={onSelectTrack} /> : null}
                {panel === "garage" ? <SetupPanel {...props} /> : null}
                {panel === "multiplayer" ? <MultiplayerPanel {...props} /> : null}
                {panel === "leaderboard" && props.leaderboardPanel ? <LeaderboardPanel {...props.leaderboardPanel} /> : null}
                {panel === "display" && props.displayPanel ? <DisplayPanel {...props.displayPanel} /> : null}
                {panel === "credits" ? <Credits /> : null}
              </div>
            ) : null}
          </section>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[#262B3D]/70 pt-3">
          <PromptBar
            prompts={[
              { action: "move", label: "Move" },
              { action: "select", label: "Select" },
              ...(panel ? [{ action: "back" as const, label: panelTitle ? `Close ${panelTitle}` : "Back" }] : []),
              { action: "tabs", label: "Switch panel" },
            ]}
          />
          <span className="font-f1-mono text-[11px] font-bold tracking-wide text-[#8E96AA]">
            {pad ? (
              <span className="text-[#CCFF00]">
                ● {isLikelyWheel(pad) ? "WHEEL" : "CONTROLLER"} · {padDisplayName(pad.id).toUpperCase().slice(0, 40)}
              </span>
            ) : (
              <span>KEYBOARD · PRESS ANY BUTTON ON A CONTROLLER OR WHEEL</span>
            )}
            <span className="hidden xl:inline">
              {" "}
              · {(TRACK_TOTAL_LENGTH_M / 1000).toFixed(2)} KM · {TURN_METADATA.length} TURNS
            </span>
          </span>
        </div>
      </div>
    </div>
  );
};
