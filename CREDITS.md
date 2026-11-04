# LibreCorsa: credits & licensing

LibreCorsa is an independent, non-commercial, open-source web simulator built with Next.js, React, Three.js, and the Web Audio API.

---

## 1. Licensing

* **Source Code (`src/`)**: Licensed under the [MIT License](LICENSE).
* **3D Models & Audio Assets (`public/`)**: Provided strictly for non-commercial, personal, and educational use.
* **Affiliation Disclaimer**: This project is unofficial and is not associated in any way with the Formula 1 companies, the FIA, Mercedes-Benz, or any motorsport team.

---

## 2. 3D Models & Creative Commons Attribution

* **F1 2026 3D Car Model**: Formula car model ([https://skfb.ly/pKNCK](https://skfb.ly/pKNCK)) by **DeX** is licensed under [Creative Commons Attribution 4.0 (CC BY 4.0)](http://creativecommons.org/licenses/by/4.0/).
* **GT3 3D Car Model**: `"2020 Mercedes-Benz AMG GT3"` ([https://skfb.ly/pOTPL](https://skfb.ly/pOTPL)) by **Ddiaz Design** is licensed under [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (CC BY-NC-SA 4.0)](http://creativecommons.org/licenses/by-nc-sa/4.0/).

### Ported F1 car models (`public/cars/<id>/model/`)

Each model below is by **Dave Love SketchFab** ([https://sketchfab.com/Tyler_Dave](https://sketchfab.com/Tyler_Dave)) and is licensed under [Creative Commons Attribution 4.0 (CC BY 4.0)](http://creativecommons.org/licenses/by/4.0/). Changes for the simulator (`scripts/cars/port_sketchfab_f1.py`): node transforms baked to metre scale (`+Z` forward, `+X` left, floor `y = 0`), wheel rims and tyres split into per-corner `WHEEL_RF`/`LF`/`RR`/`LR` pivot hierarchies, steering wheel separated into a `STEER` pivot, zero-scale normal maps removed, and textures re-encoded to JPEG/PNG (max 2048 px).

* `"2026 Ferrari SF-26"` ([https://sketchfab.com/3d-models/2026-ferrari-sf-26-e5ca6cecdc42449283f4bed27360f2a7](https://sketchfab.com/3d-models/2026-ferrari-sf-26-e5ca6cecdc42449283f4bed27360f2a7)) by **Dave Love SketchFab** (`sf26`)
* `"2026 Mercedes W17"` ([https://sketchfab.com/3d-models/2026-mercedes-w17-b806f1e70aa343219e7158169549b97b](https://sketchfab.com/3d-models/2026-mercedes-w17-b806f1e70aa343219e7158169549b97b)) by **Dave Love SketchFab** (`w17`)
* `"2026 Redbull RB22"` ([https://sketchfab.com/3d-models/2026-redbull-rb22-0a3d24a58e0549d591a5a48c22eec383](https://sketchfab.com/3d-models/2026-redbull-rb22-0a3d24a58e0549d591a5a48c22eec383)) by **Dave Love SketchFab** (`rb22`)
* `"2018 Ferrari SF71H"` ([https://sketchfab.com/3d-models/2018-ferrari-sf71h-e54b896bd21f478f8309eecf3726700e](https://sketchfab.com/3d-models/2018-ferrari-sf71h-e54b896bd21f478f8309eecf3726700e)) by **Dave Love SketchFab** (`sf71h`)
* `"2012 Red Bull RB8"` ([https://sketchfab.com/3d-models/2012-red-bull-rb8-b74446dcd93a49879546d756e3093b3f](https://sketchfab.com/3d-models/2012-red-bull-rb8-b74446dcd93a49879546d756e3093b3f)) by **Dave Love SketchFab** (`rb8`)
* `"2005 Renault R25"` ([https://sketchfab.com/3d-models/2005-renault-r25-0d58fe125f5b41a2b8482576723120c4](https://sketchfab.com/3d-models/2005-renault-r25-0d58fe125f5b41a2b8482576723120c4)) by **Dave Love SketchFab** (`r25`)
* `"2004 Ferrari F2004"` ([https://sketchfab.com/3d-models/2004-ferrari-f2004-bedade52e6f4415e90e656817c5701f8](https://sketchfab.com/3d-models/2004-ferrari-f2004-bedade52e6f4415e90e656817c5701f8)) by **Dave Love SketchFab** (`f2004`)

### Optional circuits (`public/tracks/<id>/`)

Each model below is licensed under [Creative Commons Attribution 4.0 (CC BY 4.0)](http://creativecommons.org/licenses/by/4.0/). Changes for the simulator: uniformly rescaled where needed to match the official lap length, recentred, far-away scenery dropped, textures re-encoded to WebP (max 2048 px), geometry quantised and meshopt-compressed, and hidden physics collider / surface meshes and track data (centreline, edges, kerbs, run-off, barriers, corners) generated from the geometry. Kerb meshes with a generated red-and-white texture are added on top of the scan.

* `"Suzuka Circuit 2001 layout"` ([https://skfb.ly/pLorW](https://skfb.ly/pLorW)) by **Dave**
* `"Shanghai International Circuit 2018 layout"` ([https://skfb.ly/pLqvL](https://skfb.ly/pLqvL)) by **Dave**
* `"Mobility Resort Motegi (Twin Ring)"` ([https://skfb.ly/pMIoS](https://skfb.ly/pMIoS)) by **Kevin Love SketchFab**
* `"Sepang International Circuit 2025 layout"` ([https://sketchfab.com/3d-models/sepang-international-circuit-2025-layout-590bf243480e43f18e588a3908daa4df](https://sketchfab.com/3d-models/sepang-international-circuit-2025-layout-590bf243480e43f18e588a3908daa4df)) by **Dave Love SketchFab**
* `"Daytona International Speedway 2007 layout"` ([https://sketchfab.com/3d-models/daytona-international-speedway-2007-layout-070db794e8ee46d399ee882f67e9a18d](https://sketchfab.com/3d-models/daytona-international-speedway-2007-layout-070db794e8ee46d399ee882f67e9a18d)) by **Dave Love SketchFab**, used for both the oval (`daytona_oval`) and the road course (`daytona_road`)
* `"Marina Bay Street Circuit"` ([https://sketchfab.com/3d-models/marina-bay-street-circuit-e665d831c57546609d4c15287a6107b7](https://sketchfab.com/3d-models/marina-bay-street-circuit-e665d831c57546609d4c15287a6107b7)) by **Dave Love SketchFab**
* `"Autodromo Nazionale Monza Circuit 2020 layout"` ([https://sketchfab.com/3d-models/autodromo-nazionale-monza-circuit-2020-layout-25ed955115094de382935aa6d1a1e9c6](https://sketchfab.com/3d-models/autodromo-nazionale-monza-circuit-2020-layout-25ed955115094de382935aa6d1a1e9c6)) by **Dave Love SketchFab**

### Rwanda trackside trees (`public/tracks/rwanda/scenery/`)

Each model below is licensed under [Creative Commons Attribution 4.0 (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Changes for the simulator (`scripts/rwanda-scenery.mjs`): transforms baked in, normal maps dropped, leaves toned darker and their normals turned towards the crown's shape, colour textures re-encoded to 1024 px WebP, and the models instanced at the circuit's tree and bush spots.

* `"Acacia tree"` ([https://sketchfab.com/3d-models/acacia-tree-bb14c2bb679b4d0bb1c578a27e2ddabf](https://sketchfab.com/3d-models/acacia-tree-bb14c2bb679b4d0bb1c578a27e2ddabf)) by **evolveduk**; the bark is also simplified to 5 % of its triangles
* `"Cliff Shrub For Terrain"` ([https://sketchfab.com/3d-models/cliff-shrub-for-terrain-7a0f2bf2982c4ff8bacc67856fdbfae2](https://sketchfab.com/3d-models/cliff-shrub-for-terrain-7a0f2bf2982c4ff8bacc67856fdbfae2)) by **Natural_Disbuster (lemedesign)**

### Rwanda helicopter (`public/tracks/rwanda/scenery/props.glb`)

Licensed under [Creative Commons Attribution 4.0 (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Changes for the simulator (`scripts/rwanda-props.mjs`): the helicopter only (the model's figure and its animation are left out), simplified to about 3,900 triangles, textures re-encoded to 512 px WebP, parked where the circuit's helicopter stood.

* `"Cedric-EC135- Waving-190 Rotor"` ([https://sketchfab.com/3d-models/cedric-ec135-waving-190-rotor-09fbae3edc0a44bea7dbb7ed7644df6b](https://sketchfab.com/3d-models/cedric-ec135-waving-190-rotor-09fbae3edc0a44bea7dbb7ed7644df6b)) by **PatrickBiani**

### Rwanda grandstands, open stands and media centre (`public/tracks/rwanda/scenery/stands.glb`)

Made for this project: `scripts/rwanda-stands.mjs` generates them to the footprint, height and facing of the stands in the circuit, which came from a third-party track pack and are no longer shown. Their seat pattern is drawn by the script in the circuit's blue / yellow / green bands; the "Rwanda" roof lettering is the project's own texture, copied unchanged from the circuit.

### Rwanda barrier, fence, pit wall and gantry textures (`public/tracks/rwanda/scenery/textures/`)

Made for this project: `scripts/rwanda-textures.mjs` draws them to the size and coarse layout of the track-pack images they replace on the circuit's own Armco, debris fence, pit wall and start gantry (the average colour of each row, the fence's rails and mesh coverage, the wall's panel joints); every detail is drawn by the script. They are swapped in at load, so the circuit file is unchanged.

### Rwanda trackside props (`public/tracks/rwanda/scenery/props.glb`)

Made for this project: `scripts/rwanda-props.mjs` generates the jumbotrons, start lights, pit exit light, radio masts, paddock tents and TV camera platforms to the footprint and height of the ones in the circuit, which came from a third-party track pack and are no longer shown. The jumbotrons' circuit-map screen is the project's own texture, copied unchanged from the circuit.

---

## 3. Open Source Frameworks & Tools

* **Next.js** — Vercel (MIT)
* **Three.js** — Ricardo Cabello / Mr.doob and contributors (MIT)
* **React** — Meta Platforms, Inc. (MIT)
* **Tailwind CSS** — Tailwind Labs (MIT)
* **Framer Motion** — Motion Division (MIT)
* **Lucide Icons** — Lucide Contributors (ISC)
* **Fonts** (`src/app/fonts/`, Latin subsets as served by Google Fonts), each under the [SIL Open Font License 1.1](https://openfontlicense.org), licence text alongside:
  * **Titillium Web** — Accademia di Belle Arti di Urbino
  * **Orbitron** — The Orbitron Project Authors (The League of Moveable Type); Reserved Font Name "Orbitron"
  * **JetBrains Mono** — The JetBrains Mono Project Authors
* **global_racetrajectory_optimization** — TUM Institute of Automotive Technology (LGPL-3.0): minimum-time racing lines that seed each circuit's F1 and GT3 lines. Used offline only, not bundled.
* **racetrack-database** — TUM Institute of Automotive Technology (LGPL-3.0): centrelines and track widths, used offline to cross-check the widths measured on the circuit scans. Not bundled.
* **Design references** (no code or assets used): the kerb as a height ramp with a ripple, as in TORCS / Speed Dreams, and the per-surface table (friction, bump, vibration, valid track) as in Assetto Corsa's `surfaces.ini`.


---

## 4. Rights holders

If you made a model, texture, sound or other asset used here and it is uncredited, credited wrongly, under the
wrong license, or simply not meant to be in LibreCorsa, open a
[rights / takedown request](https://github.com/KhazP/librecorsa/issues/new?template=takedown-request.yml).
It will be fixed or removed from the live site, usually within 7 days.
