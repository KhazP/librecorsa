import type { CarSkin } from "./car-registry";
import { f12007Sound } from "@/lib/sim/f1-2007/f12007-sounds";

/*
 * F1 2007's liveries, one per driver, from Cimmerian Iter's Assetto Corsa skins (scripts/cars/port_ac_car.py
 * --skins-out writes each team's skins.json, which this list copies). Each team's car is a body of its own: a livery
 * names the team's GLB (`modelUrl`) and engine sound (`sound`), and picking it puts that car on the entry's one physics. The Ferrari's Räikkönen
 * is the paint the car's own GLB is in; every other team's first driver is the paint of that team's GLB
 * (`useModelPaint`), and the others list the livery files they change. The Ferrari's early-season liveries wear the
 * mod's early body (its skins' model swap, the GLB's `early` part variant): Räikkönen's in the paint that body comes
 * in, Massa's in his own files for it.
 */

/** A team's car (`public/cars/f1-2007/model/f1-2007-<team>.glb`) */
export const f12007BodyUrl = (team: string): string => `/cars/f1-2007/model/f1-2007-${team}.glb`;

/** The 2007 grid's 26 liveries: the eleven teams' drivers in race-number order, the champions first */
export const F1_2007_SKINS: readonly CarSkin[] = [
  // Ferrari F2007
  {
    id: "ferrari-raikkonen",
    name: "#6 Kimi Räikkönen · Ferrari",
    swatch: ["#c8102e", "#f2f2f2"],
    sound: f12007Sound("ferrari"),
    files: [],
  },
  {
    id: "ferrari-massa",
    name: "#5 Felipe Massa · Ferrari",
    swatch: ["#c8102e", "#f2f2f2"],
    sound: f12007Sound("ferrari"),
    files: ["t_cam1.jpg", "wccarbody.jpg", "wcextra0.jpg", "wcextra1.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
  {
    id: "ferrari-massa-early",
    name: "#5 Felipe Massa · Ferrari, early season",
    swatch: ["#c8102e", "#f2f2f2"],
    sound: f12007Sound("ferrari"),
    variant: "early",
    files: ["t_cam1.jpg", "wcextra5.jpg", "wcextra6.jpg", "wcextra7.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
  {
    id: "ferrari-raikkonen-early",
    name: "#6 Kimi Räikkönen · Ferrari, early season",
    swatch: ["#c8102e", "#f2f2f2"],
    sound: f12007Sound("ferrari"),
    variant: "early",
    files: [],
  },
  // McLaren MP4-22
  {
    id: "mclaren-alonso",
    name: "#1 Fernando Alonso · McLaren",
    swatch: ["#b8bcc2", "#141414", "#d8232a"],
    modelUrl: f12007BodyUrl("mclaren"),
    sound: f12007Sound("mclaren"),
    useModelPaint: true,
    files: [],
  },
  {
    id: "mclaren-hamilton",
    name: "#2 Lewis Hamilton · McLaren",
    swatch: ["#b8bcc2", "#141414", "#d8232a"],
    modelUrl: f12007BodyUrl("mclaren"),
    sound: f12007Sound("mclaren"),
    files: ["t_cam1.jpg", "wccarbody.jpg", "wcextra0.jpg", "wcextra1.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
  // Renault R27
  {
    id: "renault-fisichella",
    name: "#3 Giancarlo Fisichella · Renault",
    swatch: ["#f27f1b", "#1c3f94"],
    modelUrl: f12007BodyUrl("renault"),
    sound: f12007Sound("renault"),
    useModelPaint: true,
    files: [],
  },
  {
    id: "renault-kovalainen",
    name: "#4 Heikki Kovalainen · Renault",
    swatch: ["#f27f1b", "#1c3f94"],
    modelUrl: f12007BodyUrl("renault"),
    sound: f12007Sound("renault"),
    files: ["t_cam1.jpg", "wccarbody.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
  // Honda RA107
  {
    id: "honda-button",
    name: "#7 Jenson Button · Honda",
    swatch: ["#1f4e8c", "#4e8f3a"],
    modelUrl: f12007BodyUrl("honda"),
    sound: f12007Sound("honda"),
    useModelPaint: true,
    files: [],
  },
  {
    id: "honda-barrichello",
    name: "#8 Rubens Barrichello · Honda",
    swatch: ["#1f4e8c", "#4e8f3a"],
    modelUrl: f12007BodyUrl("honda"),
    sound: f12007Sound("honda"),
    files: ["honda_07extra4.jpg", "wccarbody.jpg", "wcextra0.jpg", "wcextra1.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
  // BMW Sauber F1.07
  {
    id: "bmw-sauber-heidfeld",
    name: "#9 Nick Heidfeld · BMW Sauber",
    swatch: ["#f2f2f2", "#1e4fa0"],
    modelUrl: f12007BodyUrl("bmw-sauber"),
    sound: f12007Sound("bmw-sauber"),
    useModelPaint: true,
    files: [],
  },
  {
    id: "bmw-sauber-kubica",
    name: "#10 Robert Kubica · BMW Sauber",
    swatch: ["#f2f2f2", "#1e4fa0"],
    modelUrl: f12007BodyUrl("bmw-sauber"),
    sound: f12007Sound("bmw-sauber"),
    files: ["t_cam1.jpg", "wccarbody.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
  {
    id: "bmw-sauber-vettel",
    name: "#10 Sebastian Vettel · BMW Sauber, United States GP",
    swatch: ["#f2f2f2", "#1e4fa0"],
    modelUrl: f12007BodyUrl("bmw-sauber"),
    sound: f12007Sound("bmw-sauber"),
    files: ["t_cam1.jpg", "wccarbody.jpg", "wcextra0.jpg", "wcextra1.jpg", "wcwing.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
  // Toyota TF107
  {
    id: "toyota-rschumacher",
    name: "#11 Ralf Schumacher · Toyota",
    swatch: ["#f2f2f2", "#d0021b"],
    modelUrl: f12007BodyUrl("toyota"),
    sound: f12007Sound("toyota"),
    files: ["t_cam1.jpg", "wccarbody.jpg", "wcextra0.jpg", "wcextra1.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
  {
    id: "toyota-trulli",
    name: "#12 Jarno Trulli · Toyota",
    swatch: ["#f2f2f2", "#d0021b"],
    modelUrl: f12007BodyUrl("toyota"),
    sound: f12007Sound("toyota"),
    useModelPaint: true,
    files: [],
  },
  // Red Bull RB3
  {
    id: "red-bull-coulthard",
    name: "#14 David Coulthard · Red Bull",
    swatch: ["#1c2a55", "#d8232a", "#f5c400"],
    modelUrl: f12007BodyUrl("red-bull"),
    sound: f12007Sound("red-bull"),
    useModelPaint: true,
    files: [],
  },
  {
    id: "red-bull-webber",
    name: "#15 Mark Webber · Red Bull",
    swatch: ["#1c2a55", "#d8232a", "#f5c400"],
    modelUrl: f12007BodyUrl("red-bull"),
    sound: f12007Sound("red-bull"),
    files: ["red_bull_14extra4.jpg", "wccarbody.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
  // Williams FW29
  {
    id: "williams-rosberg",
    name: "#16 Nico Rosberg · Williams",
    swatch: ["#1d2a5a", "#f2f2f2"],
    modelUrl: f12007BodyUrl("williams"),
    sound: f12007Sound("williams"),
    useModelPaint: true,
    files: [],
  },
  {
    id: "williams-wurz",
    name: "#17 Alexander Wurz · Williams",
    swatch: ["#1d2a5a", "#f2f2f2"],
    modelUrl: f12007BodyUrl("williams"),
    sound: f12007Sound("williams"),
    files: ["t_cam1.jpg", "wccarbody.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
  // Toro Rosso STR2
  {
    id: "toro-rosso-liuzzi",
    name: "#18 Vitantonio Liuzzi · Toro Rosso",
    swatch: ["#1c2552", "#c8102e"],
    modelUrl: f12007BodyUrl("toro-rosso"),
    sound: f12007Sound("toro-rosso"),
    useModelPaint: true,
    files: [],
  },
  {
    id: "toro-rosso-speed",
    name: "#19 Scott Speed · Toro Rosso",
    swatch: ["#1c2552", "#c8102e"],
    modelUrl: f12007BodyUrl("toro-rosso"),
    sound: f12007Sound("toro-rosso"),
    files: ["t_cam1.jpg", "wccarbody.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
  {
    id: "toro-rosso-vettel",
    name: "#19 Sebastian Vettel · Toro Rosso",
    swatch: ["#1c2552", "#c8102e"],
    modelUrl: f12007BodyUrl("toro-rosso"),
    sound: f12007Sound("toro-rosso"),
    files: ["t_cam1.jpg", "wccarbody.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
  // Spyker F8-VII
  {
    id: "spyker-sutil",
    name: "#20 Adrian Sutil · Spyker",
    swatch: ["#f07a1a", "#b8bcc2"],
    modelUrl: f12007BodyUrl("spyker"),
    sound: f12007Sound("spyker"),
    useModelPaint: true,
    files: [],
  },
  {
    id: "spyker-albers",
    name: "#21 Christijan Albers · Spyker",
    swatch: ["#f07a1a", "#b8bcc2"],
    modelUrl: f12007BodyUrl("spyker"),
    sound: f12007Sound("spyker"),
    files: ["t_cam1.jpg", "wccarbody.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
  // Super Aguri SA07
  {
    id: "super-aguri-sato",
    name: "#22 Takuma Sato · Super Aguri",
    swatch: ["#f2f2f2", "#d0021b"],
    modelUrl: f12007BodyUrl("super-aguri"),
    sound: f12007Sound("super-aguri"),
    useModelPaint: true,
    files: [],
  },
  {
    id: "super-aguri-davidson",
    name: "#23 Anthony Davidson · Super Aguri",
    swatch: ["#f2f2f2", "#d0021b"],
    modelUrl: f12007BodyUrl("super-aguri"),
    sound: f12007Sound("super-aguri"),
    files: ["t_cam1.jpg", "wccarbody.jpg", "driver_helmet.jpg", "driver_helmet2.jpg"],
  },
];
