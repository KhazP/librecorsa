"use client";

import React from "react";
import { RotateCcw } from "lucide-react";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { PrimaryButton } from "@/components/menu/menu-ui";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#08090D] text-[#F5F7FA]">
      {/* A red flag waving on its pole behind the message */}
      <svg
        viewBox="0 0 1440 810"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        <defs>
          <radialGradient id="lc-red-flag-glow" cx="1120" cy="380" r="520" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#FF2A3C" stopOpacity="0.16" />
            <stop offset="1" stopColor="#08090D" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="1440" height="810" fill="url(#lc-red-flag-glow)" />
        <g className="lc-wave" style={{ transformOrigin: "900px 400px" }}>
          <path
            d="M880 170 C980 130 1060 210 1160 180 C1260 150 1320 120 1400 140 L1400 520 C1320 500 1260 530 1160 560 C1060 590 980 510 880 550 Z"
            fill="#FF2A3C"
          />
          <path
            d="M880 170 C980 130 1060 210 1160 180 C1260 150 1320 120 1400 140 L1400 220 C1320 200 1260 230 1160 260 C1060 290 980 210 880 250 Z"
            fill="#FF5A68"
            opacity="0.35"
          />
          <path
            d="M880 390 C980 350 1060 430 1160 400 C1260 370 1320 340 1400 360 L1400 520 C1320 500 1260 530 1160 560 C1060 590 980 510 880 550 Z"
            fill="#B3121F"
            opacity="0.45"
          />
        </g>
        <rect x="864" y="150" width="14" height="660" rx="7" fill="#2C3246" />
        <circle cx="871" cy="146" r="12" fill="#3A4157" />
      </svg>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: "linear-gradient(90deg, rgba(8,9,13,0.98) 0%, rgba(8,9,13,0.9) 40%, rgba(8,9,13,0.1) 66%)",
        }}
      />

      <main className="relative z-[1] flex h-full max-w-[860px] flex-col justify-center gap-7 overflow-y-auto px-5 py-12 sm:px-[6vw] lg:px-24 short:gap-4 short:py-6">
        <LibreCorsaLogo variant="compact" size="md" />

        <div className="flex flex-col gap-4">
          <span className="inline-flex items-center gap-2.5 font-f1-mono text-[12px] font-extrabold tracking-[0.24em] text-[#FF2A3C] uppercase">
            <span className="relative inline-flex h-2 w-2">
              <span className="lc-ping absolute inset-0 rounded-full bg-[#FF2A3C]" />
              <span className="relative h-2 w-2 rounded-full bg-[#FF2A3C]" />
            </span>
            Red flag
          </span>
          <h1 className="lc-disp m-0 text-[clamp(56px,8vw,112px)] short:text-[48px]">
            The simulator
            <br />
            stopped
          </h1>
          <p className="m-0 max-w-[560px] text-[16px] leading-[1.55] text-[#C5CBD8] sm:text-[18px]">
            WebGL or the physics failed to start. Updating your browser or graphics driver, or enabling hardware
            acceleration, usually fixes it.
          </p>
        </div>

        <div className="max-w-[600px] overflow-hidden rounded-[18px] border border-[#262B3D] bg-[#11131A]/90">
          <div className="flex items-center justify-between border-b border-[#262B3D] px-4 py-2.5">
            <span className="lc-lbl !text-[10px]">Error detail</span>
            <span aria-hidden className="h-2 w-2 rounded-full bg-[#FF2A3C]" />
          </div>
          <pre className="m-0 px-4 py-3.5 font-f1-mono text-[12px] leading-[1.6] break-words whitespace-pre-wrap text-[#8E96AA]">
            {error.message}
          </pre>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <PrimaryButton
            onClick={reset}
            prompt={
              <span className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-full bg-[#08090D] text-[#CCFF00]">
                <RotateCcw className="h-[18px] w-[18px]" strokeWidth={2.6} aria-hidden />
              </span>
            }
          >
            Restart simulator
          </PrimaryButton>
        </div>
      </main>
    </div>
  );
}
