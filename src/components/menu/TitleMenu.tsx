"use client";

import React, { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { SetupPanel, type PauseMenuProps } from "@/components/hud/PauseMenu";
import { MultiplayerPanel } from "@/components/hud/MultiplayerPanel";
import { TRACK_TOTAL_LENGTH_M, TURN_METADATA } from "@/lib/track-data";
import { isLikelyWheel, padDisplayName } from "@/lib/input/device-input";
import { useGamepads, useListNav } from "./useMenuNav";
import { Card, GameTitle, RailItem, SectionLabel } from "./menu-ui";

type TitlePanel = "garage" | "multiplayer" | "credits";

export interface TitleMenuProps extends PauseMenuProps {
  firstRun: boolean;
  onDrive: () => void;
  onRaceAi: () => void;
  onControls: () => void;
  initialPanel?: TitlePanel | null;
}

const Credits: React.FC = () => (
  <Card className="max-w-xl">
    <SectionLabel>Credits</SectionLabel>
    <div className="flex flex-col gap-3 font-f1-mono text-[12px] leading-relaxed text-zinc-300">
      <p>
        An independent, non-commercial fan project: a browser-based 2026 Formula 1 &amp; GT3 simulation set on a
        fictional circuit at Bugesera, Rwanda.
      </p>
      <p>
        <span className="font-bold text-white">Physics &amp; Dynamics.</span> 500 Hz 6-DOF rigid-body solver, Pacejka
        Magic Formula tyre model with 9-node thermal dynamics, 2026 active aerodynamics and hybrid ERS.
      </p>
      <p>
        <span className="font-bold text-white">Graphics &amp; Audio.</span> WebGL2 PBR rendering with GPU tyre
        deformation, golden-hour lighting and multi-layer Web Audio synthesis.
      </p>
      <p className="text-zinc-500">
        Built with Next.js, React, Three.js and Tailwind CSS. Source code licensed under MIT; 3D and audio assets are
        for non-commercial educational use only.
      </p>
    </div>
  </Card>
);

/**
 * Title menu shown on every launch, over the live 3D grid (attract camera). The rail sits left so the car
 * stays in shot on the right; Garage / Multiplayer / Credits open as panels beside it.
 */
export const TitleMenu: React.FC<TitleMenuProps> = (props) => {
  const { firstRun, onDrive, onRaceAi, onControls } = props;
  const [panel, setPanel] = useState<TitlePanel | null>(props.initialPanel ?? null);
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

  const items = [
    {
      id: "drive",
      label: "Drive",
      detail: firstRun ? "Quick setup, then out on track" : "Practice from the grid",
      run: onDrive,
    },
    { id: "race", label: "Race AI", detail: "5 AI cars · standing start", run: onRaceAi },
    { id: "multiplayer", label: "Multiplayer", detail: "Race friends peer-to-peer", run: () => openPanel("multiplayer") },
    { id: "garage", label: "Garage", detail: "Car, livery, aero and tyres", run: () => openPanel("garage") },
    { id: "controls", label: "Controls", detail: "Keyboard, controller or wheel", run: onControls },
    { id: "credits", label: "Credits", detail: "Fan project · asset sources", run: () => openPanel("credits") },
  ];

  const [index, setIndex] = useListNav(items.length, {
    onSelect: (i) => items[i]?.run(),
    onBack: () => setPanel(null),
  });

  return (
    <div className="pointer-events-auto fixed inset-0 z-40 flex flex-col overflow-y-auto bg-gradient-to-r from-[#07070c]/95 via-[#07070c]/70 to-transparent px-5 pt-7 pb-[max(1.75rem,env(safe-area-inset-bottom))] sm:px-10 short:pt-4">
      <div className="flex w-full flex-1 flex-col">
        <GameTitle kicker="Bugesera · 2026 · Fan project" />

        <div className="mt-8 grid flex-1 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(260px,300px)_minmax(0,760px)] short:mt-4">
          <nav className="flex flex-col gap-1.5">
            {items.map((item, i) => (
              <RailItem
                key={item.id}
                label={item.label}
                detail={item.detail}
                active={i === index}
                open={panel !== null && item.id === panel}
                onHover={() => setIndex(i)}
                onClick={item.run}
              />
            ))}
          </nav>

          <section ref={panelRef} className="min-h-0 scroll-mt-4">
            {panel === "garage" ? <SetupPanel {...props} /> : null}
            {panel === "multiplayer" ? <MultiplayerPanel {...props} /> : null}
            {panel === "credits" ? <Credits /> : null}
          </section>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 font-f1-mono text-[11px] font-bold tracking-wide text-zinc-500">
          <span>
            {pad ? (
              <span className="text-[#00D26A]">
                ● {isLikelyWheel(pad) ? "WHEEL" : "CONTROLLER"} · {padDisplayName(pad.id).toUpperCase().slice(0, 40)}
              </span>
            ) : (
              <span>KEYBOARD · CONNECT A CONTROLLER OR WHEEL ANY TIME</span>
            )}
          </span>
          <span>
            {(TRACK_TOTAL_LENGTH_M / 1000).toFixed(2)} KM · {TURN_METADATA.length} TURNS · ↑↓ / Ⓓ NAVIGATE · ENTER / Ⓐ SELECT
          </span>
        </div>
      </div>
    </div>
  );
};
