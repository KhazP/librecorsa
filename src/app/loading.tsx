/** Route fallback before the simulator mounts: matches the simulator's own loading screen */
export default function Loading() {
  return (
    <div className="flex h-screen w-screen flex-col justify-center bg-[#07070c] px-5 text-white sm:px-10">
      <div className="mx-auto w-full max-w-6xl">
        <div className="font-f1-mono text-xs font-black tracking-[0.22em] text-[#E10600] uppercase">
          Bugesera · 2026 · Fan project
        </div>
        <h1 className="mt-1 font-f1-italic text-5xl uppercase leading-[0.9] tracking-wide sm:text-7xl">
          Rwanda
          <br />
          Grand Prix
        </h1>
        <div className="mt-6 flex gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className="h-6 w-6 rounded-full bg-zinc-800 sm:h-7 sm:w-7" />
          ))}
        </div>
        <p className="mt-3 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-zinc-500">STARTING UP</p>
      </div>
    </div>
  );
}
