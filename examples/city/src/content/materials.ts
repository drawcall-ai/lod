import * as THREE from "three";
import { isManifest, type Manifest } from "../manifest.ts";
import { noise } from "./glsl.ts";

/**
 * Shared PBR materials for the generators. Generators write UVs in metres; each texture
 * set repeats at its real-world size, so one texture object serves every material that
 * uses the set.
 */

let assets: Manifest | undefined;
const loader = new THREE.TextureLoader();
const textures = new Map<string, THREE.Texture>();
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
  const set = manifest().textures[id];
  if (!set) throw new Error(`texture set ${id} is not in the manifest`);
  const t = loader.load(assetUrl(set[map]));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / (set.size[0] ?? 1), 1 / (set.size[1] ?? 1));
  t.anisotropy = 8;
  t.colorSpace = map === "diff" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  textures.set(key, t);
  return t;
}

export interface SurfaceOptions {
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

/** A standard material from a Poly Haven texture set; cached by set and options. */
export function surface(id: string, options: SurfaceOptions = {}): THREE.MeshStandardMaterial {
  const key = `${id}|${JSON.stringify(options)}`;
  const cached = materials.get(key);
  if (cached instanceof THREE.MeshStandardMaterial) return cached;
  const { color = 0xffffff, albedo = true, normalScale = 1, roughness = 1, metalness, envMapIntensity = 1, vertexColors = false, side } = options;
  const arm = texture(id, "arm");
  const m = new THREE.MeshStandardMaterial({
    name: id,
    color,
    map: albedo ? texture(id, "diff") : null,
    normalMap: texture(id, "nor"),
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
  if (options.weather) weather(m, options.weather);
  materials.set(key, m);
  return m;
}

/**
 * Procedural weathering in object space (origin on the ground): broad blotchy discolouring,
 * vertical rain streaks, and splash dirt along the bottom 60 cm. Tiling textures repeat
 * every metre or two; this breaks the repetition the way real grime does.
 */
function weather(m: THREE.MeshStandardMaterial, strength: number) {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.weather = { value: strength };
    shader.vertexShader = `varying vec3 vCityPos;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvCityPos = transformed;",
    );
    shader.fragmentShader = `varying vec3 vCityPos;\nuniform float weather;\n${noise}\n${shader.fragmentShader}`.replace(
      "#include <map_fragment>",
      /* glsl */ `#include <map_fragment>
      {
        vec3 p = vCityPos;
        float blotch = cityNoise(p * 0.6) * 0.55 + cityNoise(p * 2.1) * 0.3 + cityNoise(p * 8.0) * 0.15;
        float streak = cityNoise(vec3(p.x * 7.0 + p.z * 7.0, p.y * 0.4, 0.0)) * cityNoise(p * 1.3);
        float splash = 1.0 - smoothstep(0.0, 0.7, p.y);
        float dirt = (blotch - 0.45) * 0.7 + max(streak - 0.3, 0.0) * 1.6 + splash * (0.45 + 0.5 * cityNoise(p * 5.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.5, 0.45, 0.37), clamp(dirt * weather, -0.25, 0.9));
      }`,
    );
  };
  m.customProgramCacheKey = () => `weather`;
}

/** Lazily creates a value on first call and returns the same one afterwards (shared materials, canvas textures). */
export function once<T>(create: () => T): () => T {
  let value: { v: T } | undefined;
  return () => (value ??= { v: create() }).v;
}
