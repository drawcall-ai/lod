import { Textures, sharedTextures } from "./textures.ts";
import * as THREE from "three/webgpu";
import { loadManifest, type Manifest } from "./manifest.ts";
import { Fn, clamp, float, materialColor, max, mix, positionGeometry, smoothstep, vec3, vec4 } from "three/tsl";
import { noise3 } from "./noise.ts";

/** Resources owned by one scene, including materials rebuilt before cached geometry is decoded. */
export class Library {
  #disposed = false;
  #textures: Textures;
  #ownsTextures: boolean;
  #used = new Set<THREE.Texture>();
  #surfaces = new Map<string, THREE.Material>();
  #owned = new Set<THREE.Material>();
  #geometries = new Set<THREE.BufferGeometry>();
  #tasks = new Map<string, Promise<THREE.Material>>();
  #assets?: Manifest;

  constructor(
    readonly manager: THREE.LoadingManager,
    readonly base: string,
    textures = sharedTextures,
  ) {
    this.#textures = textures ?? new Textures();
    this.#ownsTextures = textures === undefined;
  }

  assertOpen(): void {
    if (this.#disposed) throw new Error("Resource library is disposed");
  }

  async load(): Promise<void> {
    this.assertOpen();
    const data = await loadManifest(`${this.base}manifest.json`, this.manager);
    this.assertOpen();
    this.#assets = data;
  }

  manifest(): Manifest {
    this.assertOpen();
    if (!this.#assets) throw new Error("Load the asset manifest before generating textured content");
    return this.#assets;
  }

  /** Dispose an object's geometries and materials with this library. */
  own<T extends THREE.Object3D>(object: T): T {
    const resources = new Set<THREE.BufferGeometry | THREE.Material>();
    object.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      resources.add(node.geometry);
      for (const material of [node.material].flat()) resources.add(material);
    });
    if (this.#disposed) {
      for (const resource of resources) resource.dispose();
      this.assertOpen();
    }
    for (const resource of resources) {
      if (resource instanceof THREE.Material) this.#owned.add(resource);
      else this.#geometries.add(resource);
    }
    return object;
  }

  /** Dispose an owned object's geometries now; materials may be shared, so they stay until the library is disposed. */
  release(object: THREE.Object3D): void {
    object.traverse((node) => {
      if (node instanceof THREE.Mesh && this.#geometries.delete(node.geometry)) node.geometry.dispose();
    });
  }

  material(key: string, make: () => THREE.Material): THREE.Material {
    this.assertOpen();
    const cached = this.#surfaces.get(key);
    if (cached) return cached;
    const material = make();
    this.#surfaces.set(key, material);
    return material;
  }

  key(material: THREE.Material): string {
    for (const [key, value] of this.#surfaces) if (value === material) return key;
    throw new Error(`Material ${material.name} is not in this library`);
  }

  task(key: string, make: () => Promise<THREE.Material>): Promise<THREE.Material> {
    this.assertOpen();
    let task = this.#tasks.get(key);
    if (!task) {
      task = make();
      this.#tasks.set(key, task);
    }
    return task;
  }

  texture(id: string, map: "diff" | "nor" | "arm"): THREE.Texture {
    this.assertOpen();
    const set = this.manifest().textures[id];
    if (!set) throw new Error(`texture set ${id} is not in the manifest`);
    const texture = this.#textures.load(assetUrl(this, set[map]), set.size, map === "diff" ? THREE.SRGBColorSpace : THREE.NoColorSpace, this.manager);
    this.#used.add(texture);
    return texture;
  }

  /** Wait for the textures of an object's materials, or of every texture this library loaded. */
  async ready(object?: THREE.Object3D): Promise<void> {
    this.assertOpen();
    const textures = object ? new Set<THREE.Texture>() : this.#used;
    object?.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      for (const material of [node.material].flat()) for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    });
    await this.#textures.ready(textures);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const resources = new Set<THREE.Material | THREE.Texture | THREE.BufferGeometry>(this.#geometries);
    for (const material of [...this.#owned, ...this.#surfaces.values()]) {
      resources.add(material);
      for (const texture of Object.values(material)) if (texture instanceof THREE.Texture && !this.#textures.owns(texture)) resources.add(texture);
    }
    for (const resource of resources) resource.dispose();
    this.#geometries.clear();
    if (this.#ownsTextures) this.#textures.dispose();
    this.#tasks.clear();
    this.#owned.clear();
    this.#used.clear();
    this.#surfaces.clear();
  }
}

export const assetUrl = (library: Library, file: string): string => new URL(file, library.base).href;

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
export function surface(library: Library, id: string, options: SurfaceOptions = {}): Surface {
  const material = library.material(`${id}|${JSON.stringify(options)}`, () => {
    const { color = 0xffffff, albedo = true, normalScale = 1, roughness = 1, metalness, envMapIntensity = 1, vertexColors = false, side } = options;
    const arm = library.texture(id, "arm");
    const m = new THREE.MeshStandardMaterial({
      name: id,
      color,
      map: albedo ? library.texture(id, "diff") : null,
      normalMap: library.texture(id, "nor"),
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
