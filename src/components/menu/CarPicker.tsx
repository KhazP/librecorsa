"use client";

import React, { useState } from "react";
import { Choice } from "@/components/hud/PauseMenu";
import { carById, carClass, carClassesInUse, carsInClass, type CarClassId, type CarId } from "@/lib/cars/car-registry";

/**
 * The car picker: class tabs, then the cars of the open class. The open class follows the car chosen elsewhere.
 * `compact` drops the description line (the garage).
 */
export const CarPicker: React.FC<{ carId: CarId; onChangeCar: (car: CarId) => void; compact?: boolean }> = ({
  carId,
  onChangeCar,
  compact = false,
}) => {
  const current = carById(carId);
  const [classId, setClassId] = useState<CarClassId>(current.classId);
  const [shownCar, setShownCar] = useState(carId);
  if (shownCar !== carId) {
    setShownCar(carId);
    setClassId(current.classId);
  }
  const open = carClass(classId);

  return (
    <div className="flex flex-col gap-2.5">
      <div role="tablist" aria-label="Car class" className="flex gap-0.5 overflow-x-auto rounded-full border border-[#262B3D] bg-[#08090D] p-1">
        {carClassesInUse().map((k) => {
          const selected = k.id === classId;
          return (
            <button
              key={k.id}
              type="button"
              role="tab"
              aria-selected={selected}
              title={k.sub}
              onClick={() => setClassId(k.id)}
              className={`inline-flex min-h-[40px] min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2.5 text-[13px] font-bold whitespace-nowrap transition-colors ${
                selected ? "text-[#08090D]" : "text-[#8E96AA] hover:text-[#F5F7FA]"
              }`}
              style={selected ? { backgroundColor: k.color } : undefined}
            >
              {k.title}
              {k.id === current.classId && !selected ? (
                <span aria-label="Current car's class" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: k.color }} />
              ) : null}
            </button>
          );
        })}
      </div>
      <div className={`grid gap-2 ${compact ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
        {carsInClass(classId).map((car) => (
          <Choice key={car.id} active={car.id === carId} onClick={() => onChangeCar(car.id)}>
            <span className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <span className="lc-title text-[15px] leading-tight">{car.title}</span>
                <span className="font-f1-mono text-[9px] font-extrabold tracking-[0.1em]" style={{ color: open.color }}>
                  {car.badge}
                </span>
              </span>
              {compact ? null : <span className="text-[12px] leading-[1.4] opacity-75">{car.sub}</span>}
            </span>
          </Choice>
        ))}
      </div>
    </div>
  );
};
