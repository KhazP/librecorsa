import * as THREE from "three";

/**
 * Live reflections for the cars: a cube camera that rides above the player's car and films the world around it (track,
 * barriers, stands, trees, sky, the other cars), prefiltered into the same kind of environment map as the sky's, and
 * set as the `envMap` of every car material. Without it the cars only reflect the sky dome, so paint never shows the
 * circuit it drives through. This is what most real-time racing games do (a dynamic cube map around the player);
 * screen-space reflections would need the WebGPU renderer.
 *
 * Cost control: one cube face is drawn per update (the shadow map is reused, the player's own car hidden), and the
 * prefilter runs once per full turn of six faces. The cube is the sky bake's size (256), so the materials' shader
 * variant does not change when the probe takes over from the sky.
 */
export type ReflectionQuality = "off" | "medium" | "high";

const CUBE_SIZE = 256;
const PROBE_FAR_M = 8000;
/**
 * Share of the filmed world's brightness the cars take from the probe. three.js scales a material's whole
 * environment light by it, the diffuse ambient as well as the reflections, so anything under 1 lights the cars
 * dimmer than the track around them: at 0.55 they went near black in shade (issues #53, #54). The green-chrome
 * look that cut was made for came from the probe filming the sun disc (now hidden while it films) and from
 * metallic paint (now a dielectric under its clearcoat), so the world is reflected at its own strength
 */
const PROBE_INTENSITY = 1;
/** Above the car's roof: what a glossy body sees of its surroundings */
const PROBE_HEIGHT_M = 1.1;

export class CarReflectionProbe {
  private readonly cubeTarget: THREE.WebGLCubeRenderTarget;
  private readonly cubeCamera: THREE.CubeCamera;
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private face = 0;
  private frame = 0;
  private quality: ReflectionQuality = "high";
  /** Car roots whose materials take the probe (the player's car, the opponents) */
  private readonly roots = new Set<THREE.Object3D>();
  private readonly assigned = new WeakSet<THREE.Material>();
  private primed = false;
  /** The visible sky's sun-disc switch: hidden while the probe films (as the sky's own environment bake does) */
  private sunDisc: { value: number } | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene
  ) {
    this.cubeTarget = new THREE.WebGLCubeRenderTarget(CUBE_SIZE, { type: THREE.HalfFloatType, generateMipmaps: false });
    // Far enough for the sky dome (a 4500 m box around the view camera): clipped, the sky filmed black and the cars
    // reflected nothing but grass and painted markings
    this.cubeCamera = new THREE.CubeCamera(0.3, PROBE_FAR_M, this.cubeTarget);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  /**
   * The sky dome whose sun disc to hide during the probe's renders: its capped HDR disc, prefiltered, spreads into a
   * bright blob that makes every car look polished chrome
   */
  setSky(sky: { material: { uniforms: Record<string, { value: unknown }> } }): void {
    this.sunDisc = (sky.material.uniforms.showSunDisc as { value: number } | undefined) ?? null;
  }

  /** The prefiltered reflection map (null until the first full turn after it was switched on, or when off) */
  get texture(): THREE.Texture | null {
    return this.quality === "off" || !this.primed ? null : (this.envTarget?.texture ?? null);
  }

  setQuality(quality: ReflectionQuality): void {
    if (quality === this.quality) return;
    const wasOff = this.quality === "off";
    this.quality = quality;
    // Off: hand the cars back to the sky's environment map
    if (quality === "off") this.applyTo(null);
    // Back on: the map from before is stale, so the next update films all six faces and hands the cars the new one
    else if (wasOff) this.primed = false;
  }

  /** A car whose materials should reflect the probe (call again after its model swaps in: new materials are caught) */
  track(root: THREE.Object3D): void {
    this.roots.add(root);
  }

  untrack(root: THREE.Object3D): void {
    this.roots.delete(root);
  }

  /**
   * Per frame, before the main render: moves the probe over `carPos`, draws the next face (with `hide` hidden) and,
   * after a full turn, re-filters the map. `envIntensity` matches the sky's environment intensity.
   */
  update(carPos: THREE.Vector3, hide: THREE.Object3D | null, envIntensity: number): void {
    if (this.quality === "off") return;
    this.frame++;
    if (this.quality === "medium" && this.frame % 2 === 1) return;
    this.cubeCamera.position.set(carPos.x, carPos.y + PROBE_HEIGHT_M, carPos.z);
    this.cubeCamera.updateMatrixWorld();

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoUpdate = r.shadowMap.autoUpdate;
    const prevXr = r.xr.enabled;
    const prevAutoClear = r.autoClear;
    const hidden = hide?.visible ?? false;
    if (hide) hide.visible = false;
    r.shadowMap.autoUpdate = false;
    r.xr.enabled = false;
    // The post-processing chain turns the renderer's autoClear off. Uncleared, each face kept the depth of what it
    // filmed a turn earlier, the sky (drawn last, at the far plane) failed the depth test there, and the old grass
    // and trees stayed smeared across the sky: the cars reflected a green sky.
    r.autoClear = true;
    const disc = this.sunDisc?.value ?? 0;
    if (this.sunDisc) this.sunDisc.value = 0;
    let filtered = false;
    try {
      if (!this.primed) {
        // The first time: every face at once (also sets the cube cameras up for this renderer's coordinate system)
        this.cubeCamera.update(r, this.scene);
        this.primed = true;
        this.face = 0;
        this.filter();
        filtered = true;
      } else {
        const cams = this.cubeCamera.children as THREE.PerspectiveCamera[];
        r.setRenderTarget(this.cubeTarget, this.face);
        // The main render updates the scene's matrices this frame anyway: the face films last frame's poses rather
        // than walking the whole scene graph a second time
        const autoMatrices = this.scene.matrixWorldAutoUpdate;
        this.scene.matrixWorldAutoUpdate = false;
        try {
          r.render(this.scene, cams[this.face]);
        } finally {
          this.scene.matrixWorldAutoUpdate = autoMatrices;
        }
        this.face = (this.face + 1) % 6;
        if (this.face === 0) {
          this.filter();
          filtered = true;
        }
      }
    } finally {
      r.setRenderTarget(prevTarget);
      r.shadowMap.autoUpdate = prevAutoUpdate;
      r.xr.enabled = prevXr;
      r.autoClear = prevAutoClear;
      if (this.sunDisc) this.sunDisc.value = disc;
      if (hide) hide.visible = hidden;
    }
    // New materials (a model that swapped in, a new opponent) are caught within half a second
    if (filtered || this.frame % 30 === 0) this.applyTo(this.envTarget?.texture ?? null, envIntensity * PROBE_INTENSITY);
  }

  private filter(): void {
    // Reuses the previous output target (the typings name it a cube target; PMREM takes and returns a 2D one)
    this.envTarget = this.pmrem.fromCubemap(
      this.cubeTarget.texture,
      this.envTarget as unknown as THREE.WebGLCubeRenderTarget | null
    );
  }

  /** Sets (or clears, with null) the reflection map on every car material; cheap when nothing changed */
  private applyTo(tex: THREE.Texture | null, intensity = 1): void {
    for (const root of this.roots) {
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const std = m as THREE.MeshStandardMaterial;
          if (!std.isMeshStandardMaterial) continue;
          if (std.envMap !== tex) {
            // Owned maps (a mirror's, a material's own) are left alone
            if (std.envMap && !this.assigned.has(std)) continue;
            std.envMap = tex;
            std.needsUpdate = true;
            if (tex) this.assigned.add(std);
            else this.assigned.delete(std);
          }
          if (tex) std.envMapIntensity = intensity;
        }
      });
    }
  }

  dispose(): void {
    this.applyTo(null);
    this.roots.clear();
    this.cubeTarget.dispose();
    this.envTarget?.dispose();
    this.pmrem.dispose();
  }
}
