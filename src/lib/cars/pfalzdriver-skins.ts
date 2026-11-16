import type { CarSkin } from "./car-registry";

/*
 * Pfalzdriver's cars' liveries, from the mods' own Assetto Corsa skins (scripts/cars/port_ac_car.py --skins-out writes
 * public/cars/<car>/skins/skins.json, which these lists copy). The first is the one each GLB is painted in; the
 * others list the livery files they change.
 */

/** The M1 Procar's 53 liveries: the 1979 and 1980 Procar grids, the DRM cars and a few one-offs */
export const BMW_M1_PROCAR_SKINS: readonly CarSkin[] = [
  {
    id: "1979_procar_piquet_6",
    name: "#6 Nelson Piquet · Procar ’79",
    swatch: ["#f8f8f8", "#c8c8c8"],
    files: [],
  },
  {
    id: "02_jugoplastika",
    name: "#2 Jugoplastika",
    swatch: ["#083858", "#d8d8d8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "031_jaegermeister",
    name: "#31 Jägermeister · Jan Lammers",
    swatch: ["#d85818", "#180808"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1979_drm_regazzoni",
    name: "Clay Regazzoni · DRM ’79",
    swatch: ["#d8a818", "#886818"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1979_procar_andretti_1",
    name: "#1 Mario Andretti · Procar ’79",
    swatch: ["#f8f8f8", "#c8c8c8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1979_procar_giacomelli_70",
    name: "#70 Bruno Giacomelli · Procar ’79",
    swatch: ["#f8f8f8", "#080828"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1979_procar_hagemann_41",
    name: "#41 Achim Pohl · Procar ’79",
    swatch: ["#e8e8e8", "#b8b8b8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1979_procar_hoettinger_44",
    name: "#44 Markus Höttinger · Procar ’79",
    swatch: ["#181818", "#888888"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1979_procar_jones_27",
    name: "#27 Alan Jones · Procar ’79",
    swatch: ["#f8f8f8", "#c8c8c8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1979_procar_kelleners_66",
    name: "#66 Helmut Kelleners · Procar ’79",
    swatch: ["#180808", "#d84808"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1979_procar_konrad_88",
    name: "#88 Franz Konrad · Procar ’79",
    swatch: ["#f8f8f8", "#181818"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1979_procar_lafosse_80",
    name: "#80 Jean-Louis Lafosse · Procar ’79",
    swatch: ["#e86808", "#883808"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1979_procar_pironi_3",
    name: "#3 Didier Pironi · Procar ’79",
    swatch: ["#f8f8f8", "#c8c8c8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1979_procar_stuck_77",
    name: "#77 Hans-Joachim Stuck · Procar ’79",
    swatch: ["#e8e8e8", "#989898"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1979_procar_sytner_51",
    name: "#51 Frank Sytner · Procar ’79",
    swatch: ["#f8f8f8", "#185868"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1979_procar_winkelhock_55",
    name: "#55 Manfred Winkelhock · Procar ’79",
    swatch: ["#b89858", "#181808"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1979_procar_winkelhock_81",
    name: "#81 Manfred Winkelhock · Procar ’79",
    swatch: ["#f8c818", "#a88808"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1980_drm_lenz",
    name: "#75 Helmut Lenz · DRM ’80",
    swatch: ["#980808", "#180808"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1980_procar_baldi_63",
    name: "#63 Mauro Baldi · Procar ’80",
    swatch: ["#f8f8f8", "#181818"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1980_procar_brun_61",
    name: "#61 Walter Brun · Procar ’80",
    swatch: ["#f8f8f8", "#680808"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1980_procar_cecotto_82",
    name: "#82 Johnny Cecotto · Procar ’80",
    swatch: ["#f8f8f8", "#c8c8c8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1980_procar_gabbiani_62",
    name: "#62 Beppe Gabbiani · Procar ’80",
    swatch: ["#f8f8f8", "#181818"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1980_procar_gartner_88",
    name: "#88 Jo Gartner · Procar ’80",
    swatch: ["#b80808", "#a8a8a8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1980_procar_heyer_81",
    name: "#81 Hans Heyer · Procar ’80",
    swatch: ["#182858", "#e8e8e8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1980_procar_jarier_3",
    name: "#3 Jean-Pierre Jarier · Procar ’80",
    swatch: ["#f8f8f8", "#78b808"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1980_procar_jones_27",
    name: "#27 Alan Jones · Procar ’80",
    swatch: ["#f8f8f8", "#782828"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1980_procar_lafitte_26",
    name: "#26 Jacques Laffite · Procar ’80",
    swatch: ["#f8f8f8", "#78b808"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1980_procar_lammers_99",
    name: "#99 Jan Lammers · Procar ’80",
    swatch: ["#f8f8f8", "#c8c8c8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1980_procar_manhalter_45",
    name: "#45 Sepp Manhalter · Procar ’80",
    swatch: ["#c80808", "#180808"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1980_procar_mueller_66",
    name: "#66 Siggi Müller · Procar ’80",
    swatch: ["#f8f8f8", "#989898"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1980_procar_nussbaumer_91",
    name: "#91 Walter Nussbaumer · Procar ’80",
    swatch: ["#f8f8f8", "#989898"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1980_procar_quester_77",
    name: "#77 Dieter Quester · Procar ’80",
    swatch: ["#f8f8f8", "#086848"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1980_procar_schuetz_41",
    name: "#41 Wolfgang Schütz · Procar ’80",
    swatch: ["#181818", "#585858"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1980_procar_sigalla_69",
    name: "#69 Massimo Sigala · Procar ’80",
    swatch: ["#f8f8f8", "#181818"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1980_procar_stuck_40",
    name: "#40 Hans-Joachim Stuck · Procar ’80",
    swatch: ["#f8f8f8", "#181818"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1980_procar_surer_90",
    name: "#90 Marc Surer · Procar ’80",
    swatch: ["#58b8f8", "#f8f8e8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1980_procar_winkelhock_55",
    name: "#55 Manfred Winkelhock · Procar ’80",
    swatch: ["#181818", "#888888"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1981_drm_bayern",
    name: "#87 Prince Leopold of Bavaria · DRM ’81",
    swatch: ["#0878f8", "#080818"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1981_drm_henzler",
    name: "#76 Helmut Henzler · DRM ’81",
    swatch: ["#e80818", "#180808"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1981_drm_stuck",
    name: "#2 Hans-Joachim Stuck · DRM ’81",
    swatch: ["#f8f8f8", "#080818"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1982_drm_dquester",
    name: "#4 Dieter Quester · DRM ’82",
    swatch: ["#084898", "#081838"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1982_drm_juergensen",
    name: "#7 Hans Christian Jürgensen · DRM ’82",
    swatch: ["#f8f8f8", "#181818"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "1982_drm_koenig",
    name: "#1 Kurt König · DRM ’82",
    swatch: ["#f84808", "#180808"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1982_drm_quester",
    name: "#4 Dieter Quester · DRM ’82",
    swatch: ["#e8e8e8", "#a80828"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1983_drm_grohs",
    name: "#3 Harald Grohs · DRM ’83",
    swatch: ["#989898", "#f8f8f8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1983_drm_lenz",
    name: "#40 Helmut Lenz · DRM ’83",
    swatch: ["#080808", "#c8c8c8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1983_drm_quester",
    name: "#12 Dieter Quester · DRM ’83",
    swatch: ["#f8e8a8", "#c8b888"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1984_drm_goering",
    name: "#23 Rolf Göring · DRM ’84",
    swatch: ["#f8f8f8", "#181818"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "1984_drm_manthey",
    name: "#111 Olaf Manthey · DRM ’84",
    swatch: ["#080818", "#f8f8f8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
    ],
  },
  {
    id: "76_warhol",
    name: "#76 Andy Warhol Art Car · Le Mans ’79",
    swatch: ["#a80808", "#280808"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "80_martini",
    name: "#80 Martini Racing",
    swatch: ["#e8e8e8", "#181818"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "999_sc",
    name: "Procar Safety Car",
    swatch: ["#181818", "#787878"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "rim.jpg",
      "tyre_d_2.jpg",
    ],
  },
  {
    id: "vln_ah_racing_bmw_m1",
    name: "#606 AH Racing · VLN",
    swatch: ["#f80808", "#f8f8f8"],
    files: [
      "bmw_m1_paint_bodywork2_bodywork.jpg",
      "bmw_m1_sw_vehicles_basic_vehiclebasic.jpg",
      "glass_up.png",
      "tyre_d_2.jpg",
    ],
  },
];

/** The Scirocco's 38 factory colours */
export const VW_SCIROCCO_SKINS: readonly CarSkin[] = [
  {
    id: "mars_red",
    name: "Mars Red",
    swatch: ["#982838", "#581818"],
    files: [],
  },
  {
    id: "alpine_white",
    name: "Alpine White",
    swatch: ["#e8e8d8", "#989888"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "ext_plastic.jpg",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "black_04i",
    name: "Black 04i",
    swatch: ["#101010", "#101010"],
    files: [
      "carpaint.jpg",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "brasil_brown_metallic",
    name: "Brasil Brown Metallic",
    swatch: ["#683828", "#180808"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "colibri_green_metallic",
    name: "Colibri Green Metallic",
    swatch: ["#283838", "#080808"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "diamond_silver_metallic",
    name: "Diamond Silver Metallic",
    swatch: ["#a8a8b8", "#686878"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "florida_blue",
    name: "Florida Blue",
    swatch: ["#7898b8", "#486878"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "indiana_red_metallic",
    name: "Indiana Red Metallic",
    swatch: ["#783838", "#c85858"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "l90e",
    name: "Alpin White",
    swatch: ["#c8c8b8", "#888878"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "l97a",
    name: "Diamantsilber Metallic",
    swatch: ["#686868", "#989898"],
    files: [
      "carpaint.jpg",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "la3a",
    name: "Marsrot",
    swatch: ["#b81818", "#180808"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "la5u",
    name: "Royalblau Metallic",
    swatch: ["#081828", "#081828"],
    files: [
      "carpaint.jpg",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "la5y",
    name: "Heliosblau Metallic",
    swatch: ["#285868", "#4888a8"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "la7u",
    name: "Perlgrau Metallic",
    swatch: ["#888888", "#585858"],
    files: [
      "carpaint.jpg",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "la8y",
    name: "Bronzegrau Metallic",
    swatch: ["#484838", "#786868"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "la9v",
    name: "Brilliantschwarz Metallic",
    swatch: ["#101010", "#101010"],
    files: [
      "carpaint.jpg",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "lb7v",
    name: "Anthrazit Metallic",
    swatch: ["#282828", "#282828"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "lc6v",
    name: "Grün Perleffect",
    swatch: ["#184828", "#080808"],
    files: [
      "carpaint.jpg",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "ld7v",
    name: "Silbergrau Metallic",
    swatch: ["#788888", "#585858"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "lk1a",
    name: "Lagosgelb",
    swatch: ["#e8a808", "#986808"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "lk3a",
    name: "Paprikarot",
    swatch: ["#581818", "#080808"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "lk4y",
    name: "Violett Metallic",
    swatch: ["#282848", "#080818"],
    files: [
      "carpaint.jpg",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "lk5t",
    name: "Inkablau Metallic",
    swatch: ["#182838", "#182838"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "lk5v",
    name: "Cirrus Metallic",
    swatch: ["#485858", "#181818"],
    files: [
      "carpaint.jpg",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "lk5y",
    name: "Cosmos Metallic",
    swatch: ["#586868", "#88a8a8"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "lk6t",
    name: "Madison Türkis Metallic",
    swatch: ["#486868", "#78a8a8"],
    files: [
      "carpaint.jpg",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "lk7v",
    name: "Felsgrau Metallic",
    swatch: ["#586868", "#181818"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "lk8y",
    name: "Havanabraun",
    swatch: ["#483828", "#181808"],
    files: [
      "carpaint.jpg",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "lp7y",
    name: "Flashsilber Metallic",
    swatch: ["#b8c8c8", "#687878"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "ly3d",
    name: "Tornadorot",
    swatch: ["#781808", "#180808"],
    files: [
      "carpaint.jpg",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "ly5v",
    name: "Saphir Metallic",
    swatch: ["#182838", "#182838"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "lemon_yellow",
    name: "Lemon Yellow",
    swatch: ["#989818", "#d8d828"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "m8m8",
    name: "Irishgrün",
    swatch: ["#182818", "#182818"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "nepal_orange",
    name: "Nepal Orange",
    swatch: ["#c85828", "#883818"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "pearl_metallic",
    name: "Pearl Metallic",
    swatch: ["#987868", "#584838"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "platinum_metallic",
    name: "Platinum Metallic",
    swatch: ["#c8c8c8", "#787878"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "river_blue_metallic",
    name: "River Blue Metallic",
    swatch: ["#486868", "#78a8a8"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
  {
    id: "viper_green",
    name: "Viper Green",
    swatch: ["#688848", "#384828"],
    files: [
      "carpaint.jpg",
      "ext_glass.png",
      "plate_d.jpg",
      "rim_chrome.jpg",
    ],
  },
];
