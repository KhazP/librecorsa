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

### Optional circuits (`public/tracks/<id>/`)

Each model below is licensed under [Creative Commons Attribution 4.0 (CC BY 4.0)](http://creativecommons.org/licenses/by/4.0/). Changes for the simulator: uniformly rescaled where needed to match the official lap length, recentred, far-away scenery dropped, textures re-encoded to WebP (max 2048 px), geometry quantised and meshopt-compressed, and hidden physics collider / surface meshes and track data (centreline, edges, kerbs, run-off, barriers, corners) generated from the geometry. Kerb meshes with a generated red-and-white texture are added on top of the scan.

* `"Suzuka Circuit 2001 layout"` ([https://skfb.ly/pLorW](https://skfb.ly/pLorW)) by **Dave**
* `"Shanghai International Circuit 2018 layout"` ([https://skfb.ly/pLqvL](https://skfb.ly/pLqvL)) by **Dave**
* `"Mobility Resort Motegi (Twin Ring)"` ([https://skfb.ly/pMIoS](https://skfb.ly/pMIoS)) by **Kevin Love SketchFab**

---

## 3. Open Source Frameworks & Tools

* **Next.js** — Vercel (MIT)
* **Three.js** — Ricardo Cabello / Mr.doob and contributors (MIT)
* **React** — Meta Platforms, Inc. (MIT)
* **Tailwind CSS** — Tailwind Labs (MIT)
* **Framer Motion** — Motion Division (MIT)
* **Lucide Icons** — Lucide Contributors (ISC)
* **global_racetrajectory_optimization** — TUM Institute of Automotive Technology (LGPL-3.0): minimum-time racing lines that seed each circuit's F1 and GT3 lines. Used offline only, not bundled.
* **racetrack-database** — TUM Institute of Automotive Technology (LGPL-3.0): centrelines and track widths, used offline to cross-check the widths measured on the circuit scans. Not bundled.
* **Design references** (no code or assets used): the kerb as a height ramp with a ripple, as in TORCS / Speed Dreams, and the per-surface table (friction, bump, vibration, valid track) as in Assetto Corsa's `surfaces.ini`.


---

## 4. Rights holders

If you made a model, texture, sound or other asset used here and it is uncredited, credited wrongly, under the
wrong license, or simply not meant to be in LibreCorsa, open a
[rights / takedown request](https://github.com/KhazP/librecorsa/issues/new?template=takedown-request.yml).
It will be fixed or removed from the live site, usually within 7 days.
