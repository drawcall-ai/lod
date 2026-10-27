import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import { Casters } from "./casters.ts";
import { SunShadow } from "./shading.ts";

/** A cascade's map: its size in texels, and every how many frames (at which phase) it is redrawn. */
interface Setting {
  size: number;
  every: number;
  phase: number;
}

/**
 * Finest first. The near map follows the camera every frame; the others take turns, one
 * per frame, so no frame draws more than two maps (the farther ones cover hundreds of
 * metres to kilometres, where a frame's lag does not show). The farthest map's texels are
 * metres wide whatever its size, and a smaller map is cheaper to look up.
 */
const SETTINGS: Setting[] = [
  { size: 2048, every: 1, phase: 0 },
  { size: 2048, every: 2, phase: 0 },
  { size: 1024, every: 2, phase: 1 },
];
/**
 * How far beyond the nearest possible surface the slices reach (m). Each map covers the
 * sphere around its slice, which takes the last one out to about twice as far.
 */
const REACH = 1500;
/** The first cascade ends this many times the focus distance away, so what the view looks at gets the finest map. */
const FOCUS = 2.5;
/** A caster draws into a cascade only if it is at least this many of its texels across. */
const MIN_TEXELS = 4;
/** Room toward the sun for casters above a cascade (the tallest things stand ~40 m; the sun is 27° up), and below it for the ground. */
const ABOVE = 120;
const BELOW = 60;

/**
 * The sun as cascaded shadow maps: one DirectionalLight lights the scene, its shadow
 * looked up in the maps of the cascades (see shading.ts, which also blends them). The
 * view from the nearest possible surface out to `REACH` beyond it is cut into slices,
 * the first ending a little beyond what the camera looks at and the rest spaced
 * geometrically; each cascade's map covers the sphere around its slice, so turning the
 * camera does not change it, with the radius rounded up to steps of 2^(1/8) and the
 * centre snapped to whole texels, so shadows neither crawl nor shimmer while the camera
 * moves. A far cascade not due this frame keeps its map while that still covers its
 * slice. Each map draws only the casters at least `MIN_TEXELS` of its texels across.
 */
export class Sun {
  /** The light that lights the scene: colour and intensity go here. */
  readonly light = new THREE.DirectionalLight("#ffffff", 0);
  readonly cascades: Cascade[];
  private casters: Casters | null = null;
  /** The sun's frame (looking along its light, y up) and its inverse. */
  private readonly fromSun = new THREE.Matrix4();
  private readonly toSun = new THREE.Matrix4();
  private frame = 0;

  constructor(direction: THREE.Vector3) {
    this.fromSun.lookAt(new THREE.Vector3(), direction.clone().negate(), new THREE.Vector3(0, 1, 0));
    this.toSun.copy(this.fromSun).invert();
    this.cascades = SETTINGS.map((setting) => new Cascade(setting, direction, (size) => this.casters?.castFrom(size) ?? 0));
    this.light.position.copy(direction);
    this.light.castShadow = true;
    this.light.shadow.shadowNode = new SunShadow(this.light, this.cascades, direction);
  }

  /** The light with its target, to add to the scene. */
  get objects(): THREE.Object3D[] {
    return [this.light, this.light.target];
  }

  /** Sorts the casters under `root` by size; call once the scene is built. */
  castBy(root: THREE.Object3D): void {
    this.casters = new Casters(root);
  }

  /**
   * Fits the cascades to `camera`'s view looking at something `focus` metres away, no
   * surface being nearer than `clear` metres.
   */
  update(camera: THREE.PerspectiveCamera, focus: number, clear: number): void {
    this.frame++;
    const start = Math.max(camera.near, clear);
    const end = Math.min(start + REACH, camera.far);
    const count = this.cascades.length;
    const step = (end / start) ** (1 / count);
    // the first split near the focus, but within the first two geometric steps
    const first = THREE.MathUtils.clamp(focus * FOCUS, start * step, start * step * step);
    const rest = (end / first) ** (1 / (count - 1));
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const slope = tan * tan * (1 + camera.aspect * camera.aspect);
    let near = start;
    this.cascades.forEach((cascade, i) => {
      const far = i === 0 ? first : first * rest ** i;
      cascade.update(camera, near, far, slope, this.frame, this.fromSun, this.toSun);
      near = far;
    });
  }
}

const centre = new THREE.Vector3();

/**
 * One map: drawn from a light of its own, outside the scene, which lights nothing; its
 * matrices are kept up to date here.
 */
export class Cascade {
  readonly light = new THREE.DirectionalLight("#ffffff", 0);
  /** How far shadows are looked up off a surface, toward the sun (m): see shading.ts. */
  readonly offset = uniform(0);
  /** Texel size (m) and casters drawn when its map was last drawn. */
  readonly drawn = { texel: 0, casters: 0 };
  /** Where its map is, as last drawn: centre and radius in world space. */
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 0);

  constructor(
    private readonly setting: Setting,
    private readonly direction: THREE.Vector3,
    cast: (size: number) => number,
  ) {
    // three calls this just before it draws this map: the moment to choose its casters
    // (it exports no DirectionalLightShadow to subclass)
    const shadow = this.light.shadow;
    const updateMatrices = shadow.updateMatrices.bind(shadow);
    shadow.updateMatrices = (light) => {
      updateMatrices(light);
      this.drawn.casters = cast(MIN_TEXELS * this.drawn.texel);
    };
    this.light.castShadow = true;
    shadow.mapSize.set(setting.size, setting.size);
    shadow.autoUpdate = false;
  }

  /** Fits the map to the view between `near` and `far`; redraws it if due or if it no longer covers that. */
  update(camera: THREE.PerspectiveCamera, near: number, far: number, slope: number, frame: number, fromSun: THREE.Matrix4, toSun: THREE.Matrix4): void {
    // the smallest sphere around the frustum slice: its centre on the view axis, equally
    // far from the near and far corners, or at the far plane's centre
    const z = Math.min(((near + far) * (1 + slope)) / 2, far);
    const spread = Math.sqrt(slope);
    const reach = Math.max(Math.hypot(z - near, near * spread), Math.hypot(far - z, far * spread));
    const radius = 2 ** (Math.ceil(Math.log2(reach) * 8) / 8);
    const texel = (2 * radius) / this.setting.size;
    // the centre snapped to the texel grid in the sun's frame
    centre.set(0, 0, -z).applyMatrix4(camera.matrixWorld).applyMatrix4(toSun);
    centre.x = Math.round(centre.x / texel) * texel;
    centre.y = Math.round(centre.y / texel) * texel;
    centre.applyMatrix4(fromSun);

    const due = frame % this.setting.every === this.setting.phase;
    const holds = this.sphere.radius >= radius && this.sphere.center.distanceTo(centre) + radius <= this.sphere.radius * 1.0001;
    if (!due && holds) return;
    this.sphere.set(centre, radius);
    this.drawn.texel = texel;

    this.light.target.position.copy(centre);
    this.light.position.copy(centre).addScaledVector(this.direction, radius + ABOVE);
    const shadow = this.light.shadow;
    const cam = shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.near = 0;
    // past `far` three's PCF test shades everything under reversed depth (shading.ts skips
    // such coordinates, but they would fall to a coarser cascade): reach the ground below
    cam.far = 2 * radius + ABOVE + BELOW;
    cam.updateProjectionMatrix();
    this.light.updateMatrixWorld();
    this.light.target.updateMatrixWorld();
    // thin leaves under a low sun need a few texels of normal offset to stay free of acne
    this.offset.value = texel * 1.5;
    // casters draw both sides (see Casters): a texel of depth keeps lit faces off themselves
    shadow.bias = texel / cam.far;
    shadow.needsUpdate = true;
  }
}
