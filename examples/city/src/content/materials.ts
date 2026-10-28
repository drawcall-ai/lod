import * as THREE from "three/webgpu";
import { isManifest, type Manifest } from "../manifest.ts";
import { Fn, clamp, float, materialColor, max, mix, positionGeometry, smoothstep, vec3, vec4 } from "three/tsl";
import { noise3 } from "./noise.ts";

/**
 * Shared PBR materials for the generators. Generators write UVs in metres; each texture
 * set repeats at its real-world size, so one texture object serves every material that
 * uses the set.
 */

let assets: Manifest | undefined;
const loader = once(() => new THREE.ImageBitmapLoader().setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" }));
const textures = new Map<string, THREE.Texture>();
const files = new WeakMap<THREE.Texture, string>();
const sourceFiles = new WeakMap<THREE.Source<unknown>, string>();
const pending = new WeakMap<THREE.Texture, Promise<void>>();
const materials = new Map<string, THREE.Material>();

const base = "./assets/";

export async function loadManifest(): Promise<void> {
  const r = await fetch(`${base}manifest.json`);
  if (!r.ok) throw new Error(`${base}manifest.json: HTTP ${r.status} — run \`pnpm --filter @drawcall/lod-example-city assets\` first`);
  const data: unknown = await r.json();
  if (!isManifest(data)) throw new Error(`${base}manifest.json is not a manifest — run \`pnpm --filter @drawcall/lod-example-city assets\` again`);
  assets = data;
}

export function manifest(): Manifest {
  if (!assets) throw new Error("loadManifest() must finish before content is generated");
  return assets;
}

export function assetUrl(file: string): string {
  if (!assets) throw new Error("loadManifest() must finish before content is generated");
  return base + file;
}

/** One map of a texture set, repeating once per its real-world size over metre UVs; cached. */
export function texture(id: string, map: "diff" | "nor" | "arm"): THREE.Texture {
  const key = `${id}/${map}`;
  const cached = textures.get(key);
  if (cached) return cached;
  const t = textureInfo(id, map);
  const path = textureFile(t);
  if (!path) throw new Error(`texture ${key} has no source file`);
  pending.set(
    t,
    loader()
      .loadAsync(`./${path}`)
      .then((image) => {
        t.image = image;
        t.needsUpdate = true;
      }),
  );
  textures.set(key, t);
  return t;
}

/** An atlas row needs file identity and sampler settings, without loading those pixels twice. */
function textureInfo(id: string, map: "diff" | "nor" | "arm"): THREE.Texture {
  const set = manifest().textures[id];
  if (!set) throw new Error(`texture set ${id} is not in the manifest`);
  const t = new THREE.Texture();
  // ImageBitmapLoader produces upload-oriented rows; WebGPU must not flip them again.
  t.flipY = false;
  files.set(t, `assets/${set[map]}`);
  sourceFiles.set(t.source, `assets/${set[map]}`);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / (set.size[0] ?? 1), 1 / (set.size[1] ?? 1));
  t.anisotropy = 8;
  t.colorSpace = map === "diff" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

/** Actual source file of a texture loaded by the material library. */
export function textureFile(texture: THREE.Texture): string | undefined {
  return files.get(texture) ?? sourceFiles.get(texture.source);
}

/** Wait only for this object's texture inputs, including bitmap decoding. */
export async function texturesReady(object: THREE.Object3D | readonly THREE.Material[]): Promise<void> {
  const tasks = new Set<Promise<void>>();
  const collect = (materials: readonly THREE.Material[]) => {
    for (const material of materials)
      for (const value of Object.values(material)) {
        if (!(value instanceof THREE.Texture)) continue;
        const task = pending.get(value);
        if (task) tasks.add(task);
      }
  };
  if (object instanceof THREE.Object3D)
    object.traverse((node) => {
      if (node instanceof THREE.Mesh) collect([node.material].flat());
    });
  else collect(object);
  await Promise.all(tasks);
}

/** Rebuild a procedural surface from the material's persisted recipe. */
export function restoreSurface(_name: string, data: Record<string, unknown>, textures: "pixels" | "metadata" = "pixels"): Surface | undefined {
  const value = data.surface;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || !("id" in value) || !("options" in value)) throw new Error("Invalid surface recipe");
  const { id, options: raw } = value;
  if (typeof id !== "string" || typeof raw !== "object" || raw === null) throw new Error("Invalid surface recipe");
  const options: SurfaceOptions = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "color":
        if (typeof value !== "number" && typeof value !== "string") throw new Error("Invalid surface colour");
        options.color = value;
        break;
      case "albedo":
      case "vertexColors":
        if (typeof value !== "boolean") throw new Error(`Invalid surface ${key}`);
        options[key] = value;
        break;
      case "side":
        if (value !== THREE.FrontSide && value !== THREE.BackSide && value !== THREE.DoubleSide) throw new Error("Invalid surface side");
        options.side = value;
        break;
      case "normalScale":
      case "roughness":
      case "metalness":
      case "envMapIntensity":
      case "weather":
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid surface ${key}`);
        options[key] = value;
        break;
      default:
        throw new Error(`Unknown surface option ${key}`);
    }
  }
  return textures === "metadata" ? makeSurface(id, options, textureInfo) : surface(id, options);
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
  /** Strength of procedural weathering (0–1); see `weather`. */
  weather?: number;
}

/** A material from the set's own maps, or one drawn with WebGPU's nodes once it is weathered. */
export type Surface = THREE.MeshStandardMaterial | THREE.MeshStandardNodeMaterial;

const weathering = new WeakMap<THREE.MeshStandardNodeMaterial, number>();

/** The procedural weathering strength carried into a batched house material. */
export function weatherStrength(material: Surface): number {
  if (!(material instanceof THREE.MeshStandardNodeMaterial)) return 0;
  const strength = weathering.get(material);
  if (strength === undefined) throw new Error(`Unknown procedural surface: ${material.name}`);
  return strength;
}

/** A standard material from a Poly Haven texture set; cached by set and options. */
export function surface(id: string, options: SurfaceOptions = {}): Surface {
  const key = `${id}|${JSON.stringify(options)}`;
  const cached = materials.get(key);
  if (cached instanceof THREE.MeshStandardMaterial || cached instanceof THREE.MeshStandardNodeMaterial) return cached;
  const made = makeSurface(id, options, texture);
  materials.set(key, made);
  return made;
}

function makeSurface(id: string, options: SurfaceOptions, map: typeof texture): Surface {
  const { color = 0xffffff, albedo = true, normalScale = 1, roughness = 1, metalness, envMapIntensity = 1, vertexColors = false, side } = options;
  const arm = map(id, "arm");
  const m = new THREE.MeshStandardMaterial({
    name: id,
    color,
    map: albedo ? map(id, "diff") : null,
    normalMap: map(id, "nor"),
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
  const made = options.weather ? weathered(m, options.weather) : m;
  const recipe: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(options)) {
    if (value instanceof THREE.Color) recipe[name] = value.getHex();
    else if (value !== undefined) recipe[name] = value;
  }
  made.userData.surface = { id, options: recipe };
  return made;
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
  weathering.set(node, strength);
  return node;
}

/** The same object-space weathering for an ordinary surface or an atlas table row. */
export function weatherColor(strength: THREE.Node<"float">): THREE.Node<"vec3"> {
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

/** Lazily creates a value on first call and returns the same one afterwards (shared materials, canvas textures). */
export function once<T>(create: () => T): () => T {
  let value: { v: T } | undefined;
  return () => (value ??= { v: create() }).v;
}
