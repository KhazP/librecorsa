import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";

/** Route fallback before the simulator mounts: matches the simulator's own loading screen */
export default function Loading() {
  return (
    <div className="relative flex h-screen w-screen flex-col justify-center overflow-hidden bg-[#08090D] px-5 text-[#F5F7FA] sm:px-10 lg:px-16">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{ background: "radial-gradient(560px circle at 74% 50%, rgba(204,255,0,0.07), rgba(8,9,13,0) 100%)" }}
      />
      <div className="relative mx-auto flex w-full max-w-[1440px] flex-col gap-[clamp(20px,3.6vh,36px)]">
        <LibreCorsaLogo variant="full" size="lg" />
        <div className="flex flex-wrap items-end gap-x-7 gap-y-4">
          <div className="flex flex-col gap-2">
            <span className="lc-disp text-[clamp(72px,12vw,168px)] tracking-[-0.02em] tabular-nums short:text-[64px]">
              0%
            </span>
            <span className="lc-lbl lc-breathe">Starting up</span>
          </div>
          <div
            role="img"
            aria-label="Start lights: 0 of 5"
            className="mb-2 flex w-fit gap-2 rounded-full border border-[#262B3D] bg-[#0D0F15] px-3 py-2.5 sm:mb-[30px] short:mb-2"
          >
            {Array.from({ length: 5 }, (_, i) => (
              <span key={i} className="flex flex-col gap-1.5 rounded-full bg-[#08090D] p-1.5">
                <span className="h-[18px] w-[18px] rounded-full bg-[#1B1F2B] shadow-[inset_0_1px_3px_rgba(0,0,0,0.8)] sm:h-[22px] sm:w-[22px]" />
                <span className="h-[18px] w-[18px] rounded-full bg-[#1B1F2B] shadow-[inset_0_1px_3px_rgba(0,0,0,0.8)] sm:h-[22px] sm:w-[22px]" />
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
