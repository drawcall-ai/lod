import * as THREE from "three/webgpu";
import { Fn, clamp, materialColor, max, mix, mx_noise_float, positionGeometry, smoothstep, vec3, vec4 } from "three/tsl";

/** Metres one repeat of each Poly Haven texture set the garden uses covers, as Poly Haven measures them. */
const TILE = { brushed_concrete_04: 2, corrugated_iron: 1.12, distressed_painted_planks: 1.6, red_brick: 1.4, white_planks_clean: 1.8, wood_table_001: 1.5 };

interface SurfaceOptions {
  /** Multiplies the base colour map. */
  color?: THREE.ColorRepresentation;
  normalScale?: number;
  /** Multiplies the roughness map. */
  roughness?: number;
  /** Strength of procedural weathering (0–1). */
  weather: number;
}

/**
 * A weathered standard material from a Poly Haven texture set in public/assets/textures (see scripts/fetch-assets.ts),
 * its maps loading through `manager`, so the script's load waits for them.
 */
export function surface(manager: THREE.LoadingManager, id: keyof typeof TILE, { color = 0xffffff, normalScale = 1, roughness = 1, weather }: SurfaceOptions) {
  const map = (name: "diff" | "nor" | "arm") => {
    const texture = new THREE.Texture();
    texture.flipY = false;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.setScalar(1 / TILE[id]);
    texture.anisotropy = 8;
    texture.colorSpace = name === "diff" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    const url = new URL(`../assets/textures/${id}/${name}.webp`, import.meta.url).href;
    new THREE.ImageBitmapLoader(manager).setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" }).load(url, (image) => {
      texture.image = image;
      texture.needsUpdate = true;
    });
    return texture;
  };
  const arm = map("arm");
  const m = new THREE.MeshStandardNodeMaterial({
    name: id,
    color,
    map: map("diff"),
    normalMap: map("nor"),
    normalScale: new THREE.Vector2(normalScale, normalScale),
    aoMap: arm,
    roughnessMap: arm,
    roughness,
    // arm stores metalness in blue, which Poly Haven leaves at zero for non-metals
    metalnessMap: arm,
    metalness: 1,
  });
  // the map's colour (and alpha) darkened: three multiplies vertex colours in after
  m.colorNode = baseColor.mul(vec4(grime(weather), 1));
  return m;
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
const baseColor = Fn(() => {
  const color = vec4(1).toVar();
  color.assign(materialColor);
  return color;
})();

/**
 * Glass that reflects and lets what is behind it show through, blended as premultiplied light: the reflection is added
 * whole and what is behind is dimmed by the opacity. Its base colour is black, which is also what the baked levels show
 * of it (they bake blended surfaces opaque).
 */
// ior 2.2 gives F0 ≈ 0.14, the combined reflectance of the four faces of double glazing
export const glass = () =>
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
  });

/** Flat-coloured materials of the garden's odds and ends. */
export const paints = {
  letterbox: () => new THREE.MeshStandardMaterial({ name: "letterbox", color: "#2f3d33", roughness: 0.45, metalness: 0.6 }),
  slot: () => new THREE.MeshStandardMaterial({ name: "slot", color: "#111111", roughness: 0.8 }),
  aluminium: () => new THREE.MeshStandardMaterial({ name: "aluminium", color: "#b8bcbd", metalness: 1, roughness: 0.4 }),
  plants: () => new THREE.MeshStandardMaterial({ name: "plants", color: "#3d6b2a", roughness: 0.9 }),
  rope: () => new THREE.MeshStandardMaterial({ name: "rope", color: "#c8b88a", roughness: 0.9 }),
  seat: () => new THREE.MeshStandardMaterial({ name: "seat", color: "#b03a2e", roughness: 0.6 }),
  post: () => new THREE.MeshStandardMaterial({ name: "post", color: "#9da3a5", metalness: 0.8, roughness: 0.5 }),
  line: () => new THREE.MeshStandardMaterial({ name: "line", color: "#e8e8e0", roughness: 0.7 }),
  washing: () => new THREE.MeshStandardMaterial({ name: "washing", vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }),
  "garden furniture": () => new THREE.MeshStandardMaterial({ name: "garden furniture", color: "#ecebe6", metalness: 0.3, roughness: 0.5 }),
};
