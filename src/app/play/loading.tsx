import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { Meter } from "@/components/ui/Meter";

/** One unlit start-light column (two lamps), as the simulator's own loading screen draws it */
const LightColumn = () => (
  <span className="flex flex-col gap-1.5 rounded-full bg-lc-void p-1.5">
    <span className="size-4.5 rounded-full bg-lc-titanium inset-shadow-sm inset-shadow-lc-void sm:size-5.5 phone:size-4.5" />
    <span className="size-4.5 rounded-full bg-lc-titanium inset-shadow-sm inset-shadow-lc-void sm:size-5.5 phone:size-4.5" />
  </span>
);

/** Route fallback before the simulator mounts: the first frame of the simulator's own loading screen */
export default function Loading() {
  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-lc-void text-lc-chalk">
      <div className="relative mx-auto flex w-full max-w-[1440px] flex-1 flex-col pt-[max(clamp(28px,4.4vh,48px),env(safe-area-inset-top))] pr-[max(1.25rem,env(safe-area-inset-right))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(2.5rem,env(safe-area-inset-right))] sm:pl-[max(2.5rem,env(safe-area-inset-left))] lg:pr-[max(4rem,env(safe-area-inset-right))] lg:pl-[max(4rem,env(safe-area-inset-left))]">
        <div className="flex flex-1 items-center">
          <div className="flex w-full max-w-[560px] min-w-0 flex-col gap-[clamp(20px,3.6vh,36px)]">
            <LibreCorsaLogo variant="full" size="lg" />
            <div className="flex flex-wrap items-end gap-x-7 gap-y-4 short:gap-x-5">
              <span className="lc-disp text-[clamp(72px,12vw,168px)] tracking-[-0.02em] text-lc-chalk tabular-nums phone:text-[48px]">
                0%
              </span>
              <div
                role="img"
                aria-label="Start lights: 0 of 5"
                className="mb-2 flex gap-2 rounded-full border border-lc-line bg-lc-carbon px-3 py-2.5 sm:mb-7.5 short:mb-2"
              >
                {Array.from({ length: 5 }, (_, i) => (
                  <LightColumn key={i} />
                ))}
              </div>
            </div>
            <Meter label="Starting up" value={0} tone="info" stacked />
          </div>
        </div>
      </div>
    </div>
  );
}
