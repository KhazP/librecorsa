"use client";

/**
 * Manual driver badge management in the owner's dashboard (/admin): search claimed drivers, grant the Bulb
 * (Idea Contributor) or manual OG / Track Record badges with an optional note, and revoke existing manual awards.
 */
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button, Segmented, TextField } from "@/components/ui";
import { DriverBadges } from "@/components/ui/DriverBadges";
import { Icon } from "@/components/ui/icons";
import type { ManualBadgeType } from "@/lib/net/awards";
import type { AdminAwardsBody } from "../../../cloudflare/api/admin";
import type { AdminAward } from "../../../cloudflare/api/awards";
import { readAdmin, sendAdmin } from "./admin-fetch";
import { Card, Caution, NOTE, Section } from "./admin-ui";

const BADGE_OPTIONS: readonly { id: ManualBadgeType; label: string }[] = [
  { id: "bulb", label: "Bulb (Idea)" },
  { id: "og", label: "OG Driver" },
  { id: "track_record", label: "Track Record" },
];

const formatDate = (ms: number): string =>
  new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function AwardsSection({ adminKey }: { adminKey: string }) {
  const [awards, setAwards] = useState<AdminAward[]>([]);
  const [ready, setReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [badge, setBadge] = useState<ManualBadgeType>("bulb");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [matches, setMatches] = useState<{ nameKey: string; name: string }[]>([]);
  const pickedRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    void readAdmin<AdminAwardsBody>("/admin/awards", adminKey).then((res) => {
      if (!alive) return;
      setLoading(false);
      if (res.state === "ok") {
        setAwards(res.body.awards);
        setReady(res.body.ready);
      } else {
        setError(res.state === "busy" ? "Too many requests. Wait a moment and refresh." : "Couldn't load driver badges.");
      }
    });
    return () => {
      alive = false;
    };
  }, [adminKey]);

  // Live driver search while typing a name so the owner can pick an exact claimed driver
  useEffect(() => {
    const q = name.trim();
    if (q.length < 2 || !ready || pickedRef.current === name) {
      setMatches([]);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void readAdmin<AdminAwardsBody>(`/admin/awards?q=${encodeURIComponent(q)}`, adminKey).then((res) => {
        if (!alive || res.state !== "ok") return;
        setMatches(res.body.drivers);
      });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [name, adminKey, ready]);

  const handleGrant = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    const res = await sendAdmin<{ ok: true; award: AdminAward }>("/admin/awards", adminKey, {
      method: "POST",
      body: { name: trimmed, badge, note: note.trim() },
    });
    setSaving(false);
    if (res.state === "ok") {
      const granted = res.body.award;
      setAwards((prev) => [granted, ...prev.filter((a) => a.id !== granted.id)]);
      pickedRef.current = null;
      setName("");
      setNote("");
      setMatches([]);
    } else if (res.state === "busy") {
      setError("Too many requests. Wait a moment and try again.");
    } else {
      setError(res.state === "failed" && res.error ? res.error : "Couldn't grant that badge.");
    }
  };

  const handleRevoke = async (id: number) => {
    if (revokingId !== null) return;
    setRevokingId(id);
    setError(null);
    const res = await sendAdmin<{ ok: true; id: number }>(`/admin/awards/${id}`, adminKey, { method: "DELETE" });
    setRevokingId(null);
    if (res.state === "ok") {
      setAwards((prev) => prev.filter((a) => a.id !== id));
    } else if (res.state === "busy") {
      setError("Too many requests. Wait a moment and try again.");
    } else {
      setError("Couldn't revoke that badge.");
    }
  };

  return (
    <Section
      id="awards"
      title="Badges"
      intro="Grant or revoke manual driver badges — the Bulb for community ideas and contributions, or an OG / Track Record override."
    >
      {!ready ? (
        <Card>
          <Caution>Manual badge management shows once the database has migration 0008.</Caution>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card title="Grant a badge" aside="Re-granting the same badge updates its note">
            <form onSubmit={handleGrant} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <TextField
                  label="Driver name"
                  placeholder="Search or enter a driver name"
                  value={name}
                  onChange={(value) => {
                    pickedRef.current = null;
                    setName(value);
                  }}
                  maxLength={64}
                  autoComplete="off"
                />
                {matches.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5" aria-label="Matching claimed drivers">
                    {matches.slice(0, 8).map((d) => (
                      <Button
                        key={d.nameKey}
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          pickedRef.current = d.name;
                          setName(d.name);
                          setMatches([]);
                        }}
                      >
                        {d.name}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="lc-field-label">Badge</span>
                <Segmented
                  aria-label="Badge type"
                  size="sm"
                  value={badge}
                  onChange={setBadge}
                  options={BADGE_OPTIONS}
                  className="self-start"
                />
              </div>

              <TextField
                label="Note (optional)"
                placeholder="e.g. Suggested wet-weather spray fix"
                value={note}
                onChange={setNote}
                maxLength={140}
              />

              {error ? (
                <p role="alert" className="m-0 flex items-start gap-2 text-[14px] font-medium text-lc-loss">
                  <Icon name="error" className="mt-0.5" />
                  {error}
                </p>
              ) : null}

              <Button type="submit" variant="primary" icon={<Icon name="idea" />} disabled={saving || name.trim() === ""} className="self-start">
                {saving ? "Granting…" : "Grant badge"}
              </Button>
            </form>
          </Card>

          <Card title="Granted badges" aside={`${awards.length} manual ${awards.length === 1 ? "award" : "awards"}`}>
            {loading ? (
              <p className={NOTE}>Loading badges…</p>
            ) : awards.length === 0 ? (
              <p className={NOTE}>No manual badges granted yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col divide-y divide-white/5 p-0" aria-label="Granted driver badges">
                {awards.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[14px] font-semibold text-lc-chalk">{a.name}</span>
                        <DriverBadges badges={[{ type: a.badge, count: 1, note: a.note || undefined }]} />
                      </div>
                      <p className="lc-hint m-0">
                        {a.note ? `${a.note} · ` : ""}
                        {formatDate(a.awardedAt)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      icon={<Icon name="delete" />}
                      disabled={revokingId === a.id}
                      onClick={() => void handleRevoke(a.id)}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </Section>
  );
}
