"use client";

import React from "react";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-screen w-screen flex-col justify-center bg-[#08090D] px-5 text-[#F5F7FA] sm:px-10">
      <div className="mx-auto w-full max-w-3xl">
        <LibreCorsaLogo variant="compact" size="md" className="mb-8" />
        <div className="font-f1-mono text-xs font-black tracking-[0.22em] text-[#FF2A3C] uppercase">Red flag</div>
        <h1 className="mt-1 font-f1-italic text-4xl uppercase leading-none tracking-wide sm:text-6xl">
          The simulator stopped
        </h1>
        <p className="mt-3 max-w-xl font-f1-mono text-xs leading-relaxed text-[#8E96AA]">
          WebGL or the physics failed to start. Updating your browser or graphics driver, or enabling hardware
          acceleration, usually fixes it.
        </p>
        <p className="mt-2 max-w-xl rounded border border-[#262B3D] bg-[#11131A] px-3 py-2 font-f1-mono text-[11px] text-[#8E96AA]">{error.message}</p>
        <button
          type="button"
          onClick={reset}
          className="hud-slant mt-5 cursor-pointer bg-[#CCFF00] px-6 py-2.5 font-f1-italic text-sm uppercase tracking-wider text-[#08090D] hover:bg-[#E2FF4D]"
        >
          Restart simulator
        </button>
      </div>
    </div>
  );
}
