import { GameTitle } from "@/components/menu/menu-ui";

/** Route fallback before the simulator mounts: matches the simulator's own loading screen */
export default function Loading() {
  return (
    <div className="flex h-screen w-screen flex-col justify-center bg-[#08090D] px-5 text-[#F5F7FA] sm:px-10">
      <div
        aria-hidden
        className="pointer-events-none fixed -right-40 top-1/2 h-[720px] w-[720px] -translate-y-1/2 rounded-full bg-[#CCFF00]/8 blur-3xl"
      />
      <div className="relative mx-auto w-full max-w-6xl">
        <GameTitle kicker="Open-source motorsport sim" />
        <div className="mt-8 flex gap-2 rounded-lg border border-[#262B3D] bg-[#11131A] px-3.5 py-2.5 w-fit">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className="h-5 w-5 rounded-full bg-[#1B1F2B] sm:h-6 sm:w-6" />
          ))}
        </div>
        <p className="mt-3 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA]">STARTING UP</p>
      </div>
    </div>
  );
}
