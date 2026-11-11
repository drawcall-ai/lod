import * as THREE from "three/webgpu";
import { loadManifest, type Manifest } from "./manifest.ts";
import { Fn, clamp, float, materialColor, max, mix, mx_noise_float, positionGeometry, smoothstep, vec3, vec4 } from "three/tsl";

/**
 * The materials and textures one asset makes, each made once however many meshes use it. The asset disposes them with
 * its meshes (see dispose.ts); textures load through `manager`, so the asset's load waits for them.
 */
export class Materials {
  #made = new Map<string, THREE.Material>();
  #textures = new Map<string, THREE.Texture>();
  #loading: Promise<void>[] = [];

  private constructor(
    readonly manager: THREE.LoadingManager,
    private readonly base: URL,
    readonly manifest: Manifest,
  ) {}

  /**
   * Materials of the textures in `base`'s manifest.json, which it loads first. The default is public/assets beside this
   * module, as scripts load it; a page that bundles this module passes where it serves public/assets.
   */
  static async load(manager: THREE.LoadingManager, base = new URL("../assets/", import.meta.url)): Promise<Materials> {
    return new Materials(manager, base, await loadManifest(new URL("manifest.json", base).href, manager));
  }

  /** A file of public/assets, which scripts/fetch-assets.ts downloads. */
  asset(file: string): string {
    return new URL(file, this.base).href;
  }

  /** The material made under `key`, made by `make` the first time. */
  material(key: string, make: () => THREE.Material): THREE.Material {
    const made = this.#made.get(key);
    if (made) return made;
    const material = make();
    this.#made.set(key, material);
    return material;
  }

  /** Resolves once every texture made so far has loaded. */
  async ready(): Promise<void> {
    await Promise.all(this.#loading);
  }

  /** One map of a texture set, tiled to its real-world size. */
  texture(id: string, map: "diff" | "nor" | "arm"): THREE.Texture {
    const set = this.manifest.textures[id];
    if (!set) throw new Error(`texture set ${id} is not in the manifest`);
    const url = this.asset(set[map]);
    const loaded = this.#textures.get(url);
    if (loaded) return loaded;
    const texture = new THREE.Texture();
    texture.flipY = false;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1 / (set.size[0] ?? 1), 1 / (set.size[1] ?? 1));
    texture.anisotropy = 8;
    texture.colorSpace = map === "diff" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    const loading = new THREE.ImageBitmapLoader(this.manager).setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" }).loadAsync(url);
    this.#loading.push(
      loading.then((image) => {
        texture.image = image;
        texture.needsUpdate = true;
      }),
    );
    this.#textures.set(url, texture);
    return texture;
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
  side?: THREE.Side;
  /** Strength of procedural weathering (0–1). */
  weather?: number;
}

/** A material from the set's own maps, or one drawn with WebGPU's nodes once it is weathered. */
export type Surface = THREE.MeshStandardMaterial | THREE.MeshStandardNodeMaterial;

/** A standard material from a Poly Haven texture set; cached by set and options. */
export function surface(materials: Materials, id: string, options: SurfaceOptions = {}): Surface {
  const material = materials.material(`${id}|${JSON.stringify(options)}`, () => {
    const { color = 0xffffff, albedo = true, normalScale = 1, roughness = 1, metalness, envMapIntensity = 1, vertexColors = false, side } = options;
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
      side: side ?? THREE.FrontSide,
    });
    return options.weather ? weathered(m, options.weather) : m;
  });
  if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshStandardNodeMaterial)) throw new Error(`Invalid surface ${id}`);
  return material;
}

/**
 * `m` with procedural weathering in object space (origin on the ground): broad blotchy
 * discolouring, vertical rain streaks, and splash dirt along the bottom 60 cm. Tiling
 * textures repeat every metre or two; this breaks the repetition the way real grime does.
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
  const noise3 = (q: THREE.Node<"vec3">) => mx_noise_float(q, 0.5, 0.5);
  const blotch = noise3(p.mul(0.6))
    .mul(0.55)
    .add(noise3(p.mul(2.1)).mul(0.3))
    .add(noise3(p.mul(8)).mul(0.15));
  const streak = noise3(vec3(p.x.mul(7).add(p.z.mul(7)), p.y.mul(0.4), 0)).mul(noise3(p.mul(1.3)));
  const splash = smoothstep(0, 0.7, p.y).oneMinus();
  const dirt = blotch
    .sub(0.45)
    .mul(0.7)
    .add(max(streak.sub(0.3), 0).mul(1.6))
    .add(splash.mul(noise3(p.mul(5)).mul(0.5).add(0.45)));
  return mix(vec3(1), vec3(0.5, 0.45, 0.37), clamp(dirt.mul(strength), -0.25, 0.9));
}

/**
 * A material's colour times its map, its alpha included: three's `materialColor`, which
 * builds to a vec4 where the material has a map, and to a vec3 (typed so) where not.
 */
export const baseColor = Fn(() => {
  const color = vec4(1).toVar();
  color.assign(materialColor);
  return color;
})();
