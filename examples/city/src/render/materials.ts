import * as THREE from "three/webgpu";
import { Fn, clamp, materialColor, max, mix, mx_noise_float, positionGeometry, smoothstep, vec3, vec4 } from "three/tsl";

/** Metres one repeat of each texture set the page draws covers: Poly Haven's measures, ambientCG's Grass001 chosen. */
const TILE = { Grass001: 1.2, aerial_grass_rock: 15, asphalt_02: 3, brushed_concrete_04: 2, cobblestone_floor_04: 1.5, farm_soil: 2, gravel_road: 2 };

type TextureSet = keyof typeof TILE;

/** The texture sets of public/assets/textures (from scripts/fetch-assets.ts) a page draws with, each map loaded once. */
export class Textures {
  readonly #loaded = new Map<string, THREE.Texture>();
  readonly #loading: Promise<void>[] = [];

  constructor(readonly manager: THREE.LoadingManager) {}

  /** One map of a texture set, tiled to its real-world size. */
  get(id: TextureSet, map: "diff" | "nor" | "arm"): THREE.Texture {
    const url = new URL(`/assets/textures/${id}/${map}.webp`, location.href).href;
    const loaded = this.#loaded.get(url);
    if (loaded) return loaded;
    const texture = new THREE.Texture();
    texture.flipY = false;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.setScalar(1 / TILE[id]);
    texture.anisotropy = 8;
    texture.colorSpace = map === "diff" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    const loader = new THREE.ImageBitmapLoader(this.manager).setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" });
    this.#loading.push(
      loader.loadAsync(url).then((image) => {
        texture.image = image;
        texture.needsUpdate = true;
      }),
    );
    this.#loaded.set(url, texture);
    return texture;
  }

  /** Resolves once every map got so far has loaded; rejects with the first that failed. */
  async ready(): Promise<void> {
    await Promise.all(this.#loading);
  }
}

interface SurfaceOptions {
  /** Multiplies the base colour map. */
  color?: THREE.ColorRepresentation;
  normalScale?: number;
  /** Strength of procedural weathering (0–1). */
  weather?: number;
}

/** A standard material from a texture set's maps, drawn with WebGPU's nodes once it is weathered. */
export function surface(
  textures: Textures,
  id: TextureSet,
  { color = 0xffffff, normalScale = 1, weather }: SurfaceOptions = {},
): THREE.MeshStandardMaterial | THREE.MeshStandardNodeMaterial {
  const arm = textures.get(id, "arm");
  const m = new THREE.MeshStandardMaterial({
    name: id,
    color,
    map: textures.get(id, "diff"),
    normalMap: textures.get(id, "nor"),
    normalScale: new THREE.Vector2(normalScale, normalScale),
    aoMap: arm,
    roughnessMap: arm,
    // arm stores metalness in blue, which Poly Haven leaves at zero for non-metals
    metalnessMap: arm,
    metalness: 1,
  });
  if (!weather) return m;
  const node = new THREE.MeshStandardNodeMaterial().copy(m);
  node.colorNode = baseColor.mul(vec4(grime(weather), 1));
  return node;
}

/**
 * Procedural weathering in object space (origin on the ground): broad blotchy discolouring, vertical rain streaks, and
 * splash dirt along the bottom 60 cm. Tiling textures repeat every metre or two; this breaks the repetition the way
 * real grime does.
 */
function grime(strength: number): THREE.Node<"vec3"> {
  const p = positionGeometry;
  // MaterialX's Perlin noise, which spans about [-1, 1], remapped to [0, 1], where the grime below was tuned
  const noise = (q: THREE.Node<"vec3">) => mx_noise_float(q, 0.5, 0.5);
  const blotch = noise(p.mul(0.6))
    .mul(0.55)
    .add(noise(p.mul(2.1)).mul(0.3))
    .add(noise(p.mul(8)).mul(0.15));
  const streak = noise(vec3(p.x.mul(7).add(p.z.mul(7)), p.y.mul(0.4), 0)).mul(noise(p.mul(1.3)));
  const splash = smoothstep(0, 0.7, p.y).oneMinus();
  const dirt = blotch
    .sub(0.45)
    .mul(0.7)
    .add(max(streak.sub(0.3), 0).mul(1.6))
    .add(splash.mul(noise(p.mul(5)).mul(0.5).add(0.45)));
  return mix(vec3(1), vec3(0.5, 0.45, 0.37), clamp(dirt.mul(strength), -0.25, 0.9));
}

/**
 * A material's colour times its map, its alpha included: three's `materialColor`, which builds to a vec4 where the
 * material has a map, and to a vec3 (typed so) where not.
 */
export const baseColor = Fn(() => {
  const color = vec4(1).toVar();
  color.assign(materialColor);
  return color;
})();
