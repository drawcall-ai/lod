import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

// The bench's renders (see capture): one object alone from `camera` under a fixed sun
// and environment, supersampled k× and resolved to straight sRGB colour and coverage,
// tone mapped (Neutral) per supersample, textures read at the displayed size (see
// shadeAtDisplayScale).

/** Supersampling of measured renders: k × k samples per pixel, box-filtered. */
export const K = 4;
/** Largest side of one supersampled render; larger images render in tiles. */
const TILE = 2048;

export const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(1);
renderer.setSize(64, 64);
document.body.append(renderer.domElement);

export const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
// A fixed sun: azimuth 35°, elevation 40°.
sun.position.setFromSphericalCoords(100, THREE.MathUtils.degToRad(90 - 40), THREE.MathUtils.degToRad(35));
scene.add(sun, new THREE.HemisphereLight(0xbfd4ff, 0x4a3d2e, 0.6));
export const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 1e5);

const msaa = new Map<string, [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]>();
function msaaPair(w: number, h: number): [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] {
  const key = `${w}x${h}`;
  let pair = msaa.get(key);
  if (!pair) {
    // Linear half float: coverage is recovered from the black and white renders before tone mapping.
    const make = () => new THREE.WebGLRenderTarget(w, h, { samples: 4, type: THREE.HalfFloatType });
    pair = [make(), make()];
    msaa.set(key, pair);
  }
  return pair;
}
export function freeTargets(): void {
  for (const pair of msaa.values()) for (const t of pair) t.dispose();
  msaa.clear();
}

/**
 * Per k × k block: coverage is 1 - (white - black); colour is black / coverage, tone
 * mapped, averaged weighted by coverage in linear light, then encoded as sRGB. Out:
 * straight sRGB colour, coverage in alpha.
 */
const resolveInputs: Record<"black" | "white", THREE.IUniform<THREE.Texture | null>> & { k: THREE.IUniform<number> } = {
  black: { value: null },
  white: { value: null },
  k: { value: K },
};
const resolve = new FullScreenQuad(
  new THREE.ShaderMaterial({
    uniforms: { ...resolveInputs, toneMappingExposure: { value: 1 } },
    vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D black;
      uniform sampler2D white;
      uniform int k;
      ${THREE.ShaderChunk.tonemapping_pars_fragment}
      vec3 encode(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      void main() {
        ivec2 base = ivec2(gl_FragCoord.xy) * k;
        vec3 sum = vec3(0.0);
        float cover = 0.0;
        for (int y = 0; y < k; y++)
          for (int x = 0; x < k; x++) {
            vec3 b = texelFetch(black, base + ivec2(x, y), 0).rgb;
            vec3 w = texelFetch(white, base + ivec2(x, y), 0).rgb;
            float a = clamp(1.0 - dot(w - b, vec3(1.0 / 3.0)), 0.0, 1.0);
            if (a > 1e-3) sum += NeutralToneMapping(b / a) * a;
            cover += a;
          }
        gl_FragColor = vec4(cover > 0.0 ? encode(clamp(sum / cover, 0.0, 1.0)) : vec3(0.0), cover / float(k * k));
      }`,
  }),
);

/**
 * A supersampled render would also sample every texture k× finer than an app does at
 * that height, and textures do not look the same at every scale (alpha-tested leaves
 * whose mip levels mix in the dark texels around them darken with distance). Each
 * capture therefore biases texture reads by log2(k): geometry supersampled, textures
 * read at the displayed size, as with MSAA. Impostors take it through their mip bias.
 */
const textureBias = { value: 0 };
/** Each impostor material's own mip bias (the package's IMPOSTOR_MIP_BIAS define). */
const impostorBias = new WeakMap<THREE.Material, number>();
const patched = new WeakSet<THREE.Material>();

function shadeAtDisplayScale(object: THREE.Object3D, k: number): void {
  textureBias.value = Math.log2(k);
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const materials: THREE.Material[] = [node.material].flat();
    for (const material of materials) {
      const defines = material.defines;
      if ("isImpostorMesh" in node && defines) {
        const own = impostorBias.get(material) ?? Number(defines.IMPOSTOR_MIP_BIAS);
        impostorBias.set(material, own);
        const value = (own + Math.log2(k)).toFixed(3);
        if (defines.IMPOSTOR_MIP_BIAS === value) continue;
        defines.IMPOSTOR_MIP_BIAS = value;
        material.needsUpdate = true;
        continue;
      }
      if (patched.has(material)) continue;
      patched.add(material);
      const compile = material.onBeforeCompile;
      const key = material.customProgramCacheKey();
      material.onBeforeCompile = (shader, r) => {
        compile.call(material, shader, r);
        shader.uniforms.benchTextureBias = textureBias;
        shader.fragmentShader = `uniform float benchTextureBias;\n#undef texture2D\n#define texture2D(map, uv) texture(map, uv, benchTextureBias)\n${shader.fragmentShader}`;
      };
      material.customProgramCacheKey = () => `bench-bias|${key}`;
      material.needsUpdate = true;
    }
  });
}

const outputs = new Map<string, THREE.WebGLRenderTarget>();
function output(w: number, h: number): THREE.WebGLRenderTarget {
  const key = `${w}x${h}`;
  let target = outputs.get(key);
  if (!target) {
    target = new THREE.WebGLRenderTarget(w, h);
    outputs.set(key, target);
  }
  return target;
}

/**
 * `object` alone from the current camera on a `size` px canvas, rendered at `k`× and
 * resolved (see `resolve`): RGBA8 rows bottom-up. `jitter` shifts the image by that
 * many supersamples.
 */
export function capture(object: THREE.Object3D, size: number, k = K, jitter = 0): Uint8Array {
  const n = size * k;
  const pixels = new Uint8Array(size * size * 4);
  scene.add(object);
  shadeAtDisplayScale(object, k);
  resolveInputs.k.value = k;
  for (let top = 0; top < n; top += TILE)
    for (let left = 0; left < n; left += TILE) {
      const w = Math.min(TILE, n - left);
      const h = Math.min(TILE, n - top);
      camera.setViewOffset(n, n, left + jitter, top + jitter, w, h);
      const [black, white] = msaaPair(w, h);
      for (const [target, clear] of [
        [black, 0x000000],
        [white, 0xffffff],
      ] as const) {
        renderer.setRenderTarget(target);
        renderer.setClearColor(clear, 1);
        renderer.clear();
        renderer.render(scene, camera);
      }
      const out = output(w / k, h / k);
      resolveInputs.black.value = black.texture;
      resolveInputs.white.value = white.texture;
      renderer.setRenderTarget(out);
      resolve.render(renderer);
      const tile = new Uint8Array((w / k) * (h / k) * 4);
      renderer.readRenderTargetPixels(out, 0, 0, w / k, h / k, tile);
      // The view offset counts rows from the top; GL rows run bottom-up.
      const row0 = (n - top - h) / k;
      for (let y = 0; y < h / k; y++) pixels.set(tile.subarray(y * (w / k) * 4, (y + 1) * (w / k) * 4), ((row0 + y) * size + left / k) * 4);
    }
  camera.clearViewOffset();
  renderer.setRenderTarget(null);
  scene.remove(object);
  return pixels;
}
