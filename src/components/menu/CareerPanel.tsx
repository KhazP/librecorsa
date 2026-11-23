"use client";

import React, { useMemo, useState } from "react";
import {
  Button,
  Card,
  Segmented,
  Select,
  SettingRow,
  Slider,
  Tabs,
  Well,
  type SelectOption,
  type TabItem,
} from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { PlayerTag, PositionBadge } from "@/components/ui/badges";
import { Icon } from "@/components/ui/icons";
import { aiSkillLabel } from "@/lib/sim/ai-tuning";
import type { DamageLevel } from "@/lib/sim/car-damage";
import {
  CAREER_DISTANCE_PRESETS,
  CAREER_FACILITIES,
  CAREER_SPONSORS,
  CAREER_TEAMS,
  CAREER_TIERS,
  F1_POINTS_TABLE,
  getCareerEligibleTracks,
  getCareerModifiers,
  getCareerSponsor,
  getCareerTeam,
  getCareerTier,
  sortedCareerStandings,
  sortedConstructorStandings,
  type CareerDistancePreset,
  type CareerFacilityId,
  type CareerSettings,
  type CareerState,
  type CareerTierId,
} from "@/lib/sim/career-mode";
import { QUALIFYING_MINUTES, type QualifyingMinutes } from "@/lib/sim/qualifying";
import type { RaceAggression } from "@/lib/sim/race-setup";
import { getTrackInfo } from "@/lib/track-registry";

export interface CareerPanelProps {
  career: CareerState;
  carTitle: string;
  onSelectTier: (tierId: CareerTierId) => void;
  onUpdateSettings: (patch: Partial<CareerSettings>) => void;
  onSetRoundTrack: (roundIndex: number, trackId: string) => void;
  onSignTeam: (teamId: string) => void;
  onSignSponsor: (sponsorId: string) => void;
  onUpgradeFacility: (facilityId: CareerFacilityId) => void;
  onResetSeason: (nextSeason?: boolean) => void;
  onStartRound: () => void;
}

type CareerTab = "hub" | "standings" | "tune" | "contracts" | "hq";

const CAREER_TABS: readonly TabItem<CareerTab>[] = [
  { id: "hub", label: "Weekend", icon: <Icon name="chequered" /> },
  { id: "standings", label: "Standings", icon: <Icon name="podium" /> },
  { id: "tune", label: "Fine-Tune", icon: <Icon name="options" /> },
  { id: "contracts", label: "Teams & Sponsors", icon: <Icon name="medal" /> },
  { id: "hq", label: "HQ & R&D", icon: <Icon name="garage" /> },
];

const QUALI_OPTIONS = QUALIFYING_MINUTES.map((m) => ({
  id: String(m),
  label: m === 0 ? "Off" : `${m}m`,
}));

const AGGRESSION_OPTIONS: readonly { id: RaceAggression; label: string }[] = [
  { id: "clean", label: "Clean" },
  { id: "normal", label: "Normal" },
  { id: "hard", label: "Hard" },
];

const DAMAGE_OPTIONS: readonly { id: DamageLevel; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "reduced", label: "Reduced" },
  { id: "full", label: "Full" },
];

function fmtCredits(n: number): string {
  return `₡${Math.round(n).toLocaleString("en-US")}`;
}

export const CareerPanel: React.FC<CareerPanelProps> = ({
  career,
  carTitle,
  onSelectTier,
  onUpdateSettings,
  onSetRoundTrack,
  onSignTeam,
  onSignSponsor,
  onUpgradeFacility,
  onResetSeason,
  onStartRound,
}) => {
  const [tab, setTab] = useState<CareerTab>("hub");
  const [standingsBoard, setStandingsBoard] = useState<"drivers" | "constructors">("drivers");

  const tier = getCareerTier(career.tierId);
  const team = getCareerTeam(career.teamId);
  const sponsor = getCareerSponsor(career.sponsorId);
  const mods = getCareerModifiers(career);

  const standings = sortedCareerStandings(career);
  const constructorStandings = sortedConstructorStandings(career);
  const playerStandingIndex = standings.findIndex((s) => s.isPlayer);
  const playerStanding = playerStandingIndex >= 0 ? standings[playerStandingIndex] : null;
  const leaderPoints = standings[0]?.points ?? 0;

  const activeRound = career.rounds[career.currentRoundIndex] ?? career.rounds[career.rounds.length - 1];
  const activeTrack = activeRound ? getTrackInfo(activeRound.trackId) : null;
  const completedCount = career.rounds.filter((r) => r.completed).length;

  const trackOptions = useMemo<SelectOption<string>[]>(
    () =>
      getCareerEligibleTracks().map((t) => ({
        id: t.id,
        label: t.name,
        detail: `${t.country} · ${(t.lengthM / 1000).toFixed(2)} km`,
      })),
    []
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Top KPI bar + Sub-tab navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          tabs={CAREER_TABS}
          value={tab}
          onChange={setTab}
          aria-label="Career sections"
          size="sm"
          wrap
        />
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" tone="neutral">
            Season {career.seasonNumber} · {tier.title}
          </Badge>
          <Badge variant="soft" tone="good">
            {fmtCredits(career.credits)}
          </Badge>
          <Badge variant="outline" tone="neutral">
            Rep {career.reputation}
          </Badge>
        </div>
      </div>

      {tab === "hub" ? (
        <div className="flex flex-col gap-4">
          {/* Season Overview KPIs */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Well className="flex flex-col gap-0.5 px-3.5 py-2.5">
              <span className="lc-mono text-[20px] font-bold text-lc-volt">
                {playerStandingIndex >= 0 ? `P${playerStandingIndex + 1}` : "—"}
              </span>
              <span className="lc-hint">
                {playerStanding?.points ?? 0} pts{" "}
                {playerStandingIndex > 0 ? `(-${Math.max(0, leaderPoints - (playerStanding?.points ?? 0))})` : "(Lead)"}
              </span>
            </Well>

            <Well className="flex flex-col gap-0.5 px-3.5 py-2.5">
              <span className="lc-mono text-[20px] font-bold text-lc-chalk">
                {completedCount}/{career.rounds.length}
              </span>
              <span className="lc-hint">
                {playerStanding?.wins ?? 0}W · {playerStanding?.podiums ?? 0}Pod · {playerStanding?.poles ?? 0}Pole
              </span>
            </Well>

            <Well className="flex flex-col gap-0.5 px-3.5 py-2.5">
              <span className="flex items-center gap-1.5 text-[15px] font-bold text-lc-chalk">
                <span className="h-3 w-1 rounded-full" style={{ backgroundColor: team.primary }} />
                <span className="truncate">{team.shortName}</span>
              </span>
              <span className="lc-hint truncate">Teammate: {team.teammateName}</span>
            </Well>

            <Well className="flex flex-col gap-0.5 px-3.5 py-2.5">
              <span className="truncate text-[14px] font-bold text-lc-chalk">
                {sponsor ? sponsor.name : "No Sponsor"}
              </span>
              <span className="lc-hint truncate">
                {sponsor ? `${sponsor.objectiveLabel} (+${fmtCredits(sponsor.payoutPerRound)})` : "Sign a sponsor deal"}
              </span>
            </Well>
          </div>

          {/* Next Race / Season Complete Card */}
          {career.seasonCompleted ? (
            <Card title="Season Finale Complete">
              <div className="flex flex-wrap items-center justify-between gap-4 py-1">
                <div className="flex flex-col gap-1">
                  <span className="lc-h3 text-lc-volt">
                    {playerStandingIndex === 0
                      ? `World Champion! You captured Season ${career.seasonNumber}!`
                      : `Season ${career.seasonNumber} Finished — Classified P${playerStandingIndex + 1}`}
                  </span>
                  <span className="lc-hint">
                    Final score: {playerStanding?.points ?? 0} pts ({playerStanding?.wins ?? 0} wins,{" "}
                    {playerStanding?.podiums ?? 0} podiums) · Budget {fmtCredits(career.credits)} carries forward.
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
            <Card title={`Next Grand Prix · Round ${activeRound.roundNumber} of ${career.rounds.length}`}>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="lc-h3 text-lc-chalk">
                      {activeTrack.name}
                      {activeTrack.layout ? ` · ${activeTrack.layout}` : ""}
                    </span>
                    <Badge variant="outline">{activeTrack.country}</Badge>
                    <Badge variant="soft" tone="good">
                      {career.settings.qualifyingMinutes > 0
                        ? `${career.settings.qualifyingMinutes}m Quali + Race`
                        : "Direct Grid Start"}
                    </Badge>
                  </div>
                  <span className="lc-hint">
                    {(activeTrack.lengthM / 1000).toFixed(2)} km · {activeTrack.turns} turns ·{" "}
                    <strong className="text-lc-chalk">{activeRound.laps} laps</strong> (
                    {CAREER_DISTANCE_PRESETS.find((p) => p.id === career.settings.distancePreset)?.label ?? "Standard"})
                    · {career.settings.opponents} rivals ({aiSkillLabel(mods.effectiveAiSkill)} {mods.effectiveAiSkill}%)
                  </span>
                  <span className="lc-hint text-[11px]">
                    Team: {team.name} · Car: {carTitle} · HQ R&D Lv.{mods.totalFacilityLevels} (Pit Crew +
                    {Math.round(mods.pitCrewBonusPct * 100)}%) · Damage: {career.settings.damage}
                  </span>
                </div>
                <Button
                  variant="primary"
                  size="lg"
                  icon={<Icon name="chequered" />}
                  onClick={onStartRound}
                  data-nav-default=""
                >
                  {career.settings.qualifyingMinutes > 0
                    ? `Qualify & Race R${activeRound.roundNumber}`
                    : `Start Round ${activeRound.roundNumber}`}
                </Button>
              </div>
            </Card>
          ) : null}

          {/* Last Round Debrief */}
          {career.lastRaceReport ? (
            <Card title={`Last Race Debrief · Round ${career.lastRaceReport.roundNumber}`}>
              {(() => {
                const rpt = career.lastRaceReport;
                const track = getTrackInfo(rpt.trackId);
                return (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-[13px] font-semibold text-lc-chalk">{track.name}</span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={rpt.position === 1 ? "good" : "neutral"}>
                          {rpt.position !== null ? `Classified P${rpt.position}` : "DNF"}
                        </Badge>
                        {rpt.gridPosition !== null ? (
                          <Badge variant="outline">Started P{rpt.gridPosition}</Badge>
                        ) : null}
                        {rpt.fastestLap ? <Badge tone="good">Fastest Lap</Badge> : null}
                        {rpt.polePosition ? <Badge tone="good">Pole</Badge> : null}
                      </div>
                      <span className="lc-hint text-[11px]">+{rpt.pointsEarned} Championship pts</span>
                    </div>

                    <div className="flex flex-col gap-0.5 text-[12px] text-lc-fog">
                      <div className="flex justify-between">
                        <span>Race Purse &amp; Bonuses</span>
                        <span className="lc-mono text-lc-chalk">+{fmtCredits(rpt.prizeCredits)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>{team.shortName} Retainer</span>
                        <span className="lc-mono text-lc-chalk">+{fmtCredits(rpt.teamPayout)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Sponsor ({rpt.sponsorName ?? "None"})</span>
                        <span className={`lc-mono ${rpt.sponsorMet ? "text-lc-good" : "text-lc-slate"}`}>
                          {rpt.sponsorMet ? `+${fmtCredits(rpt.sponsorPayout)}` : "Missed"}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Wear &amp; Repairs</span>
                        <span className="lc-mono text-lc-bad">-{fmtCredits(rpt.repairCost)}</span>
                      </div>
                    </div>

                    <Well className="flex flex-col justify-center px-3.5 py-2 text-right">
                      <span className="lc-lbl">Net Weekend Payout</span>
                      <span className="lc-mono text-[20px] font-bold text-lc-volt">
                        {rpt.netCredits >= 0 ? "+" : ""}
                        {fmtCredits(rpt.netCredits)}
                      </span>
                    </Well>
                  </div>
                );
              })()}
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === "standings" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <Card
              title={
                standingsBoard === "drivers"
                  ? "Drivers' Championship Standings"
                  : "Constructors' Championship Standings"
              }
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <Segmented
                  size="sm"
                  value={standingsBoard}
                  onChange={setStandingsBoard}
                  aria-label="Championship table"
                  options={[
                    { id: "drivers", label: "Drivers" },
                    { id: "constructors", label: "Constructors" },
                  ]}
                />
                <span className="lc-hint text-[11px]">
                  Points: {F1_POINTS_TABLE.slice(0, 6).join("-")}… +1 FL
                </span>
              </div>

              {standingsBoard === "drivers" ? (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse" aria-label="Drivers' Championship Standings">
                    <thead>
                      <tr className="border-b border-lc-line text-left">
                        <th className="lc-lbl px-2 pb-2">Pos</th>
                        <th className="lc-lbl w-full px-2 pb-2">Driver</th>
                        <th className="lc-lbl px-2 pb-2 text-right max-sm:hidden">Team</th>
                        <th className="lc-lbl px-2 pb-2 text-right">W</th>
                        <th className="lc-lbl px-2 pb-2 text-right max-sm:hidden">Pod</th>
                        <th className="lc-lbl px-2 pb-2 text-right">Pts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {standings.map((driver, idx) => {
                        const drvTeam = getCareerTeam(driver.teamId);
                        return (
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
                                  style={{ backgroundColor: drvTeam.primary }}
                                />
                                <span className="lc-mono text-[12px] font-bold text-lc-slate">{driver.code}</span>
                                <span className="truncate text-[13px] font-semibold text-lc-chalk">{driver.name}</span>
                                {driver.isPlayer ? <PlayerTag size="sm" /> : null}
                              </span>
                            </td>
                            <td className="px-2 text-right text-[11px] text-lc-slate max-sm:hidden">
                              {drvTeam.shortName}
                            </td>
                            <td className="lc-mono px-2 text-right text-[13px] font-semibold text-lc-fog">
                              {driver.wins}
                            </td>
                            <td className="lc-mono px-2 text-right text-[13px] font-semibold text-lc-fog max-sm:hidden">
                              {driver.podiums}
                            </td>
                            <td className="lc-mono px-2 text-right text-[14px] font-bold text-lc-chalk">
                              {driver.points}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse" aria-label="Constructors' Championship Standings">
                    <thead>
                      <tr className="border-b border-lc-line text-left">
                        <th className="lc-lbl px-2 pb-2">Pos</th>
                        <th className="lc-lbl w-full px-2 pb-2">Constructor</th>
                        <th className="lc-lbl px-2 pb-2 text-right">Wins</th>
                        <th className="lc-lbl px-2 pb-2 text-right max-sm:hidden">Podiums</th>
                        <th className="lc-lbl px-2 pb-2 text-right">Pts</th>
                      </tr>
                    </thead>
                    <tbody>
                      {constructorStandings.map((c, idx) => (
                        <tr
                          key={c.teamId}
                          className={`h-10 border-b border-white/5 last:border-b-0 ${
                            c.isPlayerTeam ? "bg-lc-volt/8 shadow-[inset_2px_0_0_var(--color-lc-volt)]" : ""
                          }`}
                        >
                          <td className="px-2">
                            <PositionBadge position={idx + 1} player={c.isPlayerTeam} size="sm" className="min-w-9" />
                          </td>
                          <td className="px-2">
                            <span className="flex items-center gap-2">
                              <span
                                aria-hidden
                                className="h-3.5 w-1.5 shrink-0 rounded-full"
                                style={{ backgroundColor: c.color }}
                              />
                              <span className="truncate text-[13px] font-semibold text-lc-chalk">{c.name}</span>
                              {c.isPlayerTeam ? <Badge size="sm" tone="good">YOUR TEAM</Badge> : null}
                            </span>
                          </td>
                          <td className="lc-mono px-2 text-right text-[13px] font-semibold text-lc-fog">{c.wins}</td>
                          <td className="lc-mono px-2 text-right text-[13px] font-semibold text-lc-fog max-sm:hidden">
                            {c.podiums}
                          </td>
                          <td className="lc-mono px-2 text-right text-[14px] font-bold text-lc-chalk">{c.points}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <div className="lg:col-span-5">
            <Card title="World Championship Calendar">
              <div className="flex max-h-[420px] flex-col divide-y divide-white/5 overflow-y-auto pr-1">
                {career.rounds.map((r, idx) => {
                  const t = getTrackInfo(r.trackId);
                  const isCurrent = !career.seasonCompleted && idx === career.currentRoundIndex;
                  return (
                    <div
                      key={r.roundNumber}
                      className={`flex items-center justify-between gap-3 px-2 py-2.5 ${
                        isCurrent ? "rounded-lc-nub bg-lc-volt/10" : ""
                      }`}
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className="lc-mono text-[11px] font-bold uppercase text-lc-slate">
                            R{r.roundNumber}
                          </span>
                          <span className="truncate text-[13px] font-semibold text-lc-chalk">{t.name}</span>
                        </div>
                        <span className="lc-hint text-[11px]">
                          {r.laps} laps · {t.country}
                          {r.qualifyingPosition ? ` · Grid P${r.qualifyingPosition}` : ""}
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
                          <Badge variant="outline">Scheduled</Badge>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        </div>
      ) : null}

      {tab === "tune" ? (
        <div className="flex flex-col gap-4">
          <Card title="Championship Tier Preset">
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
          </Card>

          <Card title="Fine-Tune Season Rules & Race Format">
            <div className="flex flex-col divide-y divide-white/5">
              <SettingRow
                label="Season length"
                hint="Total Grand Prix rounds in the calendar (4 to 12 distinct venues)"
              >
                <Slider
                  value={career.settings.roundCount}
                  min={4}
                  max={12}
                  step={1}
                  format={(v) => `${v} rounds`}
                  onChange={(v) => onUpdateSettings({ roundCount: v })}
                />
              </SettingRow>

              <SettingRow
                label="Race distance"
                hint="Scale race lap counts for longer strategic tyre-wear & pit-stop races"
              >
                <Segmented<CareerDistancePreset>
                  size="sm"
                  value={career.settings.distancePreset}
                  onChange={(v) => onUpdateSettings({ distancePreset: v })}
                  options={CAREER_DISTANCE_PRESETS.map((p) => ({ id: p.id, label: p.label }))}
                />
              </SettingRow>

              <SettingRow
                label="Qualification"
                hint="Solo qualifying session before each Grand Prix to set the starting grid"
              >
                <Segmented
                  size="sm"
                  value={String(career.settings.qualifyingMinutes)}
                  onChange={(v) => onUpdateSettings({ qualifyingMinutes: Number(v) as QualifyingMinutes })}
                  options={QUALI_OPTIONS}
                />
              </SettingRow>

              <SettingRow
                label="AI opponents"
                hint="Grid size joining your career championship (3 to 11 AI drivers)"
              >
                <Slider
                  value={career.settings.opponents}
                  min={3}
                  max={11}
                  step={1}
                  format={(v) => `${v} rivals`}
                  onChange={(v) => onUpdateSettings({ opponents: v })}
                />
              </SettingRow>

              <SettingRow
                label="AI difficulty"
                hint={`Base rival pace (HQ R&D currently lowers effective AI to ${mods.effectiveAiSkill}%)`}
              >
                <Slider
                  value={career.settings.aiSkill}
                  min={20}
                  max={100}
                  step={1}
                  format={(v) => `${aiSkillLabel(v)} ${v}%`}
                  onChange={(v) => onUpdateSettings({ aiSkill: v })}
                />
              </SettingRow>

              <SettingRow
                label="AI racecraft"
                hint="How aggressively rivals defend and overtake into braking zones"
              >
                <Segmented
                  size="sm"
                  value={career.settings.aiAggression}
                  onChange={(v) => onUpdateSettings({ aiAggression: v })}
                  options={AGGRESSION_OPTIONS}
                />
              </SettingRow>

              <SettingRow
                label="Vehicle damage"
                hint="Crash & puncture severity (repaired via MFD pit stop strategy)"
              >
                <Segmented
                  size="sm"
                  value={career.settings.damage}
                  onChange={(v) => onUpdateSettings({ damage: v })}
                  options={DAMAGE_OPTIONS}
                />
              </SettingRow>
            </div>
          </Card>

          <Card title="Customize Upcoming Calendar Circuits">
            <div className="flex flex-col gap-2">
              {career.rounds.map((r, idx) => (
                <div
                  key={r.roundNumber}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lc-nub border border-white/5 bg-lc-carbon/45 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="lc-mono text-[12px] font-bold text-lc-volt">R{r.roundNumber}</span>
                    <span className="text-[12px] text-lc-slate">{r.laps} laps</span>
                    {r.completed ? <Badge size="sm">Completed</Badge> : null}
                  </div>
                  <Select
                    value={r.trackId}
                    disabled={r.completed}
                    options={trackOptions}
                    onChange={(nextId) => onSetRoundTrack(idx, nextId)}
                    className="w-64"
                  />
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-lc-line pt-3">
              <span className="lc-hint text-[12px]">Restart Season {career.seasonNumber} from Round 1</span>
              <Button variant="secondary" size="sm" onClick={() => onResetSeason(false)}>
                Reset Season Progress
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === "contracts" ? (
        <div className="flex flex-col gap-4">
          <Card title="Constructor Teams & Driver Seats">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {CAREER_TEAMS.map((t) => {
                const signed = t.id === career.teamId;
                const canAfford = career.credits >= t.signingFee;
                return (
                  <div
                    key={t.id}
                    className={`flex flex-col justify-between gap-3 rounded-lc-tile border p-3.5 ${
                      signed
                        ? "border-lc-volt bg-lc-volt/10"
                        : "border-lc-line bg-lc-carbon/55"
                    }`}
                  >
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className="h-4 w-2 rounded-full"
                            style={{ backgroundColor: t.primary }}
                          />
                          <span className="lc-title text-[15px] font-bold text-lc-chalk">{t.name}</span>
                        </div>
                        <Badge size="sm" tone={signed ? "good" : "neutral"} variant={signed ? "soft" : "outline"}>
                          {signed ? "Signed" : t.tierLabel}
                        </Badge>
                      </div>
                      <span className="lc-hint text-[11px]">
                        Teammate: {t.teammateName} ({t.teammateCode}) · Car Rating +{t.carPerfDelta}
                      </span>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-lc-fog">
                        <span>Retainer: <strong className="text-lc-chalk">{fmtCredits(t.salaryPerRound)}/rd</strong></span>
                        <span>Podium: <strong className="text-lc-chalk">+{fmtCredits(t.podiumBonus)}</strong></span>
                        <span>Win: <strong className="text-lc-chalk">+{fmtCredits(t.winBonus)}</strong></span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between border-t border-white/5 pt-2">
                      <span className="lc-mono text-[12px] text-lc-slate">
                        {t.signingFee === 0 ? "No buyout" : `Buyout: ${fmtCredits(t.signingFee)}`}
                      </span>
                      {signed ? (
                        <Badge tone="good">Active Seat &amp; Livery</Badge>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={!canAfford}
                          onClick={() => onSignTeam(t.id)}
                        >
                          {canAfford ? "Sign Contract" : "Insufficient Funds"}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Championship Sponsorship Deals">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {CAREER_SPONSORS.map((sp) => {
                const active = sp.id === career.sponsorId;
                const claimed = career.claimedSponsorIds.includes(sp.id);
                return (
                  <div
                    key={sp.id}
                    className={`flex flex-col justify-between gap-2.5 rounded-lc-tile border p-3.5 ${
                      active
                        ? "border-lc-volt bg-lc-volt/10"
                        : "border-lc-line bg-lc-carbon/55"
                    }`}
                  >
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="lc-title text-[14px] font-bold text-lc-chalk">{sp.name}</span>
                        {active ? <Badge tone="good" size="sm">Active</Badge> : null}
                      </div>
                      <span className="lc-hint text-[11px]">{sp.tagline}</span>
                      <span className="mt-1 text-[12px] font-semibold text-lc-volt">
                        Goal: {sp.objectiveLabel}
                      </span>
                    </div>

                    <div className="flex items-center justify-between border-t border-white/5 pt-2">
                      <div className="flex flex-col text-[11px] text-lc-fog">
                        <span>Per-round bonus: <strong className="text-lc-chalk">+{fmtCredits(sp.payoutPerRound)}</strong></span>
                        <span>{claimed ? "Signing bonus claimed" : `Signing bonus: +${fmtCredits(sp.signingBonus)}`}</span>
                      </div>
                      {active ? (
                        <Badge tone="good">Contracted</Badge>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => onSignSponsor(sp.id)}>
                          Sign Sponsor
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      ) : null}

      {tab === "hq" ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            <Well className="flex flex-col gap-0.5 px-3.5 py-2.5">
              <span className="lc-mono text-[20px] font-bold text-lc-volt">{fmtCredits(career.credits)}</span>
              <span className="lc-hint">Available R&amp;D Budget</span>
            </Well>
            <Well className="flex flex-col gap-0.5 px-3.5 py-2.5">
              <span className="lc-mono text-[20px] font-bold text-lc-chalk">
                +{Math.round(mods.pitCrewBonusPct * 100)}%
              </span>
              <span className="lc-hint">Pit Stop Speed Bonus (1.8s–5.0s Stops)</span>
            </Well>
            <Well className="flex flex-col gap-0.5 px-3.5 py-2.5">
              <span className="lc-mono text-[20px] font-bold text-lc-chalk">
                -{Math.round(mods.repairDiscountPct * 100)}%
              </span>
              <span className="lc-hint">Repair Bill Discount</span>
            </Well>
          </div>

          <Card title="Team Headquarters & R&D Facilities">
            <div className="flex flex-col gap-3">
              {CAREER_FACILITIES.map((fac) => {
                const lvl = career.upgrades[fac.id] ?? 0;
                const maxed = lvl >= fac.maxLevel;
                const cost = maxed ? 0 : fac.costs[lvl];
                const canAfford = !maxed && career.credits >= cost;

                return (
                  <div
                    key={fac.id}
                    className="flex flex-wrap items-center justify-between gap-4 rounded-lc-tile border border-lc-line bg-lc-carbon/55 p-3.5"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="lc-title text-[15px] font-bold text-lc-chalk">{fac.name}</span>
                        <Badge size="sm" tone={maxed ? "good" : "neutral"}>
                          Lv {lvl}/{fac.maxLevel}
                        </Badge>
                      </div>
                      <span className="lc-hint text-[12px]">{fac.summary}</span>
                      <span className="text-[11px] font-semibold text-lc-volt">{fac.effectPerLevel}</span>
                      <div className="mt-1 flex items-center gap-1.5">
                        {Array.from({ length: fac.maxLevel }, (_, i) => (
                          <span
                            key={i}
                            className={`h-1.5 w-7 rounded-full ${
                              i < lvl ? "bg-lc-volt" : "bg-white/10"
                            }`}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="shrink-0">
                      {maxed ? (
                        <Badge tone="good">Maxed Out</Badge>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={!canAfford}
                          onClick={() => onUpgradeFacility(fac.id)}
                        >
                          Upgrade ({fmtCredits(cost)})
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
};
