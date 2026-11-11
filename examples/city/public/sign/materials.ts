import * as THREE from "three/webgpu";
import { Fn, clamp, materialColor, max, mix, mx_noise_float, positionGeometry, smoothstep, vec3, vec4 } from "three/tsl";

/** Weathered galvanised steel: the relief and roughness of metal_plate_02 (2 m a repeat) under a flat metal colour. */
export function galvanisedMaterial(manager: THREE.LoadingManager): THREE.MeshStandardNodeMaterial {
  const arm = texture(manager, "metal_plate_02", "arm", 2);
  const m = new THREE.MeshStandardNodeMaterial({
    name: "galvanised",
    color: "#b9bdbd",
    normalMap: texture(manager, "metal_plate_02", "nor", 2),
    normalScale: new THREE.Vector2(0.25, 0.25),
    aoMap: arm,
    roughnessMap: arm,
    roughness: 0.8,
    metalness: 1,
  });
  m.colorNode = baseColor.mul(vec4(grime(0.6), 1));
  return m;
}

/** Map `name` of Poly Haven set `id` in public/assets/textures (see scripts/fetch-assets.ts), one repeat over `size` metres. */
function texture(manager: THREE.LoadingManager, id: string, name: "diff" | "nor" | "arm", size: number): THREE.Texture {
  const texture = new THREE.Texture();
  texture.flipY = false;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.setScalar(1 / size);
  texture.anisotropy = 8;
  texture.colorSpace = name === "diff" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  const url = new URL(`../assets/textures/${id}/${name}.webp`, import.meta.url).href;
  // through the script's manager, so its load waits for the image
  new THREE.ImageBitmapLoader(manager).setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" }).load(url, (image) => {
    texture.image = image;
    texture.needsUpdate = true;
  });
  return texture;
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
