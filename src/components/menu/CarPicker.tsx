"use client";

import React, { useState } from "react";
import { OptionTile, OptionTileGroup, Segmented, SettingRow } from "@/components/ui";
import { carById, carClassesInUse, carsByYear, type CarClassId, type CarId } from "@/lib/cars/car-registry";
import { carTakesPhysicsSwitch, F1_MOD_PHYSICS_OPTIONS, setF1ModPhysics, useF1ModPhysics, type F1ModPhysics } from "@/lib/cars/f1-mod-physics";
import { CarQualityBadge } from "./menu-content-ui";

/**
 * The car picker of the first-run setup: the class, then the cars of that class under each year, newest first. The
 * open class follows the car chosen elsewhere. `compact` drops the description line.
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
  const modPhysics = useF1ModPhysics();
  const physicsTitle = F1_MOD_PHYSICS_OPTIONS.find((o) => o.id === modPhysics)?.title ?? "";
  const classes = carClassesInUse();

  return (
    <div className="flex flex-col gap-3">
      {classes.length > 1 ? (
        <Segmented<CarClassId>
          aria-label="Car class"
          fill
          options={classes.map((k) => ({ id: k.id, label: k.title }))}
          value={classId}
          onChange={setClassId}
        />
      ) : null}
      {carsByYear(classId).map(({ year, cars }) => (
        <div key={year} className="flex flex-col gap-2">
          <p className="lc-mono m-0 text-[12px] text-lc-fog">{year}</p>
          <OptionTileGroup aria-label={`${year} cars`} columns={compact ? 3 : 2}>
            {cars.map((car) => (
              <OptionTile
                key={car.id}
                checked={car.id === carId}
                navDefault={car.id === carId}
                onSelect={() => onChangeCar(car.id)}
                title={car.title}
                description={
                  compact ? (
                    <CarQualityBadge car={car} size="xs" />
                  ) : carTakesPhysicsSwitch(car.id) ? (
                    `${car.sub}, ${physicsTitle} physics`
                  ) : (
                    car.sub
                  )
                }
              />
            ))}
          </OptionTileGroup>
        </div>
      ))}
      {carTakesPhysicsSwitch(carId) && current.classId === classId ? <CarPhysicsSwitch /> : null}
    </div>
  );
};

/** The ported open-wheelers' physics switch (Rigid-body / 2026 Prototype); one choice shared by every ported car */
export const CarPhysicsSwitch: React.FC<{
  /** No longer drawn: the chosen option is white, as everywhere (kept so older callers compile) */
  color?: string;
}> = () => {
  const modPhysics = useF1ModPhysics();
  return (
    <SettingRow label="Physics" hint="Applies to every ported open-wheeler" stacked>
      <Segmented<F1ModPhysics>
        fill
        options={F1_MOD_PHYSICS_OPTIONS.map((o) => ({ id: o.id, label: o.title }))}
        value={modPhysics}
        onChange={setF1ModPhysics}
      />
    </SettingRow>
  );
};
