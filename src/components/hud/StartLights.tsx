"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import type { RaceStatus } from "@/types/f1";
import { Badge } from "@/components/ui/Badge";
import { currentUnits } from "@/lib/settings/ui-prefs";
import { SPEED_LABEL, speedIn } from "@/lib/settings/units";
import { dnfReasonLabel, HUD_GLASS, HUD_RED, raceState } from "./hud-format";
import { SkinBanner, skinCss, SkinPanel, SkinTag, useHudSkin } from "./styles/third-party-skin";

const LIGHT_COLUMNS = [0, 1, 2, 3, 4];
/** Waving chequer strip outline (520 × 60 viewBox) */
const FLAG_WAVE = "M0 20 C90 0 170 40 260 20 C350 0 430 40 520 20 L520 50 C430 70 350 30 260 50 C170 70 90 30 0 50 Z";

/** One waving chequered strip above or below the flag banner */
const ChequerStrip: React.FC<{ patternId: string; defs?: boolean }> = ({ patternId, defs = false }) => (
  <svg viewBox="0 0 520 60" className="lc-wave h-auto w-[min(520px,82vw)] [animation-duration:2.4s]" aria-hidden="true">
    {defs ? (
      <defs>
        <pattern id={patternId} width="20" height="20" patternUnits="userSpaceOnUse">
          <rect width="20" height="20" fill="var(--color-lc-chalk)" />
          <rect width="10" height="10" fill="var(--color-lc-void)" />
          <rect x="10" y="10" width="10" height="10" fill="var(--color-lc-void)" />
        </pattern>
      </defs>
    ) : null}
    <path d={FLAG_WAVE} fill={`url(#${patternId})`} />
  </svg>
);

/** How long the reaction time stays up once the launch comes (ms) */
const REACTION_SHOWN_MS = 4500;

/** Five-light start gantry overlay (the lights are red: identity, not state); "Lights out" / "Green flag" when the race starts with the player's reaction time under it, "Chequered flag" when the player finishes */
export const StartLights: React.FC<{
  race: RaceStatus | undefined;
  /** The player's reaction to the lights going out (ms, telemetry.startReactionMs) */
  reactionMs?: number;
}> = ({ race, reactionMs }) => {
  const skin = useHudSkin();
  // The gantry re-renders every frame: its words are resolved once per language
  const tx = useTranslations("hud.startLights");
  const L = useMemo(
    () => ({
      rollingStart: tx("rollingStart"),
      formation: tx("formation"),
      limiterActive: tx("limiterActive"),
      getReady: tx("getReady"),
      greenFlag: tx("greenFlag"),
      lightsOut: tx("lightsOut"),
      chequeredFlag: tx("chequeredFlag"),
      retired: tx("retired"),
      disqualified: tx("disqualified"),
    }),
    [tx]
  );
  const [startBanner, setStartBanner] = useState<{ kind: "go" | "green"; id: number } | null>(null);
  const [flags, setFlags] = useState(0);
  // Which banner has finished fading: it is then removed, so it stops holding space above the delta bar
  const [faded, setFaded] = useState<string | null>(null);
  const fadeEnd = (id: string) => (e: React.AnimationEvent) => {
    if (e.target === e.currentTarget) setFaded(id);
  };
  const prevPhase = useRef(race?.phase);
  const prevRolling = useRef(Boolean(race?.rollingFormation));
  const patternId = `lc-chk-${useId().replace(/:/g, "")}`;

  // The banner follows the player's own flag (raceState().finished), not the classification
  const flagged = raceState(race).finished;
  const rolling = Boolean(race?.rollingFormation);
  useEffect(() => {
    if (prevPhase.current === "lights" && race?.phase === "racing") {
      setStartBanner((b) => ({ kind: "go", id: (b?.id ?? 0) + 1 }));
    } else if (prevRolling.current && !rolling && race?.phase === "racing") {
      setStartBanner((b) => ({ kind: "green", id: (b?.id ?? 0) + 1 }));
    }
    if (flagged && prevPhase.current !== "finished") setFlags((n) => n + 1);
    prevPhase.current = race?.phase;
    prevRolling.current = rolling;
  }, [race?.phase, rolling, flagged]);

  // The reaction to the lights (timed by the session), under the banner for a few seconds once the launch comes
  const [shownReaction, setShownReaction] = useState<number | null>(null);
  useEffect(() => {
    if (reactionMs === undefined) {
      setShownReaction(null);
      return;
    }
    setShownReaction(reactionMs);
    const timer = window.setTimeout(() => setShownReaction(null), REACTION_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [reactionMs]);
  const reaction = (cls: string) => tx.rich("reaction", { ms: shownReaction ?? 0, n: (chunks) => <span className={cls}>{chunks}</span> });
  const reactionPill =
    shownReaction !== null && race?.phase === "racing" ? (
      skin !== null ? (
        <SkinBanner cut="sm" tone="accent" className="inline-flex h-10 items-center px-4">
          <span className="text-[16px] font-bold whitespace-nowrap uppercase sm:text-[20px]">{reaction("lc-data")}</span>
        </SkinBanner>
      ) : (
        <div className={`inline-flex h-10 items-center rounded-lc-row px-4 shadow-lc-pop ${HUD_GLASS}`}>
          <span className="lc-disp text-[18px] whitespace-nowrap text-lc-chalk sm:text-[22px]">{reaction("lc-data text-lc-volt")}</span>
        </div>
      )
    ) : null;

  if (race?.phase === "lights") {
    const countdown =
      typeof race.countdownS === "number" && race.countdownS > 0 ? Math.ceil(race.countdownS) : null;
    const startsIn = (n: number) => tx.rich("startsIn", { seconds: n, n: (chunks) => <span className="lc-data not-italic">{chunks}</span> });
    const lightsLabel = tx("lightsLabel", { lit: race.lightsOn, total: LIGHT_COLUMNS.length });
    if (skin !== null) {
      return (
        <div className="flex flex-col items-center gap-3">
          {countdown !== null ? (
            <span className={`hud-text-shadow text-[24px] font-bold uppercase sm:text-[28px] ${skinCss.ink}`}>
              {startsIn(countdown)}
            </span>
          ) : null}
          <SkinPanel
            cut="md"
            className={skinCss.pill}
            innerClassName="flex gap-2 px-3 py-3 sm:gap-3.5 sm:px-5 sm:py-4 short:gap-2 short:py-2"
            role="img"
            aria-label={lightsLabel}
          >
            {LIGHT_COLUMNS.map((i) => {
              const on = i < race.lightsOn;
              return (
                <span key={i} className={`flex flex-col gap-2 p-2 sm:gap-2.5 sm:p-2.5 short:gap-1.5 short:p-1.5 ${skinCss.deepBox}`}>
                  {[0, 1].map((row) => (
                    <span
                      key={row}
                      className="block size-8 rounded-full sm:size-10 short:size-7"
                      style={{
                        backgroundColor: on ? HUD_RED : "color-mix(in srgb, var(--color-lc-crimson) 10%, var(--color-lc-void))",
                        boxShadow: on ? `0 0 22px ${HUD_RED}, 0 0 4px ${HUD_RED}` : "inset 0 2px 6px rgb(0 0 0 / 0.9)",
                      }}
                    />
                  ))}
                </span>
              );
            })}
          </SkinPanel>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-3">
        {countdown !== null ? (
          <span className="lc-disp hud-text-shadow text-[26px] text-lc-chalk sm:text-[30px]">
            {startsIn(countdown)}
          </span>
        ) : null}
        <div
          className={`flex gap-2 rounded-lc-tile px-3 py-3 sm:gap-3 sm:px-4 sm:py-3.5 short:gap-2 short:py-2 ${HUD_GLASS}`}
          role="img"
          aria-label={lightsLabel}
        >
          {LIGHT_COLUMNS.map((i) => {
            const on = i < race.lightsOn;
            return (
              <span
                key={i}
                className="flex flex-col gap-2 rounded-lc-row bg-lc-well p-2 inset-ring inset-ring-lc-titanium sm:gap-2.5 sm:p-2.5 short:gap-1.5 short:p-1.5"
              >
                {[0, 1].map((row) => (
                  <span
                    key={row}
                    className="block size-8 rounded-full sm:size-10 short:size-7"
                    style={{
                      backgroundColor: on ? HUD_RED : "color-mix(in srgb, var(--color-lc-crimson) 10%, var(--color-lc-void))",
                      boxShadow: on ? `0 0 22px ${HUD_RED}, 0 0 4px ${HUD_RED}` : "inset 0 2px 6px rgb(0 0 0 / 0.9)",
                    }}
                  />
                ))}
              </span>
            );
          })}
        </div>
      </div>
    );
  }
  if (race?.phase === "racing" && race.rollingFormation) {
    const rf = race.rollingFormation;
    const units = currentUnits();
    const pace = Math.round(speedIn(rf.paceMs * 3.6, units.speed));
    const unit = SPEED_LABEL[units.speed];
    const countdown = rf.stage === "countdown" ? rf.countdown : undefined;
    const isReady = rf.stage === "ready";
    const pipsLit = countdown !== undefined ? 4 - countdown : 0;

    if (skin !== null) {
      if (countdown !== undefined) {
        return (
          <div role="status" aria-label={tx("rollingCountdownLabel", { count: countdown })} className="flex flex-col items-center gap-2">
            <SkinPanel cut="lg" tone="caution" innerClassName="flex flex-col items-center gap-2 px-8 py-3 sm:px-12 sm:py-4">
              <div className="flex items-center gap-2">
                <SkinTag tone="caution" filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
                  {L.rollingStart}
                </SkinTag>
                {rf.limiterActive ? (
                  <SkinTag tone="info" className="px-2 py-0.5 text-[11px] font-bold uppercase">
                    {L.limiterActive}
                  </SkinTag>
                ) : null}
              </div>
              <span key={countdown} className="lc-data text-[56px] leading-none font-bold sm:text-[80px]">
                {countdown}
              </span>
              <div className="flex gap-2" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="block size-3.5 rounded-full"
                    style={{
                      backgroundColor: i < pipsLit ? "var(--color-lc-caution)" : "color-mix(in srgb, var(--color-lc-caution) 18%, var(--color-lc-void))",
                      boxShadow: i < pipsLit ? "0 0 12px var(--color-lc-caution)" : "none",
                    }}
                  />
                ))}
              </div>
              <span className="text-[13px] font-bold whitespace-nowrap uppercase opacity-90">
                {tx.rich("holdPaceSkin", { pace, unit, n: (chunks) => <span className="lc-data">{chunks}</span> })}
              </span>
            </SkinPanel>
          </div>
        );
      }
      if (isReady) {
        return (
          <SkinPanel cut="md" tone="caution" role="status" innerClassName="flex flex-col items-center gap-1.5 px-7 py-3 sm:px-10 sm:py-3.5">
            <div className="flex items-center gap-2">
              <SkinTag tone="caution" filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
                {L.rollingStart}
              </SkinTag>
              {rf.limiterActive ? (
                <SkinTag tone="info" className="px-2 py-0.5 text-[11px] font-bold uppercase">
                  {L.limiterActive}
                </SkinTag>
              ) : null}
            </div>
            <span className="text-[32px] leading-none font-bold whitespace-nowrap uppercase sm:text-[46px]">{L.getReady}</span>
            <span className="text-[13px] font-bold whitespace-nowrap uppercase opacity-90">
              {tx.rich("holdPaceSkin", { pace, unit, n: (chunks) => <span className="lc-data">{chunks}</span> })}
            </span>
          </SkinPanel>
        );
      }
      return (
        <SkinBanner role="status" tone="caution" cut="sm" className="inline-flex min-h-10 items-center gap-2.5 py-1.5 pe-4 ps-2.5">
          <SkinTag tone="caution" filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
            {L.formation}
          </SkinTag>
          <span className="text-[14px] font-bold whitespace-nowrap uppercase">
            {tx.rich("holdPaceSkin", { pace, unit, n: (chunks) => <span className="lc-data">{chunks}</span> })}
          </span>
          {rf.limiterActive ? (
            <SkinTag tone="info" className="px-2 py-0.5 text-[11px] font-bold uppercase">
              {L.limiterActive}
            </SkinTag>
          ) : null}
        </SkinBanner>
      );
    }

    if (countdown !== undefined) {
      return (
        <div
          role="status"
          aria-label={tx("rollingCountdownLabel", { count: countdown })}
          className={`flex flex-col items-center gap-2 rounded-lc-tile border-2 border-lc-caution/75 px-8 py-3.5 text-lc-chalk shadow-lc-pop sm:px-12 sm:py-4.5 ${HUD_GLASS}`}
        >
          <div className="flex items-center gap-2">
            <Badge tone="warn" variant="solid" size="sm">
              {L.rollingStart}
            </Badge>
            {rf.limiterActive ? (
              <Badge tone="info" variant="soft" size="sm">
                {L.limiterActive}
              </Badge>
            ) : null}
          </div>
          <span key={countdown} className="lc-data text-[60px] leading-none font-bold text-lc-caution sm:text-[84px]">
            {countdown}
          </span>
          <div className="flex gap-2.5" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="block size-3.5 rounded-full"
                style={{
                  backgroundColor: i < pipsLit ? "var(--color-lc-caution)" : "color-mix(in srgb, var(--color-lc-caution) 18%, var(--color-lc-void))",
                  boxShadow: i < pipsLit ? "0 0 14px var(--color-lc-caution)" : "inset 0 1px 3px rgb(0 0 0 / 0.8)",
                }}
              />
            ))}
          </div>
          <span className="lc-disp text-[14px] whitespace-nowrap text-lc-chalk/90">
            {tx.rich("holdPace", { pace, unit, n: (chunks) => <span className="lc-data text-lc-caution">{chunks}</span> })}
          </span>
        </div>
      );
    }
    if (isReady) {
      return (
        <div
          role="status"
          className={`flex flex-col items-center gap-1.5 rounded-lc-tile border-2 border-lc-caution/70 px-7 py-3 text-lc-chalk shadow-lc-pop sm:px-10 sm:py-4 ${HUD_GLASS}`}
        >
          <div className="flex items-center gap-2">
            <Badge tone="warn" variant="solid" size="sm">
              {L.rollingStart}
            </Badge>
            {rf.limiterActive ? (
              <Badge tone="info" variant="soft" size="sm">
                {L.limiterActive}
              </Badge>
            ) : null}
          </div>
          <span className="lc-disp text-[34px] leading-none whitespace-nowrap text-lc-caution sm:text-[48px]">{L.getReady}</span>
          <span className="lc-disp text-[14px] whitespace-nowrap text-lc-chalk/90">
            {tx.rich("holdPace", { pace, unit, n: (chunks) => <span className="lc-data text-lc-caution">{chunks}</span> })}
          </span>
        </div>
      );
    }
    return (
      <div
        role="status"
        className={`inline-flex min-h-11 items-center gap-2.5 rounded-lc-row py-2 pe-4 ps-2.5 text-lc-chalk inset-ring inset-ring-lc-caution/65 shadow-lc-pop ${HUD_GLASS}`}
      >
        <Badge tone="warn" variant="solid" size="sm">
          {L.formation}
        </Badge>
        <span className="lc-disp text-[15px] whitespace-nowrap">
          {tx.rich("holdPace", { pace, unit, n: (chunks) => <span className="lc-data text-lc-caution">{chunks}</span> })}
        </span>
        {rf.limiterActive ? (
          <Badge tone="info" variant="soft" size="sm">
            {L.limiterActive}
          </Badge>
        ) : null}
      </div>
    );
  }
  if (startBanner?.kind === "green" && race?.phase === "racing" && faded !== `green${startBanner.id}`) {
    if (skin !== null) {
      return (
        <div key={`green${startBanner.id}`} onAnimationEnd={fadeEnd(`green${startBanner.id}`)} className="hud-fade-out relative flex items-center justify-center">
          <SkinPanel cut="lg" tone="gain" innerClassName="flex flex-col items-center gap-2 px-8 py-4 sm:px-14 sm:py-6">
            <span className="text-[40px] leading-none font-bold whitespace-nowrap uppercase sm:text-[68px]">{L.greenFlag}</span>
          </SkinPanel>
        </div>
      );
    }
    return (
      <div key={`green${startBanner.id}`} onAnimationEnd={fadeEnd(`green${startBanner.id}`)} className="hud-fade-out relative flex items-center justify-center">
        <div className="relative flex flex-col items-center gap-2 rounded-lc-tile border-2 border-lc-gain/65 bg-lc-void/90 px-8 py-4 shadow-lc-pop sm:px-12 sm:py-5">
          <span className="lc-disp text-[44px] whitespace-nowrap text-lc-gain sm:text-[72px]">{L.greenFlag}</span>
        </div>
      </div>
    );
  }
  if (startBanner?.kind === "go" && race?.phase === "racing" && faded !== `go${startBanner.id}`) {
    if (skin !== null) {
      return (
        <div className="flex flex-col items-center gap-2">
          <div key={startBanner.id} onAnimationEnd={fadeEnd(`go${startBanner.id}`)} className="hud-fade-out relative flex items-center justify-center">
            <SkinPanel cut="lg" tone="accent" innerClassName="flex flex-col items-center gap-3 px-8 py-4 sm:gap-4 sm:px-14 sm:py-6">
              <div className="flex gap-2" aria-hidden="true">
                {LIGHT_COLUMNS.map((i) => (
                  <span key={i} className={`size-3.5 rounded-full ${skinCss.fillDim}`} />
                ))}
              </div>
              <span className="text-[40px] leading-none font-bold whitespace-nowrap uppercase sm:text-[68px]">{L.lightsOut}</span>
            </SkinPanel>
          </div>
          {reactionPill}
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-2">
        <div key={startBanner.id} onAnimationEnd={fadeEnd(`go${startBanner.id}`)} className="hud-fade-out relative flex items-center justify-center">
          <div className="relative flex flex-col items-center gap-3 rounded-lc-tile border-2 border-lc-chalk/50 bg-lc-void/90 px-8 py-4 shadow-lc-pop sm:gap-3.5 sm:px-12 sm:py-5">
            <div className="flex gap-2" aria-hidden="true">
              {LIGHT_COLUMNS.map((i) => (
                <span key={i} className="h-3.5 w-3.5 rounded-full bg-lc-titanium" />
              ))}
            </div>
            <span className="lc-disp text-[44px] whitespace-nowrap text-lc-chalk sm:text-[72px]">
              {L.lightsOut}
            </span>
          </div>
        </div>
        {reactionPill}
      </div>
    );
  }
  if (flags > 0 && flagged) {
    if (faded === `flag${flags}`) return null;
    const me = race?.results?.find((r) => r.isPlayer);
    const out = Boolean(me && (me.dq || me.dnf));
    const outReason = out ? dnfReasonLabel(me?.dnfReason, me?.dq) : null;
    if (out) {
      const heading = me?.dq ? L.disqualified : L.retired;
      if (skin !== null) {
        return (
          <div key={flags} onAnimationEnd={fadeEnd(`flag${flags}`)} className="hud-fade-out flex flex-col items-center gap-3.5">
            <SkinPanel cut="lg" tone="loss" innerClassName="flex flex-col items-center gap-2 px-8 py-4 sm:px-13 sm:py-5.5">
              <span className="block text-center text-[34px] leading-none font-bold whitespace-nowrap uppercase sm:text-[56px]">
                {heading}
              </span>
              {outReason ? (
                <span className="block text-center text-[15px] leading-tight font-semibold tracking-[0.06em] uppercase sm:text-[18px]">
                  {outReason}
                </span>
              ) : null}
            </SkinPanel>
          </div>
        );
      }
      return (
        <div key={flags} onAnimationEnd={fadeEnd(`flag${flags}`)} className="hud-fade-out flex flex-col items-center gap-3.5">
          <div className="flex flex-col items-center gap-1.5 rounded-lc-tile border-2 border-lc-loss/70 bg-lc-void/90 px-8 py-4 shadow-lc-pop sm:px-12 sm:py-5">
            <span className="lc-disp block text-center text-[36px] whitespace-nowrap text-lc-loss sm:text-[58px]">
              {heading}
            </span>
            {outReason ? (
              <span className="lc-title block text-center text-[15px] tracking-[0.06em] text-lc-chalk uppercase sm:text-[18px]">
                {outReason}
              </span>
            ) : null}
          </div>
        </div>
      );
    }
    if (skin !== null) {
      return (
        <div key={flags} onAnimationEnd={fadeEnd(`flag${flags}`)} className="hud-fade-out flex flex-col items-center gap-3.5">
          <ChequerStrip patternId={patternId} defs />
          <SkinPanel cut="lg" innerClassName="px-8 py-4 sm:px-13 sm:py-5.5">
            <span className="block text-center text-[34px] leading-none font-bold whitespace-nowrap uppercase sm:text-[60px]">
              {L.chequeredFlag}
            </span>
          </SkinPanel>
          <ChequerStrip patternId={patternId} />
        </div>
      );
    }
    return (
      <div key={flags} onAnimationEnd={fadeEnd(`flag${flags}`)} className="hud-fade-out flex flex-col items-center gap-3.5">
        <ChequerStrip patternId={patternId} defs />
        <div className="rounded-lc-tile border-2 border-lc-chalk/50 bg-lc-void/90 px-8 py-4 shadow-lc-pop sm:px-12 sm:py-5">
          <span className="lc-disp block text-center text-[36px] whitespace-nowrap text-lc-chalk sm:text-[64px]">
            {L.chequeredFlag}
          </span>
        </div>
        <ChequerStrip patternId={patternId} />
      </div>
    );
  }
  return reactionPill;
};
