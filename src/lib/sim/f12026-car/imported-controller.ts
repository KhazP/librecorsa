import { Lut, type LutPoints } from '@/lib/sim/lut';

export type ImportedControllerInput = 'GAS' | 'BRAKE' | 'STEER' | 'SPEED_KMH' | 'GEAR' | 'RPM' | 'CONST';

export interface ImportedControllerData {
  input: ImportedControllerInput;
  operation: 'ADD' | 'MULT';
  lut: LutPoints;
  filter: number;
  min: number;
  max: number;
}

/** An authored chain, with independently filtered inputs and limits at each stage. */
export class ImportedController {
  private readonly stages: { spec: ImportedControllerData; lut: Lut; value: number | undefined }[];

  constructor(specs: readonly ImportedControllerData[]) {
    this.stages = specs.map((spec) => ({ spec, lut: new Lut(spec.lut), value: undefined }));
  }

  reset(): void {
    for (const stage of this.stages) stage.value = undefined;
  }

  step(base: number, pedals: { throttle: number; brake: number; steer: number }, speedKmh: number, gear: number, rpm: number, dt: number): number {
    for (const stage of this.stages) {
      const { spec } = stage;
      const x = spec.input === 'GAS' ? pedals.throttle
        : spec.input === 'BRAKE' ? pedals.brake
        : spec.input === 'STEER' ? pedals.steer
        : spec.input === 'SPEED_KMH' ? speedKmh
        : spec.input === 'GEAR' ? gear
        : spec.input === 'RPM' ? rpm : 0;
      const target = stage.lut.evaluate(x);
      // FILTER is a retention factor per AC physics tick (3 ms), not a LibreCorsa timestep.
      const retention = spec.filter ** (dt / 0.003);
      const value = stage.value === undefined ? target : target + (stage.value - target) * retention;
      stage.value = value;
      const next = spec.operation === 'ADD' ? base + value : base * value;
      base = Math.max(spec.min, Math.min(spec.max, next));
    }
    return base;
  }
}
