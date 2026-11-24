/**
 * The Speed Dreams car importer (npm run mod -- import sd-car), on small made-up cars: the parameter files read and
 * merged as Speed Dreams reads them, their physics as a patch every base takes, the licence gate, the car rig and the
 * sound bank the converters write. Cars downloaded with `--fetch` (scripts/mods/.cache/speed-dreams/) are checked too;
 * those checks are skipped when the cache is empty, and the converter runs when uv or ffmpeg is missing.
 *
 *   npx tsx scripts/verify/verify-sd-car.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { SdParams, sdUnitToSI } from "../lib/sd-params";
import { chooseBase, PHYSICS_BASES, readSdCar, sdAeroTargets, sdCarPhysics, sdCarProblems, sdTyreCurve, sdTyreMu } from "../cars/sd-car-physics";
import { findCarLicence, readLicenceEntry, readLicenceText, shareable } from "../cars/sd-licence";
import { readPins, SD_CACHE_DIR, SD_DATA_DIR } from "../mods/lib/sd-fetch";
import { fitAero, withAero } from "../mods/lib/aero-fit";
import { driveSanity } from "../mods/lib/car-sanity";
import { modSimProfile, MOD_PHYSICS_FORMAT } from "../../src/lib/mods/mod-physics";
import { VEHICLE_MODELS } from "../../src/lib/cars/vehicle-models";
import type { VehicleModelId } from "../../src/types/f1";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(84)} ${detail}`);
  if (!ok) failed++;
}
const near = (a: number | undefined, b: number, tol = 1e-6) => a !== undefined && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const tmp = mkdtempSync(join(tmpdir(), "sd-car-"));
const RPM = Math.PI / 30;

// ---------------------------------------------------------------------------------------------------------------------
// Parameter files
// ---------------------------------------------------------------------------------------------------------------------
check("units as GfParmUnit2SI: a pound is a mass, so lbs/in is 17.858 N/m", near(sdUnitToSI("lbs/in", 1), 0.45359237 / 0.0254));
check("units: lbs/in/s, kg.m2, km/h, deg, rpm, mm, PSI, %, C", near(sdUnitToSI("lbs/in/s", 1), 0.45359237 / 0.0254) && near(sdUnitToSI("kg.m2", 2), 2) && near(sdUnitToSI("km/h", 36), 10) && near(sdUnitToSI("deg", 180), Math.PI) && near(sdUnitToSI("rpm", 1000), 104.719755) && near(sdUnitToSI("mm", 75), 0.075) && near(sdUnitToSI("PSI", 1), 6894.76) && near(sdUnitToSI("%", 55), 0.55) && near(sdUnitToSI("C", 90), 363.15));
check("an unknown unit passes through as SI", sdUnitToSI("N.m", 410) === 410 && sdUnitToSI("ch", 3) === 3);

const CATEGORY = `<?xml version="1.0"?>
<!DOCTYPE params SYSTEM "params.dtd">
<params name="Test GT" type="template">
  <section name="Car">
    <attstr name="category" val="LS-GT2"/>
    <attnum name="mass" unit="kg" min="900" max="1500" val="1150"/>
    <attnum name="GC height" unit="m" min="0.08" max="1.0" val="0.3"/>
  </section>
  <section name="Drivetrain"><attstr name="type" val="RWD"/></section>
  <section name="Engine"><attstr name="turbo" in="true,false" val="false"/></section>
  <section name="Front Right Wheel"><attnum name="stiffness" val="21.5"/></section>
</params>`;
const carXml = (o: { mass?: number; drive?: string; turbo?: string; name?: string } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<!-- file: test.xml
     This program is free software; you can redistribute it and/or modify it under the terms of the GNU General Public
     License as published by the Free Software Foundation; either version 2 of the License, or
     (at your option) any later version. -->
<params name="${o.name ?? "Test 360"}" type="template">
  <section name="Car">
    <attstr name="category" val="LS-GT2"/>
    <attnum name="body length" unit="m" val="4.4"/><attnum name="body width" unit="m" val="2.0"/><attnum name="body height" unit="m" val="1.1"/>
    <attnum name="mass" unit="kg" val="${o.mass ?? 1180}"/>
    <attnum name="GC height" unit="m" val="0.29"/>
    <attnum name="front-rear weight repartition" val="0.44"/>
    <attnum name="mass repartition coefficient" val="0.8"/>
  </section>
  <section name="Aerodynamics"><attnum name="Cx" val="0.32"/><attnum name="front area" unit="m2" val="2.0"/><attnum name="front Clift" val="0.2"/><attnum name="rear Clift" val="0.25"/></section>
  <section name="Front Wing"><attnum name="area" unit="m2" val="0.2"/><attnum name="angle" unit="deg" val="10"/><attnum name="xpos" unit="m" val="2.2"/><attnum name="zpos" unit="m" val="0.05"/></section>
  <section name="Rear Wing"><attnum name="area" unit="m2" val="0.25"/><attnum name="angle" unit="deg" val="15"/><attnum name="xpos" unit="m" val="-1.9"/><attnum name="zpos" unit="m" val="0.95"/></section>
  <section name="Engine">
    <attnum name="inertia" unit="kg.m2" val="0.1"/><attnum name="revs maxi" unit="rpm" val="10000"/><attnum name="revs limiter" unit="rpm" val="9000"/>
    <attnum name="tickover" unit="rpm" val="1000"/><attnum name="brake linear coefficient" val="0.05"/><attnum name="brake coefficient" val="0.05"/>
    <attstr name="turbo" val="${o.turbo ?? "false"}"/><attstr name="capacity" unit="l" val="3.6"/><attnum name="cylinders" val="8"/><attstr name="shape" val="v"/>
    <section name="data points">
      <section name="1"><attnum name="rpm" unit="rpm" val="0"/><attnum name="Tq" unit="N.m" val="0"/></section>
      <section name="2"><attnum name="rpm" unit="rpm" val="2000"/><attnum name="Tq" unit="N.m" val="300"/></section>
      <section name="3"><attnum name="rpm" unit="rpm" val="6000"/><attnum name="Tq" unit="N.m" val="400"/></section>
      <section name="4"><attnum name="rpm" unit="rpm" val="9000"/><attnum name="Tq" unit="N.m" val="330"/></section>
      <section name="5"><attnum name="rpm" unit="rpm" val="10000"/><attnum name="Tq" unit="N.m" val="0"/></section>
    </section>
  </section>
  <section name="Gearbox"><attnum name="shift time" unit="s" val="0.1"/>
    <section name="gears">
      <section name="r"><attnum name="ratio" val="-2.0"/><attnum name="efficiency" val="0.95"/></section>
      <section name="1"><attnum name="ratio" val="3.0"/><attnum name="efficiency" val="0.95"/></section>
      <section name="2"><attnum name="ratio" val="2.0"/><attnum name="efficiency" val="0.95"/></section>
      <section name="3"><attnum name="ratio" val="1.5"/><attnum name="efficiency" val="0.95"/></section>
      <section name="4"><attnum name="ratio" val="1.2"/><attnum name="efficiency" val="0.95"/></section>
      <section name="5"><attnum name="ratio" val="1.0"/><attnum name="efficiency" val="0.95"/></section>
    </section>
  </section>
  <section name="Drivetrain"><attstr name="type" val="${o.drive ?? "RWD"}"/></section>
  <section name="Rear Differential"><attstr name="type" val="LIMITED SLIP"/><attnum name="ratio" val="4.0"/><attnum name="efficiency" val="0.96"/><attnum name="max slip bias" val="0.5"/></section>
  <section name="Front Differential"><attstr name="type" val="FREE"/><attnum name="ratio" val="4.0"/><attnum name="efficiency" val="0.96"/></section>
  <section name="Steer"><attnum name="steer lock" unit="deg" val="28"/></section>
  <section name="Brake System"><attnum name="front-rear brake repartition" val="0.55"/><attnum name="max pressure" unit="kPa" val="20000"/></section>
  <section name="Front\tRight Brake"><attnum name="disk diameter" unit="mm" val="380"/><attnum name="piston area" unit="cm2" val="50"/><attnum name="mu" val="0.3"/></section>
  <section name="Front Left Brake"><attnum name="disk diameter" unit="mm" val="380"/><attnum name="piston area" unit="cm2" val="50"/><attnum name="mu" val="0.3"/></section>
  <section name="Rear Right Brake"><attnum name="disk diameter" unit="mm" val="350"/><attnum name="piston area" unit="cm2" val="30"/><attnum name="mu" val="0.3"/></section>
  <section name="Rear Left Brake"><attnum name="disk diameter" unit="mm" val="350"/><attnum name="piston area" unit="cm2" val="30"/><attnum name="mu" val="0.3"/></section>
  <section name="Front Axle"><attnum name="xpos" val="1.2"/><attnum name="inertia" val="0.006"/></section>
  <section name="Rear Axle"><attnum name="xpos" val="-1.4"/><attnum name="inertia" val="0.008"/></section>
  ${["Front Right", "Front Left", "Rear Right", "Rear Left"]
    .map(
      (w) => `<section name="${w} Wheel"><attnum name="ypos" unit="m" val="${w.includes("Right") ? -0.8 : 0.8}"/><attnum name="rim diameter" unit="in" val="18"/>
      <attnum name="tire width" unit="mm" val="${w.startsWith("Front") ? 275 : 315}"/><attnum name="tire height-width ratio" val="0.3"/><attnum name="inertia" val="1.2"/>
      <attnum name="ride height" unit="mm" val="${w.startsWith("Front") ? 75 : 85}"/><attnum name="camber" unit="deg" val="-3"/><attnum name="stiffness" val="21.5"/>
      <attnum name="dynamic friction" unit="%" val="55"/><attnum name="elasticity factor" val="0.7"/><attnum name="mu" val="1.4"/><attnum name="operating load" val="4500"/>
      <attnum name="load factor min" val="0.6"/><attnum name="load factor max" val="1.6"/></section>
      <section name="${w} Suspension"><attnum name="spring" unit="lbs/in" val="7000"/><attnum name="bellcrank" val="1.5"/><attnum name="suspension course" unit="m" val="0.15"/>
      <attnum name="packers" unit="mm" val="10"/><attnum name="slow bump" unit="lbs/in/s" val="800"/><attnum name="slow rebound" unit="lbs/in/s" val="1000"/>
      <attnum name="fast bump" unit="lbs/in/s" val="200"/><attnum name="fast rebound" unit="lbs/in/s" val="400"/><attnum name="bump limit velocity" val="0.15"/><attnum name="rebound limit velocity" val="0.15"/></section>`
    )
    .join("\n  ")}
  <section name="Front Anti-Roll Bar"><attnum name="spring" unit="lbs/in" val="3000"/></section>
  <section name="Rear Anti-Roll Bar"><attnum name="spring" unit="lbs/in" val="1500"/></section>
  <section name="Features"><attstr name="tire compounds" val="no"/></section>
  <section name="Sound"><attstr name="engine sample" val="test.wav"/><attnum name="rpm scale" val="0.7"/></section>
</params>`;

const cat = SdParams.parse(CATEGORY, "LS-GT2.xml");
const params = SdParams.parse(carXml(), "test.xml").mergeOver(cat);
check("a name's tab is read as a space (XML's attribute normalisation)", params.has("Front Right Brake", "disk diameter"));
check("the car's value stands within the category's range", params.num("Car", "mass") === 1180);
check("a car value outside the category's range is pulled into it", SdParams.parse(carXml({ mass: 1700 })).mergeOver(cat).num("Car", "mass") === 1500);
check("a key only the category has is merged in", params.num("Front Right Wheel", "stiffness") === 21.5 && params.str("Drivetrain", "type") === "RWD");
check("a string the category doesn't list keeps the category's value", SdParams.parse(carXml({ drive: "FWD" })).mergeOver(cat).str("Drivetrain", "type") === "RWD");
check("a string the category lists is the car's", SdParams.parse(carXml({ turbo: "true" })).mergeOver(cat).str("Engine", "turbo") === "true");
check("a car's sections in order, a section path read", params.sections("Engine/data points").join() === "1,2,3,4,5" && params.num("Gearbox/gears/r", "ratio") === -2);
{
  const quoted = SdParams.parse(`<params name="q"><section name="Car"><attstr name="description" val="lift > drag, 'quoted'"/><attnum name="mass" val="900"/></section></params>`);
  check("a value holding a > doesn't end its tag early", quoted.str("Car", "description") === "lift > drag, 'quoted'" && quoted.num("Car", "mass") === 900, quoted.str("Car", "description"));
  const refused = ["1e500", "inf", "-Infinity", "nan"].filter((v) => {
    try {
      SdParams.parse(`<params name="n"><section name="Car"><attnum name="mass" val="${v}"/></section></params>`);
      return false;
    } catch (err) {
      return /not a finite number/.test((err as Error).message);
    }
  });
  check("a number that isn't finite (1e500, inf, nan) is refused", refused.length === 4, refused.join(", "));
  check("…as is one a unit takes past a double's range", (() => {
    try {
      SdParams.parse(`<params name="n"><section name="Car"><attnum name="mass" unit="MPa" val="1e303"/></section></params>`);
      return false;
    } catch {
      return true;
    }
  })());
}

// ---------------------------------------------------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------------------------------------------------
const car = readSdCar(params);
const phys = sdCarPhysics(params);
const P = phys.patch as Record<string, any>;
const C = P.config;
check("an LS-GT2 car drives on the GT3 model, class gt3", phys.base === "amg-gt3" && phys.classId === "gt3", phys.base);
check("mass, weight split, wheelbase and tracks", C.chassis.totalMassKg === 1180 && C.chassis.frontWeightFraction === 0.44 && near(C.chassis.wheelbase, 2.6) && near(C.chassis.trackWidthFront, 1.6));
check("CG height = GC height + the ride heights by weight", near(C.chassis.cgHeight, 0.29 + 0.44 * 0.075 + 0.56 * 0.085));
check("inertia: simuv5's box, m k² (a² + b²) / 12", near(C.chassis.inertia.yaw, (1180 * 0.64 * (2 * 2 + 4.4 * 4.4)) / 12) && near(C.chassis.inertia.roll, (1180 * 0.64 * (4 + 1.21)) / 12));
const kw6000 = C.engine.powerCurve.find((p: number[]) => Math.abs(p[0] - 6000) < 1)?.[1];
check("power = torque × ω at each point", near(kw6000, (400 * 6000 * RPM) / 1000, 1e-5), `${kw6000} kW at 6000 rpm`);
check("limiter, idle and engine braking (bL ω + bC × max torque)", near(C.gearbox.gears.redline_rpm, 9000, 1e-5) && near(C.engine.idleRpm, 1000, 1e-5) && near(C.engine.coastCurve[C.engine.coastCurve.length - 1][1], 0.05 * 9000 * RPM + 0.05 * 400, 1e-4));
check("fuel flow at peak power from the fuel cons factor, though the base names none", near(P.fuelLPerS1000Rpm, (0.75e-7 * 1000 * Math.max(...C.engine.powerCurve.map((p: number[]) => p[1])) * 0.0622) / (C.engine.powerCurve.reduce((a: number[], b: number[]) => (b[1] > a[1] ? b : a))[0] / 1000), 1e-6));
check("gears, final drive (the driven differential's ratio), efficiency (gears × differential)", C.gearbox.ratios.join() === "3,2,1.5,1.2,1" && C.gearbox.finalDrive === 4 && near(C.gearbox.efficiency, 0.95 * 0.96) && C.gearbox.reverse === 2);
const front = 0.19 * 0.005 * 0.3 * 2e7 * 0.55;
const rear = 0.175 * 0.003 * 0.3 * 2e7 * 0.45;
check("brakes: a front and a rear wheel's full-pedal torque, and the front's share", near(C.brakes.maxTorqueNm, front + rear, 1e-6) && near(C.brakes.front_bias, front / (front + rear)), `${C.brakes.maxTorqueNm.toFixed(0)} Nm, ${C.brakes.front_bias.toFixed(3)}`);
const comp = Object.values(C.tyreCompounds)[0] as Record<string, any>;
check("tyre radius = rim / 2 + width × ratio", near(comp.front.radius, 0.2286 + 0.275 * 0.3) && near(comp.rear.width, 0.315));
const tf = car.tyres.front;
const dyAtOp = comp.modelData.dyCurve.find((p: number[]) => p[0] >= tf.operatingLoadN)?.[1];
check("grip: μ × the load factor, exactly μ at the operating load", near(sdTyreMu(tf, 1.4, 4500), 1.4) && near(sdTyreMu(tf, 1.4, 0), 1.4 * 1.6) && near(dyAtOp, 1.4, 1e-5));
const curve = sdTyreCurve(tf);
check("the magic formula's peak and sliding level", near(curve.at(curve.peakSlip), 1, 1e-6) && near(curve.at(50), 0.55, 0.05) && near(comp.modelData.falloff_level, 0.55), `peak slip ${curve.peakSlip.toFixed(3)}`);
const spring = 7000 * (0.45359237 / 0.0254);
check("springs and dampers at the wheel: × bellcrank², the knee ÷ bellcrank", near(C.suspensions.front.springs.wheel_rate, spring * 2.25) && near(C.suspensions.dampers_controller.front.base.slow_bump, 800 * (0.45359237 / 0.0254) * 2.25) && near(C.suspensions.dampers_controller.front.fastThresholdMs, 0.1));
check("anti-roll bars, camber, travel to the packers and to full droop", near(C.suspensions.front.arb, 3000 * (0.45359237 / 0.0254) * 1.5) && near(C.suspensions.front.staticCamber, -3) && near(C.suspensions.front.bumpStop.range, 0.065) && near(C.suspensions.front.droopTravel, 0.075));
check("a limited-slip differential locks on power only", C.differential.settings.power > 0 && C.differential.settings.coast === 0);
const targets = sdAeroTargets(car);
check("aero: drag ½ρ Cx A + the wings', downforce on both axles", near(targets.drag, 0.5 * 1.29 * 0.32 * 2, 0.6) && targets.front > 0 && targets.rear > targets.front * 0.8, JSON.stringify(Object.fromEntries(Object.entries(targets).map(([k, v]) => [k, Number(v.toFixed(3))]))));

const profileOf = (base: VehicleModelId, patch: Record<string, unknown>) => modSimProfile(VEHICLE_MODELS[base].simProfile!, { format: MOD_PHYSICS_FORMAT, profile: patch }, "mod:sd/test");
const onBase = profileOf(phys.base, phys.patch);
check("the patch passes the game's physics rules (modSimProfile)", onBase.ok, onBase.ok ? "" : onBase.errors.slice(0, 3).join("; "));
const failing = PHYSICS_BASES.filter((b) => !profileOf(b, sdCarPhysics(params, { base: b }).patch).ok);
check("the same car on every base the game takes a physics file on", failing.length === 0, failing.length ? `refused on ${failing.join(", ")}` : `${PHYSICS_BASES.length} bases`);
const fwd = SdParams.parse(carXml({ drive: "FWD" }).replace('name="category" val="LS-GT2"', 'name="category" val="Supercars"'));
const fwdPhys = sdCarPhysics(fwd);
check("a front-driven road car goes on a road base that drives its fronts", (fwdPhys.base === "liana" || fwdPhys.base === "vw-scirocco-gtx") && (fwdPhys.patch as any).config.drivenAxle === "front" && profileOf(fwdPhys.base, fwdPhys.patch).ok, fwdPhys.base);
check("an open-wheeler of 2022 goes on the 2026 car, a 1936 GP car on a Chaparral", chooseBase({ ...car, category: "22MP1", massKg: 760, frontWeight: 0.45 }).base === "f12026-car" && chooseBase({ ...car, category: "36GP" }).base.startsWith("chaparral"));
const f1 = sdCarPhysics(params, { base: "f12026-car" }).patch as Record<string, any>;
check("on the 2026 car: no hybrid, no DRS, no active aero", f1.hasErs === false && f1.hasDrs === false && f1.config.ers.ERS_MAX_DEPLOY === 0 && f1.config.aero.rhMap.activeAero.dCdA === 0);

// Parameters the conversion can't take are refused, each named, rather than turned into NaN or a nonsense profile
{
  check("the made-up car's parameters all convert", sdCarProblems(car).length === 0, sdCarProblems(car).join("; "));
  const refusedBy = (xml: string): string => {
    try {
      sdCarPhysics(SdParams.parse(xml).mergeOver(cat));
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  };
  const xml = carXml();
  const cases: [string, string, RegExp][] = [
    ["no torque between tickover and the limiter", xml.replace(/<section name="data points">[\s\S]*?<\/section>\s*<\/section>/, '<section name="data points"><section name="1"><attnum name="rpm" unit="rpm" val="9500"/><attnum name="Tq" unit="N.m" val="300"/></section><section name="2"><attnum name="rpm" unit="rpm" val="9900"/><attnum name="Tq" unit="N.m" val="200"/></section></section>'), /no torque between the tickover and the limiter/],
    ["a wheelbase of 0", xml.replace('<section name="Rear Axle"><attnum name="xpos" val="-1.4"/>', '<section name="Rear Axle"><attnum name="xpos" val="1.2"/>'), /wheelbase .* is 0/],
    ["brakes with no pressure", xml.replace('<attnum name="max pressure" unit="kPa" val="20000"/>', '<attnum name="max pressure" unit="kPa" val="0"/>'), /brakes' torque/],
    ["a bellcrank of 0", xml.replaceAll('<attnum name="bellcrank" val="1.5"/>', '<attnum name="bellcrank" val="0"/>'), /suspensions\/bellcrank is 0/],
    ["a thin wing of aspect ratio 0", xml.replace('<section name="Front Wing"><attnum name="area" unit="m2" val="0.2"/>', '<section name="Front Wing"><attstr name="wing type" val="THIN"/><attnum name="aspect ratio" val="0"/><attnum name="area" unit="m2" val="0.2"/>'), /Front Wing\/aspect ratio is 0/],
    ["a profile wing peaking at 0°", xml.replace('<section name="Rear Wing"><attnum name="area" unit="m2" val="0.25"/>', '<section name="Rear Wing"><attstr name="wing type" val="PROFILE"/><attnum name="aoa at max" val="0"/><attnum name="area" unit="m2" val="0.25"/>'), /aoa at max \+ aoa offset is 0/],
    ["a dynamic friction of 100 %", xml.replaceAll('<attnum name="dynamic friction" unit="%" val="55"/>', '<attnum name="dynamic friction" unit="%" val="100"/>'), /dynamic friction is 1 \(under 99 %/],
    ["a tyre stiffness of 0", xml.replaceAll('<attnum name="stiffness" val="21.5"/>', '<attnum name="stiffness" val="0"/>'), /wheels\/stiffness is 0/],
  ];
  for (const [what, x, want] of cases) {
    const why = refusedBy(x);
    check(`a car with ${what} is refused, the value named`, want.test(why), why.slice(0, 160) || "converted");
  }
  const soft = { ...car.tyres.front, stiffness: 2, dynamicFriction: 0.98 };
  check("a tyre curve that doesn't peak below a slip of 2 has no peak (not 2.0)", sdTyreCurve(soft).peakSlip === Infinity && sdCarProblems({ ...car, tyres: { front: soft, rear: car.tyres.rear } }).some((p) => /peak slip/.test(p)));
  let aeroErr = "";
  try {
    sdAeroTargets({ ...car, xFront: 0, xRear: 0 });
  } catch (err) {
    aeroErr = (err as Error).message;
  }
  check("the aero targets refuse a wheelbase of 0 rather than give NaN", /wheelbase of 0/.test(aeroErr), aeroErr);
}

// The aero fit and the drive, on the made-up GT car
{
  const base = VEHICLE_MODELS[phys.base].simProfile!;
  const prof = (patch: Record<string, unknown>) => {
    const r = profileOf(phys.base, patch);
    if (!r.ok) throw new Error(r.errors.join("; "));
    return r.profile;
  };
  const fit = fitAero(base, phys.patch, targets, prof);
  const err = (k: "front" | "rear" | "drag") => Math.abs(fit.measured[k] - targets[k]) / Math.max(0.05, targets[k]);
  check("the aero fit makes Speed Dreams' downforce on each axle and its drag, within 6 %", err("front") < 0.06 && err("rear") < 0.06 && err("drag") < 0.06, `front ${fit.measured.front.toFixed(3)}/${targets.front.toFixed(3)} rear ${fit.measured.rear.toFixed(3)}/${targets.rear.toFixed(3)} drag ${fit.measured.drag.toFixed(3)}/${targets.drag.toFixed(3)}`);
  const s = driveSanity(prof(withAero(phys.patch, fit.aero)), { minTopSpeedKmh: 200, maxTopSpeedKmh: 330, maxStop100M: 45 });
  check("driven: no spin on the straight, a plausible top speed, it brakes", s.ok, `${s.topSpeedKmh.toFixed(0)} km/h, 100–0 in ${s.stop100M?.toFixed(1)} m ${s.problems.join("; ")}`);
  // A profile whose simulation goes NaN, and a NaN limit: every comparison with NaN is false, so neither may pass
  const broken = structuredClone(prof(withAero(phys.patch, fit.aero)));
  broken.config.chassis.totalMassKg = Number.NaN;
  const sb = driveSanity(broken, { minTopSpeedKmh: 200, maxTopSpeedKmh: 330, maxStop100M: 45 });
  check("a car whose simulation goes NaN fails the drive", !sb.ok && sb.problems.some((p) => /NaN/.test(p)), sb.problems.join("; "));
  let limitErr = "";
  try {
    driveSanity(prof(withAero(phys.patch, fit.aero)), { minTopSpeedKmh: Number.NaN, maxTopSpeedKmh: 330, maxStop100M: 45 });
  } catch (err) {
    limitErr = (err as Error).message;
  }
  check("a NaN limit is refused, not passed", /not a finite number/.test(limitErr), limitErr);

  // On a ride-height map base (the 2026 car): a car that makes lift overall, and one that states negative drag
  const mapBase = VEHICLE_MODELS["f12026-car"].simProfile!;
  const f1Patch = sdCarPhysics(params, { base: "f12026-car" }).patch;
  const mapProf = (patch: Record<string, unknown>) => {
    const r = profileOf("f12026-car", patch);
    if (!r.ok) throw new Error(r.errors.join("; "));
    return r.profile;
  };
  const lift = fitAero(mapBase, f1Patch, { front: -0.05, rear: -0.05, drag: -0.2 }, mapProf);
  const map = (lift.aero as { rhMap: { clA: number; cdA: number }; wings: { area: number }[] }).rhMap;
  const wings = (lift.aero as { wings: { area: number }[] }).wings;
  check(
    "a car that makes lift overall gets none of the map's downforce, and a negative drag no negative drag",
    map.clA === 0 && wings.every((w) => w.area === 0) && map.cdA === 0 && lift.notes.some((n) => /lift overall/.test(n)),
    JSON.stringify({ clA: map.clA, cdA: map.cdA, notes: lift.notes }),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------------------------------------------------
const FAL = "Copyleft: this work of art is free, you can redistribute it and/or modify it according to terms of the Free Art license.\nYou will find a specimen of this license on the site Copyleft Attitude http://artlibre.org";
check("Speed Dreams' readme: the Free Art License", readLicenceText(FAL).licences.join() === "FAL-1.3" && shareable(readLicenceText(FAL)));
check("the XML's header: GPL-2.0-or-later", readLicenceText("either version 2 of the License, or (at your option) any later version. GNU General Public License").licences.join() === "GPL-2.0-or-later");
check('"Creative Commons" with no licence named, or parts owned by others: unclear', !shareable(readLicenceText("Everything is available through Creative Commons license. The logos are property of their owners.")));
check("all rights reserved, personal use, no derivatives: refused", !shareable(readLicenceText("All rights reserved")) && !shareable(readLicenceText("For personal use only")) && !shareable(readLicenceText("CC BY-ND 4.0")));
check("the official list: FAL clear; \"GNU Public License (v2?)\" and an asterisk unclear", shareable(readLicenceEntry("Free Art License")) && !shareable(readLicenceEntry("GNU Public License (v2?)")) && !shareable(readLicenceEntry("GPL 2.0, CC-BY-SA 3.0, Free Art License*")) && shareable(readLicenceEntry("Free Art License, CC-BY 4.0")));
{
  const d = join(tmp, "licence", "test-car");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "test-car.xml"), carXml());
  check("no readme and not in the official list: no licence, refused", !shareable(findCarLicence(d, "test-car", []).reading) && findCarLicence(d, "test-car", []).source === "none");
  check("no readme, in the official list: the list's licence", findCarLicence(d, "test-car", [], "Free Art License").source === "database" && shareable(findCarLicence(d, "test-car", [], "Free Art License").reading));
  writeFileSync(join(d, "readme.txt"), `Copyright 2020 A. Modeller\n\n${FAL}`);
  writeFileSync(join(d, "test-car-blue-readme.txt"), "My livery, available through Creative Commons license.");
  const l = findCarLicence(d, "test-car", ["blue"], "GNU Public License (v2?)");
  check("the car's readme before the list; its data's GPL header; a livery's own readme", l.source === "readme" && shareable(l.reading) && l.data?.licences.join() === "GPL-2.0-or-later" && !!l.liveries.blue && !shareable(l.liveries.blue.reading));
}
const pins = readPins();
check("the pinned cars: every one at a commit or a sha256-checked zip", Object.values(pins.cars).every((c) => (c.repo && /^[0-9a-f]{40}$/.test(c.commit ?? "")) || (c.zip && /^[0-9a-f]{64}$/.test(c.sha256 ?? ""))) && /^[0-9a-f]{40}$/.test(pins.data.commit), `${Object.keys(pins.cars).length} cars`);

// ---------------------------------------------------------------------------------------------------------------------
// The rig and the sound bank (the Python converters, when uv is there)
// ---------------------------------------------------------------------------------------------------------------------
const hasUv = spawnSync("uv", ["--version"]).status === 0;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** An AC3D object: a box of half sizes `h` at `c` (AC frame: x forward, y up, z right) */
function acBox(name: string, c: number[], h: number[], texture = "test-car.png"): string {
  const v: number[][] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) v.push([c[0] + sx * h[0], c[1] + sy * h[1], c[2] + sz * h[2]]);
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  return [
    "OBJECT poly",
    `name "${name}"`,
    `texture "${texture}" base`,
    `numvert ${v.length}`,
    ...v.map((p) => p.map((x) => x.toFixed(4)).join(" ")),
    `numsurf ${quads.length}`,
    ...quads.flatMap((q) => ["SURF 0x10", "mat 0", "refs 4", ...q.map((i, k) => `${i} ${k & 1} ${k >> 1}`)]),
    "kids 0",
  ].join("\n");
}
/**
 * A unit wheel (diameter 1, width 1 along z): a TIRE ring and a RIM disc, as the game's wheel0.acc has them; with
 * `normals`, each vertex carries its normal, as an .acc may
 */
function acWheel(normals = false): string {
  const n = 16;
  const ring = (r: number) => Array.from({ length: n }, (_, i) => [Math.cos((2 * Math.PI * i) / n) * r, Math.sin((2 * Math.PI * i) / n) * r]);
  const outer = ring(0.5);
  const inner = ring(0.35);
  const tireV = [...outer.map(([x, y]) => [x, y, -0.5]), ...outer.map(([x, y]) => [x, y, 0.5])];
  const vrow = (p: number[], nrm: number[]) => (normals ? [...p, ...nrm] : p).join(" ");
  const tire = ["OBJECT poly", 'name "TIRE_s_1"', 'texture "wheel3d.png" base', `numvert ${tireV.length}`, ...tireV.map((p) => vrow(p, [p[0] / 0.5, p[1] / 0.5, 0])), `numsurf ${n}`];
  for (let i = 0; i < n; i++) tire.push("SURF 0x10", "mat 0", "refs 4", `${i} 0 0`, `${(i + 1) % n} 1 0`, `${n + ((i + 1) % n)} 1 1`, `${n + i} 0 1`);
  tire.push("kids 0");
  const rimV = [[0, 0, -0.4], ...inner.map(([x, y]) => [x, y, -0.4])];
  const rim = ["OBJECT poly", 'name ":WI"', 'texture "wheel3d.png" base', `numvert ${rimV.length}`, ...rimV.map((p) => vrow(p, [0, 0, -1])), `numsurf ${n}`];
  for (let i = 0; i < n; i++) rim.push("SURF 0x30", "mat 0", "refs 3", "0 0.5 0.5", `${1 + i} 0 0`, `${1 + ((i + 1) % n)} 1 0`);
  rim.push("kids 0");
  return `AC3Db\nMATERIAL "m" rgb 1 1 1 amb 0.5 0.5 0.5 emis 0 0 0 spec 0 0 0 shi 10 trans 0\nOBJECT world\nkids 2\n${tire.join("\n")}\n${rim.join("\n")}\n`;
}

function readGlbJson(file: string): Record<string, any> {
  const b = readFileSync(file);
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString("utf8"));
}

if (!hasUv) console.log("SKIP  the rig: uv is not installed");
else {
  const d = join(tmp, "cars", "models", "test-car");
  mkdirSync(d, { recursive: true });
  const body = [acBox("BODY_s_0", [0, 0.45, 0], [2.2, 0.35, 0.95]), acBox("GLASS_s_0", [-0.2, 0.95, 0], [0.6, 0.15, 0.8])].join("\n");
  writeFileSync(join(d, "test-car.acc"), `AC3Db\nMATERIAL "m" rgb 1 1 1 amb 0.5 0.5 0.5 emis 0 0 0 spec 0.5 0.5 0.5 shi 50 trans 0\nOBJECT world\nkids 2\n${body}\n`);
  writeFileSync(join(d, "wheel0.acc"), acWheel());
  writeFileSync(join(d, "steer.acc"), `AC3Db\nMATERIAL "m" rgb 0.1 0.1 0.1 amb 0.5 0.5 0.5 emis 0 0 0 spec 0 0 0 shi 10 trans 0\nOBJECT world\nkids 1\n${acBox("RIM_s_0", [0, 0, 0], [0.02, 0.17, 0.17], "")}\n`);
  // Textures: the paint, its blue livery, the wheels
  const png = (rgb: number[]) => {
    // A 2 × 2 RGBA PNG written by hand (zlib-stored)
    const raw = Buffer.alloc(2 * (1 + 8));
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) raw.set([...rgb, 255], y * 9 + 1 + x * 4);
    const chunk = (type: string, data: Buffer) => {
      const out = Buffer.alloc(12 + data.length);
      out.writeUInt32BE(data.length, 0);
      out.write(type, 4, "ascii");
      data.copy(out, 8);
      const crc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data]));
      out.writeUInt32BE(crc >>> 0, 8 + data.length);
      return out;
    };
    const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  };
  writeFileSync(join(d, "test-car.png"), png([200, 20, 20]));
  writeFileSync(join(d, "test-car-blue.png"), png([20, 40, 200]));
  writeFileSync(join(d, "wheel3d.png"), png([60, 60, 60]));
  const xml = carXml({ name: "Test Car" }).replace('<section name="Car">', `<section name="Graphic Objects"><section name="Ranges"><section name="1"><attstr name="car" val="test-car.acc"/></section></section>
    <section name="Steer Wheel"><attstr name="hi res model" val="steer.acc"/><attnum name="xpos" val="0.3"/><attnum name="ypos" val="0.35"/><attnum name="zpos" val="0.6"/><attnum name="angle" val="12"/></section></section>
  <section name="Driver"><attnum name="xpos" val="-0.1"/><attnum name="ypos" val="0.35"/><attnum name="zpos" val="0.85"/></section>
  <section name="Car">`);
  writeFileSync(join(d, "test-car.xml"), xml);
  const pj = join(tmp, "params.json");
  const sections: Record<string, Record<string, number | string>> = {};
  for (const [path, key, a] of SdParams.parse(xml).entries()) (sections[path] ??= {})[key] = a.val;
  writeFileSync(pj, JSON.stringify({ sections }));
  const glb = join(tmp, "test-car.glb");
  const skins = join(tmp, "skins");
  const info = join(tmp, "info.json");
  const r = spawnSync("uv", ["run", "--python", "3.14", "--no-project", "--with", "numpy==2.4.3", "--with", "pillow==13.0.0", "python", "-P", "scripts/cars/port_sd_car.py", d, glb, "--params", pj, "--skins-out", skins, "--info", info], { encoding: "utf8" });
  check("port_sd_car.py converts a made-up car", r.status === 0 && existsSync(glb), r.status === 0 ? "" : (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | "));
  if (r.status === 0) {
    const j = readGlbJson(glb);
    const nodes = j.nodes as { name: string; children?: number[]; mesh?: number; extras?: Record<string, any>; translation?: number[] }[];
    const byName = (n: string) => nodes.find((x) => x.name === n);
    const root = nodes.find((n) => n.extras?.wheelCentres)!;
    const ex = root.extras!;
    const kids = (n: { children?: number[] }) => (n.children ?? []).map((i) => nodes[i].name);
    check("the rig: CAR with BODY, STEER and four WHEEL_xx, each a _RIM and a one-primitive _TYRE", root.name === "CAR" && ["BODY", "STEER", "WHEEL_RF", "WHEEL_LF", "WHEEL_RR", "WHEEL_LR"].every((n) => kids(root).includes(n)) && ["RF", "LF", "RR", "LR"].every((c) => kids(byName(`WHEEL_${c}`)!).join() === `WHEEL_${c}_RIM,WHEEL_${c}_TYRE` && j.meshes[byName(`WHEEL_${c}_TYRE`)!.mesh!].primitives.length === 1));
    const radius = 0.2286 + 0.275 * 0.3;
    check("wheels at the axles and the wheels' ypos (+X left), centres a tyre radius up, mirrored", near(ex.wheelCentres.WHEEL_LF[2], 1.2) && near(ex.wheelCentres.WHEEL_LR[2], -1.4) && near(ex.wheelCentres.WHEEL_LF[0], 0.8) && near(ex.wheelCentres.WHEEL_RF[0], -0.8) && near(ex.wheelCentres.WHEEL_LF[1], radius, 1e-3) && near(ex.tyreRadius.LF, radius, 1e-3) && near(ex.wheelbaseM, 2.6), `${JSON.stringify(ex.wheelCentres)} r ${ex.tyreRadius.LF}`);
    const tyreAcc = j.accessors[j.meshes[byName("WHEEL_LF_TYRE")!.mesh!].primitives[0].attributes.POSITION];
    check("the tyre's lowest point on the ground, its width the tyre's", near(ex.wheelCentres.WHEEL_LF[1] + tyreAcc.min[1], 0, 1e-3) && near(tyreAcc.max[0] - tyreAcc.min[0], 0.275, 1e-3), `min ${tyreAcc.min} max ${tyreAcc.max}`);
    check("the cockpit camera at the XML's driver point, all six cameras", near(ex.cameras.cockpit.pos[0], 0.35, 1e-3) && near(ex.cameras.cockpit.pos[2], -0.1, 1e-3) && ["cockpit", "tcam", "dash", "bumper", "nearChase", "farChase"].every((k) => ex.cameras[k]));
    check("the steering column tilted by the XML's angle, into the dash", near(ex.steer.columnAxis[1], -Math.sin((12 * Math.PI) / 180), 1e-4) && ex.steer.columnAxis[2] > 0.9);
    const glass = j.materials.find((m: any) => m.name.startsWith("glass"));
    check("glass (GLASS…, :WI…) blended, the body opaque and named as paint", glass?.alphaMode === "BLEND" && j.materials.some((m: any) => m.name.startsWith("paint") && !m.alphaMode));
    check("a livery: its files named as skinMaps names them", Object.values(ex.skinMaps ?? {}).every((f) => existsSync(join(skins, "blue", f as string))) && Object.keys(ex.skinMaps ?? {}).length > 0, JSON.stringify(ex.skinMaps));
    // The same car with its steering wheel modelled into the body, and no `Steer Wheel` of its own
    const d2 = join(tmp, "cars", "models", "test-car2");
    mkdirSync(d2, { recursive: true });
    for (const f of readdirSync(d)) writeFileSync(join(d2, f.replace("test-car", "test-car2")), readFileSync(join(d, f)));
    const wheelInBody = acBox("INTERIOR_s_0", [0.35, 0.6, -0.35], [0.015, 0.14, 0.14]);
    writeFileSync(join(d2, "test-car2.acc"), `AC3Db\nMATERIAL "m" rgb 1 1 1 amb 0.5 0.5 0.5 emis 0 0 0 spec 0.5 0.5 0.5 shi 50 trans 0\nOBJECT world\nkids 2\n${body}\n${wheelInBody}\n`.replace("kids 2", "kids 3"));
    const xml2 = xml.replace(/<section name="Steer Wheel">[\s\S]*?<\/section>/, "").replace("test-car.acc", "test-car2.acc");
    const sections2: Record<string, Record<string, number | string>> = {};
    for (const [path, key, a] of SdParams.parse(xml2).entries()) (sections2[path] ??= {})[key] = a.val;
    writeFileSync(pj, JSON.stringify({ sections: sections2 }));
    const glb2 = join(tmp, "test-car2.glb");
    const r2 = spawnSync("uv", ["run", "--python", "3.14", "--no-project", "--with", "numpy==2.4.3", "--with", "pillow==13.0.0", "python", "-P", "scripts/cars/port_sd_car.py", d2, glb2, "--params", pj], { encoding: "utf8" });
    const j2 = r2.status === 0 ? readGlbJson(glb2) : null;
    const root2 = j2?.nodes.find((n: any) => n.extras?.wheelCentres);
    check("a steering wheel modelled into the body is found and made the STEER node", !!root2 && (root2.children ?? []).some((i: number) => j2!.nodes[i].name === "STEER") && root2.extras.steer.columnAxis[2] > 0.9, r2.status === 0 ? JSON.stringify(root2?.extras.steer) : r2.stderr.split("\n").slice(-2).join(" | "));

    const plan = JSON.parse(readFileSync(info, "utf8")).bodyPlan as number[][];
    check("the body's outline from nose to tail", plan.length >= 3 && plan[0][0] === 0 && plan[plan.length - 1][0] === 0 && near(Math.max(...plan.map((p) => p[0])), 0.95, 0.02), JSON.stringify(plan));

  }

  // Broken or crafted models and names: a clean refusal, or the part left out, never a crash or a file outside the port's
  const variant = (name: string, edit: (dir: string) => void, xmlEdit: (x: string) => string = (x) => x) => {
    const dv = join(tmp, "variants", "cars", "models", "test-car");
    rmSync(join(tmp, "variants"), { recursive: true, force: true });
    mkdirSync(dv, { recursive: true });
    for (const f of readdirSync(d)) writeFileSync(join(dv, f), readFileSync(join(d, f)));
    edit(dv);
    const x = xmlEdit(xml);
    const secs: Record<string, Record<string, number | string>> = {};
    for (const [path, key, a] of SdParams.parse(x).entries()) (secs[path] ??= {})[key] = a.val;
    const pjv = join(tmp, "variants", "params.json");
    writeFileSync(pjv, JSON.stringify({ sections: secs }));
    const out = join(tmp, "variants", "out");
    const rv = spawnSync(
      "uv",
      ["run", "--python", "3.14", "--no-project", "--with", "numpy==2.4.3", "--with", "pillow==13.0.0", "python", "-P", "scripts/cars/port_sd_car.py", dv, `${out}.glb`, "--params", pjv, "--skins-out", join(out, "skins"), "--info", `${out}.json`],
      { encoding: "utf8" },
    );
    return { name, ok: rv.status === 0, out: `${rv.stdout}${rv.stderr}`, info: rv.status === 0 ? JSON.parse(readFileSync(`${out}.json`, "utf8")) : null, root: join(tmp, "variants"), glb: `${out}.glb` };
  };
  // A wheel model with normals of its own, scaled to each tyre's size: they must come out unit length again
  const normalled = variant("wheel normals", (dv) => writeFileSync(join(dv, "wheel0.acc"), acWheel(true)));
  if (!normalled.ok) check("a wheel model with normals converts", false, normalled.out.trim().split("\n").pop());
  else {
    const gj = readGlbJson(normalled.glb);
    const bytes = readFileSync(normalled.glb);
    const binAt = 20 + bytes.readUInt32LE(12) + 8;
    const tyreNode = (gj.nodes as { name: string; mesh?: number }[]).find((n) => n.name === "WHEEL_LF_TYRE")!;
    const acc = gj.accessors[gj.meshes[tyreNode.mesh!].primitives[0].attributes.NORMAL];
    const view = gj.bufferViews[acc.bufferView];
    const at = binAt + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const lengths = Array.from({ length: acc.count }, (_, k) => Math.hypot(...[0, 1, 2].map((c) => bytes.readFloatLE(at + (view.byteStride ?? 12) * k + 4 * c))));
    check("a scaled wheel's own normals come out unit length", lengths.every((l) => Math.abs(l - 1) < 1e-3), `${Math.min(...lengths).toFixed(4)}..${Math.max(...lengths).toFixed(4)}`);
  }
  const bodyWith = (objects: string) => `AC3Db\nMATERIAL "m" rgb 1 1 1 amb 0.5 0.5 0.5 emis 0 0 0 spec 0.5 0.5 0.5 shi 50 trans 0\nOBJECT world\nkids 2\n${objects}\n`;
  const box = acBox("BODY_s_0", [0, 0.45, 0], [2.2, 0.35, 0.95]);
  const glass = acBox("GLASS_s_0", [-0.2, 0.95, 0], [0.6, 0.15, 0.8]);
  // An object's `data` runs over two lines, the second of which reads like a keyword: the object must not end there
  const withData = variant("data", (dv) => writeFileSync(join(dv, "test-car.acc"), bodyWith(`${box.replace('name "BODY_s_0"', 'name "BODY_s_0"\ndata 13\nhello\nkids 0')}\n${glass}`)));
  check("an object's data over several lines is skipped whole", withData.ok && near(withData.info?.bodyBox.max[0], 0.95, 0.01), withData.ok ? JSON.stringify(withData.info?.bodyBox) : withData.out.trim().split("\n").pop());
  const clean = (r: { ok: boolean; out: string }) => !r.ok && !/Traceback/.test(r.out) && r.out.trim().length > 0;
  for (const r of [
    variant("a negative vertex index", (dv) => writeFileSync(join(dv, "test-car.acc"), bodyWith(`${box.replace(/refs 4\n0 0 0/, "refs 4\n-1 0 0")}\n${glass}`))),
    variant("a model cut short", (dv) => writeFileSync(join(dv, "test-car.acc"), bodyWith(box).slice(0, bodyWith(box).indexOf("numsurf") - 40))),
    variant("a body with no geometry", (dv) => writeFileSync(join(dv, "test-car.acc"), "AC3Db\nOBJECT world\nkids 0\n")),
    variant("a tyre 0 mm wide", () => undefined, (x) => x.replaceAll('<attnum name="tire width" unit="mm" val="275"/>', '<attnum name="tire width" unit="mm" val="0"/>')),
  ]) {
    check(`port_sd_car.py refuses a car with ${r.name} with a message, not a crash`, clean(r), r.out.trim().split("\n").pop()?.slice(0, 120));
  }
  const sneaky = variant("a livery named ..", (dv) => writeFileSync(join(dv, "test-car-...png"), readFileSync(join(d, "test-car-blue.png"))));
  const outside = readdirSync(join(sneaky.root, "out")).filter((f) => f !== "skins");
  check(
    "a livery whose name is .. is left out, and writes nothing beside the liveries' folder",
    sneaky.ok && !sneaky.info.skinIds.includes("..") && !outside.length,
    sneaky.ok ? `${JSON.stringify(sneaky.info.skinIds)} ${outside.join(", ")}` : sneaky.out.trim().split("\n").pop(),
  );
}

if (!hasUv || !hasFfmpeg) console.log("SKIP  the sound bank: uv or ffmpeg is not installed");
else {
  // A 150 Hz tone: played by Speed Dreams at rpm_scale × rpm / 5729.6 times its own speed
  const rate = 22050;
  const secs = 1.5;
  const n = Math.round(rate * secs);
  const wav = Buffer.alloc(44 + 2 * n);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + 2 * n, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(2 * n, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 150 * i) / rate)), 44 + 2 * i);
  const wf = join(tmp, "tone.wav");
  writeFileSync(wf, wav);
  const out = join(tmp, "audio");
  const r = spawnSync("uv", ["run", "--python", "3.14", "--no-project", "--with", "numpy==2.4.3", "--with", "scipy==1.18.1", "--with", "fsb5", "python", "-P", "scripts/audio/port_sd_sound.py", wf, out, "--rpm-scale", "0.5", "--limiter", "9000", "--idle", "1000"], { encoding: "utf8" });
  check("port_sd_sound.py writes a bank", r.status === 0 && existsSync(join(out, "manifest.json")), r.status === 0 ? "" : (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | "));
  if (r.status === 0) {
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    const on = m.engine.ext.filter((e: any) => e.layer === "on");
    check("on and off loops from idle to the limiter, the same for cockpit and outside", on.length >= 4 && on[on.length - 1].rpm === 9000 && m.engine.int.length === m.engine.ext.length && m.engine.ext.some((e: any) => e.layer === "off"));
    // The loop at 9000 rpm must hold the tone at 150 × 0.5 × 9000 / 5729.6 Hz
    const top = join(out, on[on.length - 1].file);
    const dec = spawnSync("ffmpeg", ["-v", "error", "-i", top, "-f", "f32le", "-ac", "1", "-ar", "48000", "-"], { maxBuffer: 64 << 20 });
    const pcm = new Float32Array(dec.stdout.buffer, dec.stdout.byteOffset, Math.floor(dec.stdout.length / 4));
    let crossings = 0;
    for (let i = 1; i < pcm.length; i++) if (pcm[i - 1] < 0 && pcm[i] >= 0) crossings++;
    const hz = crossings / (pcm.length / 48000);
    const want = (150 * 0.5 * 9000) / ((600 * 30) / Math.PI);
    check("each loop at Speed Dreams' pitch for its rpm", Math.abs(hz - want) / want < 0.02, `${hz.toFixed(1)} Hz, Speed Dreams ${want.toFixed(1)} Hz`);
    const offTop = m.engine.ext.find((e: any) => e.layer === "off" && e.rpm === 9000);
    check("off throttle at Speed Dreams' quieter curve", offTop.rms < on[on.length - 1].rms && near(offTop.rms / on[on.length - 1].rms, Math.exp(1.3 * (0.25 - 1)) / 1, 0.02));
  }
  // Values that would divide by 0 or loop on nothing, and an ffmpeg that isn't there: a message, not a crash
  const empty = join(tmp, "empty.wav");
  // The tone's header with no samples after it
  const header = Buffer.from(wav.subarray(0, 44));
  header.writeUInt32LE(36, 4);
  header.writeUInt32LE(0, 40);
  writeFileSync(empty, header);
  const soundRun = (args: string[]) =>
    spawnSync("uv", ["run", "--python", "3.14", "--no-project", "--with", "numpy==2.4.3", "--with", "scipy==1.18.1", "--with", "fsb5", "python", "-P", "scripts/audio/port_sd_sound.py", ...args], { encoding: "utf8" });
  for (const [what, args] of [
    ["an rpm scale of 0", [wf, join(tmp, "a0"), "--rpm-scale", "0", "--limiter", "9000", "--idle", "1000"]],
    ["a limiter of 0", [wf, join(tmp, "a1"), "--rpm-scale", "0.5", "--limiter", "0", "--idle", "1000"]],
    ["a sample with no frames", [empty, join(tmp, "a2"), "--rpm-scale", "0.5", "--limiter", "9000", "--idle", "1000"]],
    ["an ffmpeg that isn't there", [wf, join(tmp, "a3"), "--rpm-scale", "0.5", "--limiter", "9000", "--idle", "1000", "--ffmpeg", join(tmp, "no-ffmpeg")]],
  ] as const) {
    const r = soundRun([...args]);
    const out = `${r.stdout}${r.stderr}`;
    check(`port_sd_sound.py refuses ${what} with a message, not a crash`, r.status !== 0 && !/Traceback/.test(out) && out.trim().length > 0, out.trim().split("\n").pop()?.slice(0, 120));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Cars fetched into the cache
// ---------------------------------------------------------------------------------------------------------------------
const models = join(SD_CACHE_DIR, "cars");
const cached = existsSync(models) ? readdirSync(models).filter((c) => existsSync(join(models, c, `${c}.xml`))) : [];
if (!cached.length) console.log("SKIP  fetched cars: none in scripts/mods/.cache/speed-dreams (npm run mod -- import sd-car --fetch <car>)");
for (const c of cached) {
  const own = SdParams.read(join(models, c, `${c}.xml`));
  const catFile = join(SD_DATA_DIR, "cars", "categories", `${own.str("Car", "category")}.xml`);
  const p = existsSync(catFile) ? own.mergeOver(SdParams.read(catFile)) : own;
  const ph = sdCarPhysics(p);
  const ok = profileOf(ph.base, ph.patch);
  check(`${c}: its physics on ${ph.base} passes the game's rules`, ok.ok, ok.ok ? `${ph.rows.length} values mapped` : ok.errors.slice(0, 2).join("; "));
  const lic = findCarLicence(join(models, c), c, [], pins.cars[c]?.license);
  check(`${c}: its licence is read (${lic.source})`, lic.reading.licences.length > 0 || lic.reading.problems.length > 0, `${lic.reading.licences.join(", ")} ${lic.reading.problems.join("; ")}`);
}

if (!process.env.SD_KEEP) rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Speed Dreams car checks passed.");
