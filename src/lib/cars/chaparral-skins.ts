import type { CarSkin } from "./car-registry";

/*
 * The Chaparral 2Ds' liveries, from the mod's own Assetto Corsa skins (scripts/cars/port_ac_car.py --skins-out writes
 * public/cars/<car>/skins/skins.json, which these lists copy). The first is the one each GLB is painted in; the others
 * list the livery files they change. The Sebring and Daytona cars of 1966 wear the Sebring roof scoop and fixed lamp
 * covers, with no roof mirror or number plate, and the 1967 Sebring car its big spoiler and canards (`variant`).
 */

/** The 1966 car's six: the Nürburgring winner, Spa, Le Mans, both Sebring cars and Daytona */
export const CHAPARRAL_2D_SKINS: readonly CarSkin[] = [
  {
    id: "7_nurb_1000_1966",
    name: "#7 Phil Hill / Jo Bonnier · Nürburgring 1000 km ’66",
    swatch: ["#f8f8e8", "#989898"],
    files: [],
  },
  {
    id: "2_spa_1966",
    name: "#2 Jim Hall / Phil Hill · Spa 1000 km ’66",
    swatch: ["#f8f8e8", "#989898"],
    files: ["ext_main_body.jpg"],
  },
  {
    id: "9_le_mans_1966",
    name: "#9 Phil Hill / Jo Bonnier · Le Mans ’66",
    swatch: ["#f8f8e8", "#989898"],
    files: ["ext_licence_plate.jpg", "ext_main_body.jpg"],
  },
  {
    id: "11_sebring_1966",
    name: "#11 Hap Sharp / Jim Hall · Sebring 12 Hours ’66",
    swatch: ["#f8f8e8", "#181818"],
    files: ["ext_licence_plate.jpg", "ext_main_body.jpg", "int_labels_gauges.png"],
    variant: "sebring",
  },
  {
    id: "12_sebring_1966",
    name: "#12 Jo Bonnier / Phil Hill · Sebring 12 Hours ’66",
    swatch: ["#f8f8e8", "#989898"],
    files: ["ext_licence_plate.jpg", "ext_main_body.jpg"],
    variant: "sebring",
  },
  {
    id: "65_daytona_1966",
    name: "#65 Jo Bonnier / Phil Hill · Daytona 24 Hours ’66",
    swatch: ["#f8f8e8", "#989898"],
    files: ["ext_licence_plate.jpg", "ext_main_body.jpg"],
    variant: "sebring",
  },
];

/** The 1967 car's two: Daytona's raised spoiler, and Sebring's big spoiler with canards */
export const CHAPARRAL_2D_67_SKINS: readonly CarSkin[] = [
  {
    id: "14_daytona_1967",
    name: "#14 Bob Johnson / Bruce Jennings · Daytona 24 Hours ’67",
    swatch: ["#f8f8e8", "#989898"],
    files: [],
  },
  {
    id: "5_sebring_1967",
    name: "#5 Bob Johnson / Bruce Jennings · Sebring 12 Hours ’67",
    swatch: ["#f8f8e8", "#181818"],
    files: ["ext_main_body.jpg"],
    variant: "sebring",
  },
];
