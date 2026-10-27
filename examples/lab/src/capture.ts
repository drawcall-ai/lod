import * as THREE from "three/webgpu";
import type { Node } from "three/webgpu";
import { Fn, dot, float, ivec2, max, min, mix, pow, screenCoordinate, select, step, textureLoad, uniform, vec3, vec4 } from "three/tsl";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { readBytes } from "../../../packages/lod/src/renderer.js";
import { biasedTextures } from "../../../packages/lod/src/tsl.js";
import { isImpostorMesh } from "../../../packages/lod/src/three.js";
import { gpuRenderer } from "./page.js";

// The bench's renders (see capture): one object alone from `camera` under a fixed sun
// and environment, supersampled k× and resolved to straight sRGB colour and coverage,
// tone mapped (Neutral) per supersample, textures read at the displayed size (see
// `textureBias`).

/** Supersampling of measured renders: k × k samples per pixel, box-filtered. */
export const K = 4;
/** Largest side of one supersampled render; larger images render in tiles. */
const TILE = 2048;

export const renderer = await gpuRenderer(64, { antialias: false, timed: true });

/**
 * A supersampled render would also sample every texture k× finer than an app does at
 * that height, and textures do not look the same at every scale (alpha-tested leaves
 * whose mip levels mix in the dark texels around them darken with distance). Every
 * texture read is therefore biased by log2(k): geometry supersampled, textures read at
 * the displayed size, as with MSAA. Impostors take it through their mip bias.
 */
const textureBias = uniform(0);
renderer.contextNode = biasedTextures(textureBias);

export const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
// A fixed sun: azimuth 35°, elevation 40°.
sun.position.setFromSphericalCoords(100, THREE.MathUtils.degToRad(90 - 40), THREE.MathUtils.degToRad(35));
scene.add(sun, new THREE.HemisphereLight(0xbfd4ff, 0x4a3d2e, 0.6));
export const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1e5);

/** Khronos PBR Neutral tone mapping, as three's NeutralToneMapping. */
function neutral(color: Node<"vec3">): Node<"vec3"> {
  const start = 0.8 - 0.04;
  const low = min(color.x, min(color.y, color.z));
  const shifted = color.sub(select(low.lessThan(0.08), low.sub(low.mul(low).mul(6.25)), float(0.04))).toVar();
  const peak = max(shifted.x, max(shifted.y, shifted.z));
  const d = 1 - start;
  const top = float(1).sub(float(d * d).div(peak.add(d - start)));
  const scaled = shifted.mul(top.div(peak));
  const g = float(1).sub(float(1).div(peak.sub(top).mul(0.15).add(1)));
  return select(peak.lessThan(start), shifted, mix(scaled, vec3(top, top, top), g));
}

/** Linear to sRGB, per channel. */
function encode(c: Node<"vec3">): Node<"vec3"> {
  const high = step(vec3(0.0031308, 0.0031308, 0.0031308), c);
  return c.mul(12.92).mul(high.oneMinus()).add(pow(c, vec3(1 / 2.4, 1 / 2.4, 1 / 2.4)).mul(1.055).sub(0.055).mul(high));
}

/**
 * Per k × k block of `black` and `white` (the same view over a black and a white
 * clear): coverage is 1 - (white - black); colour is black / coverage, tone mapped,
 * averaged weighted by coverage in linear light, then encoded as sRGB. Out: straight
 * sRGB colour, coverage in alpha.
 */
function resolver(black: THREE.Texture, white: THREE.Texture, k: number): THREE.NodeMaterial {
  const material = new THREE.NodeMaterial();
  material.fragmentNode = Fn(() => {
    const base = ivec2(screenCoordinate.xy).mul(k);
    const sum = vec3(0, 0, 0).toVar();
    const cover = float(0).toVar();
    for (let y = 0; y < k; y++)
      for (let x = 0; x < k; x++) {
        const at = base.add(ivec2(x, y));
        const b = textureLoad(black, at).rgb;
        const w = textureLoad(white, at).rgb;
        const a = float(1).sub(dot(w.sub(b), vec3(1 / 3, 1 / 3, 1 / 3))).clamp(0, 1).toVar();
        sum.addAssign(select(a.greaterThan(1e-3), neutral(b.div(max(a, 1e-3))).mul(a), vec3(0, 0, 0)));
        cover.addAssign(a);
      }
    const colour = select(cover.greaterThan(0), encode(sum.div(max(cover, 1e-6)).clamp(0, 1)), vec3(0, 0, 0));
    return vec4(colour, cover.div(k * k));
  })();
  return material;
}

/** Per size and supersampling, the multisampled targets over black and white and their resolve. */
const msaa = new Map<string, { black: THREE.RenderTarget; white: THREE.RenderTarget; material: THREE.NodeMaterial; resolve: THREE.QuadMesh }>();
function msaaPair(w: number, h: number, k: number) {
  const key = `${w}x${h}x${k}`;
  let pair = msaa.get(key);
  if (!pair) {
    // Linear half float: coverage is recovered from the black and white renders before tone mapping.
    const make = () => new THREE.RenderTarget(w, h, { samples: 4, type: THREE.HalfFloatType });
    const black = make();
    const white = make();
    const material = resolver(black.texture, white.texture, k);
    pair = { black, white, material, resolve: new THREE.QuadMesh(material) };
    msaa.set(key, pair);
  }
  return pair;
}
export function freeTargets(): void {
  for (const { black, white, material } of msaa.values()) {
    black.dispose();
    white.dispose();
    material.dispose();
  }
  msaa.clear();
}

/** Each impostor's own mip bias, before a capture adds log2(k) to it. */
const impostorBias = new WeakMap<THREE.Material, number>();

function shadeAtDisplayScale(object: THREE.Object3D, k: number): void {
  textureBias.value = Math.log2(k);
  object.traverse((node) => {
    if (!isImpostorMesh(node)) return;
    const { mipBias } = node.material;
    const own = impostorBias.get(node.material) ?? mipBias.value;
    impostorBias.set(node.material, own);
    mipBias.value = own + Math.log2(k);
  });
}

const outputs = new Map<string, THREE.RenderTarget>();
function output(w: number, h: number): THREE.RenderTarget {
  const key = `${w}x${h}`;
  let target = outputs.get(key);
  if (!target) {
    target = new THREE.RenderTarget(w, h);
    outputs.set(key, target);
  }
  return target;
}

/**
 * `object` alone from the current camera on a `size` px canvas, rendered at `k`× and
 * resolved (see `resolve`): RGBA8 rows bottom-up. `jitter` shifts the image by that
 * many supersamples.
 */
export async function capture(object: THREE.Object3D, size: number, kk = K, jitter = 0): Promise<Uint8Array> {
  const n = size * kk;
  const pixels = new Uint8Array(size * size * 4);
  scene.add(object);
  shadeAtDisplayScale(object, kk);
  for (let top = 0; top < n; top += TILE)
    for (let left = 0; left < n; left += TILE) {
      const w = Math.min(TILE, n - left);
      const h = Math.min(TILE, n - top);
      camera.setViewOffset(n, n, left + jitter, top + jitter, w, h);
      const { black, white, resolve } = msaaPair(w, h, kk);
      for (const [target, clear] of [
        [black, 0x000000],
        [white, 0xffffff],
      ] as const) {
        renderer.setRenderTarget(target);
        renderer.setClearColor(clear, 1);
        renderer.clear();
        renderer.render(scene, camera);
      }
      const out = output(w / kk, h / kk);
      renderer.setRenderTarget(out);
      resolve.render(renderer);
      const tile = await readBytes(renderer, out, 0);
      // The view offset counts rows from the top; the tile's rows run bottom-up.
      const row0 = (n - top - h) / kk;
      for (let y = 0; y < h / kk; y++) pixels.set(tile.subarray(y * (w / kk) * 4, (y + 1) * (w / kk) * 4), ((row0 + y) * size + left / kk) * 4);
    }
  camera.clearViewOffset();
  renderer.setRenderTarget(null);
  scene.remove(object);
  return pixels;
}
