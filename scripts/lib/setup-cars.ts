/**
 * Every vehicle model's car, as the setup suites build them (verify-setup-sheet.ts, verify-fuel-lap-time.ts): the LC26
 * on its older engine, the others on their own simulation, set up on a flat test track unless given a circuit.
 */
import { DEFAULT_CHASSIS_SETUP, type ChassisSetup } from "../../src/lib/sim/car-setup";
import type { SimulatorCar } from "../../src/lib/sim/simulator-car";
import type { VehicleModelId } from "../../src/types/f1";
import { F12026CarSim } from "../../src/lib/sim/f12026-car/F12026CarSim";
import { createLc25Sim } from "../../src/lib/sim/f12025-car/Lc25Sim";
import { createAmgGt3Sim } from "../../src/lib/sim/gt3/AmgGt3Sim";
import { createSuzukiLianaSim } from "../../src/lib/sim/road/SuzukiLianaSim";
import { createMtr496rSim } from "../../src/lib/sim/proto/Mtr496rSim";
import { createLcLmdhSim } from "../../src/lib/sim/proto/LcLmdhSim";
import { createNissanR33Sim } from "../../src/lib/sim/classic/NissanR33Sim";
import { createNissanR32Sim } from "../../src/lib/sim/classic/NissanR32Sim";
import { createBmwM1ProcarSim } from "../../src/lib/sim/classic/BmwM1ProcarSim";
import { createChaparral2d67Sim, createChaparral2dSim } from "../../src/lib/sim/classic/Chaparral2dSim";
import { createPorsche934RsrSim } from "../../src/lib/sim/classic/Porsche934RsrSim";
import { createVwSciroccoSim } from "../../src/lib/sim/road/VwSciroccoSim";
import { F1Physics2026 } from "../../src/lib/f1-physics-2026";
import { getActiveTrackData } from "../../src/lib/track-data";
import { createFlatTestTrack } from "./flat-track";

export const flat = createFlatTestTrack();
/** The bundled circuit (RISE Motordrome's short lap) */
export const track = getActiveTrackData();
export type TestTrack = typeof track;

export const makers: Record<VehicleModelId, (t: TestTrack) => SimulatorCar> = {
  lc26: (t) => new F1Physics2026(t),
  lc25: (t) => createLc25Sim(t),
  "f12026-car": (t) => new F12026CarSim(t),
  "amg-gt3": (t) => createAmgGt3Sim(t),
  liana: (t) => createSuzukiLianaSim(t),
  "mtr-496r": (t) => createMtr496rSim(t),
  "lc-lmdh": (t) => createLcLmdhSim(t),
  "nissan-r33-jgtc": (t) => createNissanR33Sim(t),
  "nissan-r32-jtcc": (t) => createNissanR32Sim(t),
  "bmw-m1-procar": (t) => createBmwM1ProcarSim(t),
  "vw-scirocco-gtx": (t) => createVwSciroccoSim(t),
  "chaparral-2d": (t) => createChaparral2dSim(t),
  "chaparral-2d-67": (t) => createChaparral2d67Sim(t),
  "porsche-934-rsr": (t) => createPorsche934RsrSim(t),
};
export const vehicles = Object.keys(makers) as VehicleModelId[];
export const DT = 1 / 60;

/** A car of a model with a setup patch over the default, on the flat track unless given another */
export const withSetup = (v: VehicleModelId, patch: Partial<ChassisSetup>, t: TestTrack = flat): SimulatorCar => {
  const car = makers[v](t);
  car.applyChassisSetup?.({ ...DEFAULT_CHASSIS_SETUP, ...patch });
  return car;
};
