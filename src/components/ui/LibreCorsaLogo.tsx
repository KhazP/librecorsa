import React from "react";

export interface LibreCorsaLogoProps {
  /**
   * - "full": emblem + LIBRECORSA wordmark + subtitle rule
   * - "compact": emblem + wordmark (headers, the HUD)
   * - "mark": the emblem alone (favicon, wheel badge)
   */
  variant?: "full" | "compact" | "mark";
  /** Overall size of the lock-up (the mark alone is sized by className) */
  size?: "sm" | "md" | "lg";
  className?: string;
  subtitle?: string;
}

const SIZES = {
  sm: { mark: "h-8 w-8", word: "text-lg", gap: "gap-2.5" },
  md: { mark: "h-11 w-11", word: "text-2xl", gap: "gap-3" },
  lg: { mark: "h-16 w-16", word: "text-[2.6rem]", gap: "gap-4" },
} as const;

/**
 * The LC emblem: a forward-leaning volt "L" with a white "C" nested in its corner like a car
 * taking an apex. The C's apex is painted as a red / white kerb and a cyan streak leaves the exit.
 */
export const LibreCorsaMark: React.FC<{ className?: string; title?: string }> = ({ className = "h-10 w-10", title = "LibreCorsa" }) => {
  const uid = React.useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id={`lcb-${uid}`} x1="12" y1="6" x2="116" y2="122" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1A1E2B" />
          <stop offset="1" stopColor="#07080C" />
        </linearGradient>
        <linearGradient id={`lcv-${uid}`} x1="30" y1="24" x2="96" y2="102" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#E2FF4D" />
          <stop offset="1" stopColor="#A6E000" />
        </linearGradient>
        <linearGradient id={`lcs-${uid}`} x1="0" y1="0" x2="0" y2="128" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.16" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Badge: chamfered top-left and bottom-right, like a number board */}
      <path d="M28 6H110Q122 6 122 18V98L98 122H18Q6 122 6 110V28Z" fill={`url(#lcb-${uid})`} />
      <path d="M28 6H110Q122 6 122 18V98L98 122H18Q6 122 6 110V28Z" fill={`url(#lcs-${uid})`} />
      <path d="M28 6H110Q122 6 122 18V98L98 122H18Q6 122 6 110V28Z" stroke="#2C3246" strokeWidth="2" />
      <path d="M101 117.5L117.5 101" stroke="#CCFF00" strokeWidth="4" strokeLinecap="round" />

      <g transform="translate(13 0) skewX(-12)">
        {/* L */}
        <path d="M32 26H48V84H96V100H38Q32 100 32 94Z" fill={`url(#lcv-${uid})`} />
        {/* C, nested in the L's corner */}
        <path d="M92.32 44.14A20 20 0 1 0 92.32 69.86" stroke="#F5F7FA" strokeWidth="12" />
        {/* Kerb on the apex */}
        <path d="M73.53 76.7A20 20 0 0 1 57.3 53.53" stroke="#FF2A3C" strokeWidth="12" strokeDasharray="5.2 4.2" />
        {/* Exit streaks */}
        <path d="M101 42H112" stroke="#00E5FF" strokeWidth="4.5" strokeLinecap="round" />
        <path d="M104 51H110" stroke="#00E5FF" strokeOpacity="0.45" strokeWidth="3" strokeLinecap="round" />
      </g>
    </svg>
  );
};

export const LibreCorsaLogo: React.FC<LibreCorsaLogoProps> = ({
  variant = "full",
  size,
  className = "",
  subtitle = "Open-source 500 Hz motorsport sim",
}) => {
  if (variant === "mark") return <LibreCorsaMark className={className || "h-10 w-10"} />;
  const s = SIZES[size ?? (variant === "compact" ? "sm" : "md")];

  return (
    <div className={`inline-flex items-center select-none ${s.gap} ${className}`}>
      <LibreCorsaMark className={`${s.mark} shrink-0 drop-shadow-[0_4px_14px_rgba(204,255,0,0.18)]`} />
      <div className="flex flex-col justify-center">
        <div
          className={`font-f1-display leading-none font-black tracking-[0.06em] text-[#F5F7FA] italic ${s.word}`}
          style={{ textShadow: "0 2px 18px rgba(0,0,0,0.6)" }}
        >
          LIBRE<span className="text-[#CCFF00]">CORSA</span>
        </div>
        {variant === "full" ? (
          <div className="mt-2 flex items-center gap-2">
            <span className="flex -skew-x-[20deg] items-center gap-[3px]" aria-hidden>
              <span className="h-[5px] w-4 bg-[#CCFF00]" />
              <span className="h-[5px] w-4 bg-[#00E5FF]" />
              <span className="h-[5px] w-4 bg-[#FF2A3C]" />
            </span>
            <span className="font-f1-mono text-[10px] font-bold tracking-[0.24em] text-[#8E96AA] uppercase">{subtitle}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
};
