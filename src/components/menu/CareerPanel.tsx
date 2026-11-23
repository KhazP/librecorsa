"use client";

import React from "react";
import { Button, Card, Well } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { PositionBadge, PlayerTag } from "@/components/ui/badges";
import { Icon } from "@/components/ui/icons";
import {
  CAREER_TIERS,
  F1_POINTS_TABLE,
  getCareerTier,
  sortedCareerStandings,
  type CareerState,
  type CareerTierId,
} from "@/lib/sim/career-mode";
import { getTrackInfo } from "@/lib/track-registry";
import { aiSkillLabel } from "@/lib/sim/ai-tuning";

export interface CareerPanelProps {
  career: CareerState;
  carTitle: string;
  onSelectTier: (tierId: CareerTierId) => void;
  onResetSeason: (nextSeason?: boolean) => void;
  onStartRound: () => void;
}

export const CareerPanel: React.FC<CareerPanelProps> = ({
  career,
  carTitle,
  onSelectTier,
  onResetSeason,
  onStartRound,
}) => {
  const tier = getCareerTier(career.tierId);
  const standings = sortedCareerStandings(career);
  const playerStandingIndex = standings.findIndex((s) => s.isPlayer);
  const playerStanding = playerStandingIndex >= 0 ? standings[playerStandingIndex] : null;
  const leaderPoints = standings[0]?.points ?? 0;

  const activeRound = career.rounds[career.currentRoundIndex] ?? career.rounds[career.rounds.length - 1];
  const activeTrack = activeRound ? getTrackInfo(activeRound.trackId) : null;
  const completedCount = career.rounds.filter((r) => r.completed).length;

  return (
    <div className="flex flex-col gap-4">
      {/* Tier selector & season summary */}
      <Card title={`Season ${career.seasonNumber} · Championship Tier`}>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {CAREER_TIERS.map((t) => {
              const active = t.id === career.tierId;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    if (!active) onSelectTier(t.id);
                  }}
                  className={`flex flex-col items-start gap-1 rounded-lc-tile border p-3 text-left transition-colors ${
                    active
                      ? "border-lc-volt bg-lc-volt/12 text-lc-chalk shadow-[inset_0_0_0_1px_var(--color-lc-volt)]"
                      : "border-lc-line bg-lc-carbon/60 text-lc-fog hover:border-lc-chalk/30 hover:text-lc-chalk"
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="lc-title text-[14px] font-bold">{t.title}</span>
                    {active ? (
                      <Badge tone="good" size="sm">
                        Active
                      </Badge>
                    ) : null}
                  </div>
                  <span className="lc-hint text-[11px] leading-snug">{t.subtitle}</span>
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-3 gap-2.5 pt-1">
            <Well className="flex flex-col gap-0.5 px-3.5 py-2.5">
              <span className="lc-mono text-[20px] font-bold text-lc-volt">
                {playerStandingIndex >= 0 ? `P${playerStandingIndex + 1}` : "—"}
              </span>
              <span className="lc-hint">Championship rank</span>
            </Well>
            <Well className="flex flex-col gap-0.5 px-3.5 py-2.5">
              <span className="lc-mono text-[20px] font-bold text-lc-chalk">
                {playerStanding?.points ?? 0} <span className="text-[12px] font-normal text-lc-slate">PTS</span>
              </span>
              <span className="lc-hint">
                {playerStandingIndex === 0
                  ? "Championship leader"
                  : `${Math.max(0, leaderPoints - (playerStanding?.points ?? 0))} pts behind leader`}
              </span>
            </Well>
            <Well className="flex flex-col gap-0.5 px-3.5 py-2.5">
              <span className="lc-mono text-[20px] font-bold text-lc-chalk">
                {completedCount}/{career.rounds.length}
              </span>
              <span className="lc-hint">
                {playerStanding?.wins ?? 0} {playerStanding?.wins === 1 ? "win" : "wins"} ·{" "}
                {playerStanding?.podiums ?? 0} {playerStanding?.podiums === 1 ? "podium" : "podiums"}
              </span>
            </Well>
          </div>
        </div>
      </Card>

      {/* Current Round or Season Completed Banner */}
      {career.seasonCompleted ? (
        <Card title="Season Finale Complete">
          <div className="flex flex-wrap items-center justify-between gap-4 py-1">
            <div className="flex flex-col gap-1">
              <span className="lc-h3 text-lc-volt">
                {playerStandingIndex === 0
                  ? `World Champion! You won the ${tier.title}!`
                  : `Season ${career.seasonNumber} Finished — Classified P${playerStandingIndex + 1}`}
              </span>
              <span className="lc-hint">
                Final score: {playerStanding?.points ?? 0} points ({playerStanding?.wins ?? 0} wins,{" "}
                {playerStanding?.podiums ?? 0} podiums) across {career.rounds.length} rounds.
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="lg" onClick={() => onResetSeason(true)}>
                Start Season {career.seasonNumber + 1}
              </Button>
            </div>
          </div>
        </Card>
      ) : activeRound && activeTrack ? (
        <Card title={`Next Event · Round ${activeRound.roundNumber} of ${career.rounds.length}`}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="lc-h3 text-lc-chalk">
                  {activeTrack.name}
                  {activeTrack.layout ? ` · ${activeTrack.layout}` : ""}
                </span>
                <Badge variant="outline">{activeTrack.country}</Badge>
              </div>
              <span className="lc-hint">
                {activeRound.laps} laps · {tier.opponents} AI opponents ({aiSkillLabel(tier.aiSkill)} · {tier.aiSkill}
                %) · Car: {carTitle}
              </span>
              <span className="lc-hint text-[11px]">
                FIA Points: {F1_POINTS_TABLE.slice(0, 6).join("-")}... (+1 pt Fastest Lap in top 10)
              </span>
            </div>
            <Button
              variant="primary"
              size="lg"
              icon={<Icon name="chequered" />}
              onClick={onStartRound}
              data-nav-default=""
            >
              Start Round {activeRound.roundNumber}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Two-column layout: Drivers' Championship Standings & Season Calendar */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <Card title="Drivers' Championship Standings">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse" aria-label="Drivers' Championship Standings">
                <thead>
                  <tr className="border-b border-lc-line text-left">
                    <th className="lc-lbl px-2 pb-2">Pos</th>
                    <th className="lc-lbl px-2 pb-2 w-full">Driver</th>
                    <th className="lc-lbl px-2 pb-2 text-right">Wins</th>
                    <th className="lc-lbl px-2 pb-2 text-right max-sm:hidden">Podiums</th>
                    <th className="lc-lbl px-2 pb-2 text-right max-sm:hidden">FL</th>
                    <th className="lc-lbl px-2 pb-2 text-right">Pts</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map((driver, idx) => (
                    <tr
                      key={driver.code}
                      className={`h-10 border-b border-white/5 last:border-b-0 ${
                        driver.isPlayer ? "bg-lc-volt/8 shadow-[inset_2px_0_0_var(--color-lc-volt)]" : ""
                      }`}
                    >
                      <td className="px-2">
                        <PositionBadge position={idx + 1} player={driver.isPlayer} size="sm" className="min-w-9" />
                      </td>
                      <td className="px-2">
                        <span className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className="h-3.5 w-1 shrink-0 rounded-full"
                            style={{ backgroundColor: driver.color }}
                          />
                          <span className="lc-mono text-[12px] font-bold text-lc-slate">{driver.code}</span>
                          <span className="truncate text-[13px] font-semibold text-lc-chalk">{driver.name}</span>
                          {driver.isPlayer ? <PlayerTag size="sm" /> : null}
                        </span>
                      </td>
                      <td className="lc-mono px-2 text-right text-[13px] font-semibold text-lc-fog">
                        {driver.wins}
                      </td>
                      <td className="lc-mono px-2 text-right text-[13px] font-semibold text-lc-fog max-sm:hidden">
                        {driver.podiums}
                      </td>
                      <td className="lc-mono px-2 text-right text-[13px] font-semibold text-lc-fog max-sm:hidden">
                        {driver.fastestLaps}
                      </td>
                      <td className="lc-mono px-2 text-right text-[14px] font-bold text-lc-chalk">
                        {driver.points}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-4 lg:col-span-5">
          <Card title="Season Calendar">
            <div className="flex flex-col divide-y divide-white/5">
              {career.rounds.map((r, idx) => {
                const t = getTrackInfo(r.trackId);
                const isCurrent = !career.seasonCompleted && idx === career.currentRoundIndex;
                return (
                  <div
                    key={r.roundNumber}
                    className={`flex items-center justify-between gap-3 py-2.5 px-2 ${
                      isCurrent ? "rounded-lc-nub bg-lc-volt/10" : ""
                    }`}
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="lc-mono text-[11px] font-bold uppercase text-lc-slate">
                          R{r.roundNumber}
                        </span>
                        <span className="truncate text-[13px] font-semibold text-lc-chalk">
                          {t.name}
                          {t.layout ? ` (${t.layout})` : ""}
                        </span>
                      </div>
                      <span className="lc-hint text-[11px]">
                        {r.laps} laps · {t.country}
                        {r.completed && r.winnerCode ? ` · Winner: ${r.winnerCode}` : ""}
                      </span>
                    </div>

                    <div className="shrink-0">
                      {r.completed ? (
                        <Badge tone={r.playerPosition === 1 ? "good" : "neutral"} variant="outline">
                          {r.playerPosition !== null ? `P${r.playerPosition}` : "DNF"} · +{r.playerPointsEarned ?? 0}{" "}
                          pts
                        </Badge>
                      ) : isCurrent ? (
                        <Badge tone="good">Up Next</Badge>
                      ) : (
                        <Badge variant="outline">Upcoming</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-lc-line pt-3">
              <span className="lc-hint text-[12px]">Reset championship progress</span>
              <Button variant="secondary" size="sm" onClick={() => onResetSeason(false)}>
                Reset Season
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
};
