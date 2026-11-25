import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HudHarness } from "./HudHarness";

export const metadata: Metadata = {
  title: "HUD test",
  robots: { index: false, follow: false },
};

/** One HUD layout over a still game frame, fed a fixed moment of a session (hud-fixture.ts). Development only. */
export default function HudTestPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <HudHarness />;
}
