import * as THREE from "three/webgpu";
import { Fn, clamp, float, materialColor, max, mix, mx_noise_float, positionGeometry, smoothstep, vec3, vec4 } from "three/tsl";
import type { HouseParams } from "./params.ts";

/** Metres one repeat of each Poly Haven texture set a house uses covers, as Poly Haven measures them. */
const TILE = { gravel_road: 2, metal_plate_02: 2, red_brick: 1.4, white_stucco: 2, whitewashed_brick: 2, wood_table_001: 1.5 };

type TextureSet = keyof typeof TILE;

/**
 * The materials and textures one building makes, each made once however many meshes use it: meshes merge by material.
 * The script disposes them with its meshes. Textures load through `manager`; await `ready` for them.
 */
export class Materials {
  readonly #made = new Map<string, THREE.Material>();
  readonly #textures = new Map<string, THREE.Texture>();
  readonly #loading: Promise<void>[] = [];

  /**
   * `folder` is the house's, which holds the textures/ scripts/fetch-assets.ts fetches: this module's, as scripts load
   * it, unless a page that bundles this module says where it serves it.
   */
  constructor(
    private readonly manager: THREE.LoadingManager,
    private readonly folder = new URL("./", import.meta.url),
  ) {}

  /** The material made under `key`, made by `make` the first time. */
  material(key: string, make: () => THREE.Material): THREE.Material {
    const made = this.#made.get(key);
    if (made) return made;
    const material = make();
    this.#made.set(key, material);
    return material;
  }

  /** One map of a texture set, tiled to its real-world size. */
  texture(id: TextureSet, map: "diff" | "nor" | "arm"): THREE.Texture {
    const url = new URL(`textures/${id}/${map}.webp`, this.folder).href;
    const loaded = this.#textures.get(url);
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
    this.#textures.set(url, texture);
    return texture;
  }

  /** Resolves once every texture made so far has loaded; rejects with the first that failed. */
  async ready(): Promise<void> {
    await Promise.all(this.#loading);
  }
}

interface SurfaceOptions {
  /** Multiplies the base colour map, or replaces it when `albedo` is false. */
  color?: THREE.ColorRepresentation;
  /** Use the set's base colour map (default) or only its relief and roughness. */
  albedo?: boolean;
  normalScale?: number;
  /** Multiplies the roughness map. */
  roughness?: number;
  metalness?: number;
  envMapIntensity?: number;
  vertexColors?: boolean;
  /** Strength of procedural weathering (0–1). */
  weather?: number;
}

/** A material from the set's own maps, or one drawn with WebGPU's nodes once it is weathered. */
export type Surface = THREE.MeshStandardMaterial | THREE.MeshStandardNodeMaterial;

/** A standard material from a Poly Haven texture set; made once per set and options. */
export function surface(materials: Materials, id: TextureSet, options: SurfaceOptions = {}): Surface {
  const material = materials.material(`${id}|${JSON.stringify(options)}`, () => {
    const { color = 0xffffff, albedo = true, normalScale = 1, roughness = 1, metalness, envMapIntensity = 1, vertexColors = false } = options;
    const arm = materials.texture(id, "arm");
    const m = new THREE.MeshStandardMaterial({
      name: id,
      color,
      map: albedo ? materials.texture(id, "diff") : null,
      normalMap: materials.texture(id, "nor"),
      normalScale: new THREE.Vector2(normalScale, normalScale),
      aoMap: arm,
      roughnessMap: arm,
      roughness,
      // arm stores metalness in blue, which Poly Haven leaves at zero for non-metals
      metalnessMap: metalness === undefined ? arm : null,
      metalness: metalness ?? 1,
      envMapIntensity,
      vertexColors,
    });
    return options.weather ? weathered(m, options.weather) : m;
  });
  if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshStandardNodeMaterial)) throw new Error(`Invalid surface ${id}`);
  return material;
}

/**
 * `m` with procedural weathering in object space (origin on the ground): broad blotchy discolouring, vertical rain
 * streaks, and splash dirt along the bottom 60 cm. Tiling textures repeat every metre or two; this breaks the
 * repetition the way real grime does.
 */
function weathered(m: THREE.MeshStandardMaterial, strength: number): THREE.MeshStandardNodeMaterial {
  const node = new THREE.MeshStandardNodeMaterial().copy(m);
  // the map's colour (and alpha) darkened: three multiplies vertex colours in after
  node.colorNode = baseColor.mul(vec4(weatherColor(float(strength)), 1));
  return node;
}

function weatherColor(strength: THREE.Node<"float">): THREE.Node<"vec3"> {
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
const baseColor = Fn(() => {
  const color = vec4(1).toVar();
  color.assign(materialColor);
  return color;
})();

/** Painted joinery: flat colour over a fine wood-grain relief. */
export function paint(materials: Materials, color: string): Surface {
  return surface(materials, "wood_table_001", { albedo: false, color, normalScale: 0.25, roughness: 1.6, weather: 0.35 });
}

/**
 * Window glass: the pane reflects (its Fresnel reflection of the sky carries the look from
 * outside) and lets the room behind show through. Blended as premultiplied light: the
 * reflection is added whole and the room behind is dimmed by the opacity, as with real
 * glass, rather than fading the reflection with it. Its base colour is black, which is
 * also what the baked levels show of it (they bake blended surfaces opaque).
 */
// ior 2.2 gives F0 ≈ 0.14, the combined reflectance of the four faces of double glazing
export const glass = (materials: Materials) =>
  materials.material(
    "house/materials.ts:glass",
    () =>
      new THREE.MeshPhysicalMaterial({
        name: "glass",
        color: "#000000",
        metalness: 0,
        roughness: 0.02,
        ior: 2.2,
        specularIntensity: 1,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
  );

export const brass = (materials: Materials) =>
  materials.material("house/materials.ts:brass", () => new THREE.MeshStandardMaterial({ name: "brass", color: "#b8954f", metalness: 1, roughness: 0.32 }));

export function zinc(materials: Materials): Surface {
  return surface(materials, "metal_plate_02", { albedo: false, color: "#aeb3b4", metalness: 1, normalScale: 0.15, roughness: 0.75, weather: 0.5 });
}

/** Cast stone for sills, steps and the ridge bed. */
export function concrete(materials: Materials): Surface {
  return surface(materials, "white_stucco", { color: "#b9b4ab", normalScale: 1.5, weather: 0.8 });
}

/** Rendered base course, darker than the wall above it. */
export function plinth(materials: Materials): Surface {
  return surface(materials, "white_stucco", { color: "#8f8b84", normalScale: 1.5, weather: 1 });
}

export function wall(materials: Materials, p: HouseParams): Surface {
  if (p.wall.kind === "brick") return surface(materials, "red_brick", { weather: 0.5 });
  if (p.wall.kind === "whitewash") return whitewash(materials);
  return surface(materials, "white_stucco", { color: p.wall.color, weather: 0.7 });
}

export function whitewash(materials: Materials): Surface {
  return surface(materials, "whitewashed_brick", { weather: 0.6 });
}

/** Clay or slate: per-tile colour lives in vertex colours, the stucco set adds mottling and grain. */
export function tiles(materials: Materials): Surface {
  return surface(materials, "white_stucco", { vertexColors: true, normalScale: 0.9, weather: 0.6 });
}

export function brick(materials: Materials): Surface {
  return surface(materials, "red_brick", { weather: 0.8 });
}

export function gravel(materials: Materials): Surface {
  return surface(materials, "gravel_road", { normalScale: 1.5, weather: 0.3 });
}
export function churchStone(materials: Materials): Surface {
  return surface(materials, "red_brick", { weather: 0.9 });
}
export function churchSlate(materials: Materials): Surface {
  return surface(materials, "white_stucco", { color: "#3a3e44", normalScale: 1.2, weather: 0.5 });
}
