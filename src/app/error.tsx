"use client";

import React from "react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-screen w-screen flex-col justify-center bg-[#07070c] px-5 text-white sm:px-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="font-f1-mono text-xs font-black tracking-[0.22em] text-[#E10600] uppercase">Red flag</div>
        <h1 className="mt-1 font-f1-italic text-4xl uppercase leading-none tracking-wide sm:text-6xl">
          The simulator stopped
        </h1>
        <p className="mt-3 max-w-xl font-f1-mono text-xs leading-relaxed text-zinc-400">
          WebGL or the physics failed to start. Updating your browser or graphics driver, or enabling hardware
          acceleration, usually fixes it.
        </p>
        <p className="mt-2 max-w-xl rounded bg-[#14141c] px-3 py-2 font-f1-mono text-[11px] text-zinc-500">{error.message}</p>
        <button
          type="button"
          onClick={reset}
          className="hud-slant mt-5 cursor-pointer bg-[#E10600] px-6 py-2.5 font-f1-italic text-sm uppercase tracking-wider text-white hover:bg-[#ff1a0f]"
        >
          Restart simulator
        </button>
      </div>
    </div>
  );
}
