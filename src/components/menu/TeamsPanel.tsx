"use client";

import React, { useState } from "react";
import { Button, Card, SettingRow, TextField, Well } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { nameProblem } from "@/lib/net/name-filter";
import { loadFounderProgress } from "@/lib/sim/teams";
import {
  canCreateTeam,
  clampMaxMembers,
  createTeam,
  DEFAULT_TEAM_MAX_MEMBERS,
  generateInviteCode,
  loadTeams,
  saveTeams,
  TEAM_CREATE_MIN_DISTANCE_M,
  TEAM_CREATE_MIN_RACES,
  TEAM_MAX_MEMBERS,
  TEAM_MIN_MEMBERS,
  type RacingTeam,
  type TeamJoinMode,
} from "@/lib/sim/teams";

export interface TeamsPanelProps {
  playerCode: string;
  playerName: string;
}

const TEAM_SIZE_OPTIONS = [2, 4, 6, 8, 12, 16, 24] as const;

export const TeamsPanel: React.FC<TeamsPanelProps> = ({ playerCode, playerName }) => {
  const [teams, setTeams] = useState<RacingTeam[]>(() => loadTeams());
  const [stats] = useState(() => loadFounderProgress());
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [desc, setDesc] = useState("");
  const [color, setColor] = useState("#CCFF00");
  const [joinMode, setJoinMode] = useState<TeamJoinMode>("open");
  const [maxMembers, setMaxMembers] = useState<number>(DEFAULT_TEAM_MAX_MEMBERS);
  const [inviteInputs, setInviteInputs] = useState<Record<string, string>>({});
  const [joinError, setJoinError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const eligibility = canCreateTeam(stats);
  const myTeam = teams.find((t) => t.members.some((m) => m.code === playerCode));
  const isOwner = myTeam?.ownerCode === playerCode;

  const updateTeams = (next: RacingTeam[]) => {
    setTeams(next);
    saveTeams(next);
  };

  const handleCreate = () => {
    setCreateError(null);
    if (!eligibility.eligible || !name.trim()) return;
    if (nameProblem(name) || nameProblem(tag) || nameProblem(desc)) {
      setCreateError("Please choose an appropriate team name, tag, and description.");
      return;
    }
    const team = createTeam(
      name,
      tag || name.slice(0, 3),
      desc,
      color,
      { code: playerCode, name: playerName },
      { joinMode, maxMembers },
    );
    updateTeams([team, ...teams]);
    setName("");
    setTag("");
    setDesc("");
  };

  const handleJoin = (team: RacingTeam) => {
    setJoinError(null);
    if (team.members.length >= team.maxMembers) {
      setJoinError(`${team.name} is full.`);
      return;
    }
    if (team.joinMode === "invite") {
      const entered = (inviteInputs[team.id] ?? "").trim().toUpperCase();
      if (entered !== team.inviteCode) {
        setJoinError(`Invalid invite code for ${team.name}.`);
        return;
      }
    }
    const next = teams.map((t) => {
      if (t.id !== team.id) {
        return { ...t, members: t.members.filter((m) => m.code !== playerCode) };
      }
      if (t.members.some((m) => m.code === playerCode)) return t;
      return {
        ...t,
        members: [...t.members, { code: playerCode, name: playerName, role: "member" as const, joinedAtMs: Date.now() }],
      };
    });
    updateTeams(next);
  };

  const handleLeave = (teamId: string) => {
    const next = teams
      .map((t) => (t.id === teamId ? { ...t, members: t.members.filter((m) => m.code !== playerCode) } : t))
      .filter((t) => t.members.length > 0);
    updateTeams(next);
  };

  const handleUpdateMyTeam = (patch: Partial<Pick<RacingTeam, "joinMode" | "maxMembers" | "inviteCode">>) => {
    if (!myTeam || !isOwner) return;
    const next = teams.map((t) =>
      t.id === myTeam.id
        ? {
            ...t,
            ...patch,
            maxMembers: patch.maxMembers !== undefined ? Math.max(t.members.length, clampMaxMembers(patch.maxMembers)) : t.maxMembers,
          }
        : t,
    );
    updateTeams(next);
  };

  return (
    <div className="flex flex-col gap-4">
      {myTeam ? (
        <Card title="Your Team">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="h-8 w-2 rounded-full" style={{ backgroundColor: myTeam.colorHex }} />
              <div className="flex flex-col">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="lc-h3 text-lc-chalk">{myTeam.name}</span>
                  <Badge variant="outline">[{myTeam.tag}]</Badge>
                  <Badge tone={myTeam.joinMode === "open" ? "good" : "warn"}>
                    {myTeam.joinMode === "open" ? "Open" : "Invite only"}
                  </Badge>
                </div>
                {myTeam.description ? <span className="lc-hint">{myTeam.description}</span> : null}
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => handleLeave(myTeam.id)}>
              Leave Team
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2.5">
            <Well className="flex flex-col gap-0.5 px-3 py-2">
              <span className="lc-mono text-[18px] font-bold text-lc-volt">
                {myTeam.members.length} / {myTeam.maxMembers}
              </span>
              <span className="lc-hint">Members</span>
            </Well>
            <Well className="flex flex-col gap-0.5 px-3 py-2">
              <span className="lc-mono text-[18px] font-bold text-lc-chalk">
                {(myTeam.totalDistanceM / 1000).toFixed(1)} km
              </span>
              <span className="lc-hint">Combined distance</span>
            </Well>
            <Well className="flex flex-col gap-0.5 px-3 py-2">
              <span className="lc-mono text-[18px] font-bold text-lc-chalk">{myTeam.totalRaces}</span>
              <span className="lc-hint">Races completed</span>
            </Well>
          </div>

          {isOwner ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={myTeam.joinMode === "open" ? "primary" : "secondary"}
                  onClick={() => handleUpdateMyTeam({ joinMode: "open" })}
                >
                  Open
                </Button>
                <Button
                  size="sm"
                  variant={myTeam.joinMode === "invite" ? "primary" : "secondary"}
                  onClick={() => handleUpdateMyTeam({ joinMode: "invite" })}
                >
                  Invite only
                </Button>
                <label className="ml-2 flex items-center gap-1.5 text-[12px] text-lc-fog">
                  <span>Max size</span>
                  <select
                    value={myTeam.maxMembers}
                    onChange={(e) => handleUpdateMyTeam({ maxMembers: Number(e.target.value) })}
                    className="rounded border border-lc-line bg-lc-ink px-2 py-1 text-[12px] text-lc-chalk"
                  >
                    {Array.from({ length: TEAM_MAX_MEMBERS - TEAM_MIN_MEMBERS + 1 }, (_, i) => i + TEAM_MIN_MEMBERS)
                      .filter((n) => n >= myTeam.members.length)
                      .map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              {myTeam.joinMode === "invite" ? (
                <div className="flex items-center gap-2">
                  <span className="lc-hint">Invite code:</span>
                  <span className="lc-mono rounded border border-lc-line bg-lc-ink px-2 py-0.5 text-[12px] font-bold text-lc-volt">
                    {myTeam.inviteCode}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleUpdateMyTeam({ inviteCode: generateInviteCode() })}
                  >
                    New code
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card title="Create a Team">
        {!eligibility.eligible ? (
          <Well className="mb-3 flex flex-col gap-1 px-3 py-2.5">
            <span className="text-[13px] font-semibold text-lc-chalk">Team founder requirements</span>
            <span className="lc-hint">
              Complete at least {TEAM_CREATE_MIN_RACES} races ({stats.racesCompleted}/{TEAM_CREATE_MIN_RACES}) and drive{" "}
              {TEAM_CREATE_MIN_DISTANCE_M / 1000} km ({(stats.totalDistanceM / 1000).toFixed(1)}/
              {TEAM_CREATE_MIN_DISTANCE_M / 1000} km) before founding a team.
            </span>
          </Well>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_7rem_5rem]">
          <TextField label="Team name" maxLength={32} value={name} onChange={setName} placeholder="Apex Racing" />
          <TextField
            label="Tag"
            maxLength={4}
            value={tag}
            onChange={(v) => setTag(v.toUpperCase())}
            placeholder="APX"
          />
          <SettingRow label="Colour" stacked>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-full cursor-pointer rounded border border-lc-line bg-transparent"
            />
          </SettingRow>
        </div>

        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SettingRow label="Access" stacked>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={joinMode === "open" ? "primary" : "secondary"}
                onClick={() => setJoinMode("open")}
              >
                Open
              </Button>
              <Button
                size="sm"
                variant={joinMode === "invite" ? "primary" : "secondary"}
                onClick={() => setJoinMode("invite")}
              >
                Invite only
              </Button>
            </div>
          </SettingRow>
          <SettingRow label="Max team size" stacked>
            <select
              value={maxMembers}
              onChange={(e) => setMaxMembers(Number(e.target.value))}
              className="h-9 w-full rounded border border-lc-line bg-lc-ink px-2.5 text-[13px] text-lc-chalk"
            >
              {TEAM_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} drivers
                </option>
              ))}
            </select>
          </SettingRow>
        </div>

        <div className="mt-2 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <TextField
              label="Description"
              maxLength={140}
              value={desc}
              onChange={setDesc}
              placeholder="Club / team motto"
            />
          </div>
          <Button variant="primary" onClick={handleCreate} disabled={!eligibility.eligible || !name.trim()}>
            Create Team
          </Button>
        </div>
        {createError ? <p className="mt-2 text-[12px] text-lc-red">{createError}</p> : null}
      </Card>

      <Card title="Teams & Clubs">
        {joinError ? <p className="mb-2 text-[12px] text-lc-red">{joinError}</p> : null}
        {teams.length === 0 ? (
          <p className="lc-hint m-0">No teams created yet. Meet the founder requirements above to start a club.</p>
        ) : (
          <div className="flex flex-col divide-y divide-white/5">
            {teams.map((t) => {
              const isMember = t.members.some((m) => m.code === playerCode);
              const isFull = t.members.length >= t.maxMembers;
              return (
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="h-5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: t.colorHex }} />
                    <div className="flex min-w-0 flex-col">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] font-semibold text-lc-chalk">
                          {t.name} <span className="lc-mono text-[12px] text-lc-slate">[{t.tag}]</span>
                        </span>
                        <Badge tone={t.joinMode === "open" ? "good" : "warn"}>
                          {t.joinMode === "open" ? "Open" : "Invite"}
                        </Badge>
                      </div>
                      <span className="lc-hint text-[11px]">
                        {t.members.length}/{t.maxMembers} members · Owner: {t.ownerCode}
                      </span>
                    </div>
                  </div>
                  {isMember ? (
                    <Badge tone="good">Joined</Badge>
                  ) : isFull ? (
                    <Badge variant="outline">Full</Badge>
                  ) : t.joinMode === "invite" ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        maxLength={6}
                        placeholder="CODE"
                        value={inviteInputs[t.id] ?? ""}
                        onChange={(e) =>
                          setInviteInputs((prev) => ({ ...prev, [t.id]: e.target.value.toUpperCase() }))
                        }
                        className="lc-mono h-8 w-20 rounded border border-lc-line bg-lc-ink px-2 text-center text-[12px] text-lc-chalk"
                      />
                      <Button variant="secondary" size="sm" onClick={() => handleJoin(t)}>
                        Join
                      </Button>
                    </div>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => handleJoin(t)}>
                      Join
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
};
