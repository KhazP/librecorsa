import type { RoomModRef } from "@/lib/net/wire";
import { TRACKS } from "@/lib/track-registry";
import { isModContentId } from "./mod-manifest";

/**
 * Whether this copy of the game can race a room's circuit: a mod circuit needs the package it comes from, and the same
 * content as the host's (its hash), or the two would drive different roads. A copy that can't tell (a folder package
 * listed without its hash) takes it as the same.
 */
export type RoomTrackStatus = "ok" | "missing" | "different";

/** The mod package a circuit comes from, as a room names it; undefined for the game's own circuits */
export function roomModRefOf(trackId: string): RoomModRef | undefined {
  const mod = TRACKS.find((t) => t.id === trackId)?.mod;
  return mod?.hash ? { packageId: mod.packageId, name: mod.packageName, version: mod.version, hash: mod.hash } : undefined;
}

export function roomTrackStatus(trackId: string, ref: RoomModRef | undefined): RoomTrackStatus {
  const info = TRACKS.find((t) => t.id === trackId);
  if (!info) return "missing";
  if (!isModContentId(trackId)) return "ok";
  const mine = info.mod?.hash;
  return ref && mine && ref.hash !== mine ? "different" : "ok";
}
