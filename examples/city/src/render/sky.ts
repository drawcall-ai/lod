import * as THREE from "three/webgpu";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { assetUrl, manifest } from "../content/materials.ts";
import { bundle, file } from "../world/cache.ts";
import { number, numbers, record } from "../world/data.ts";

/** The HDRI split into image-based light without its sun, and the sun as a direction and irradiance. */
interface Sky {
  /** The HDRI as shot, for the background. */
  background: THREE.DataTexture;
  /** Prefiltered light: the sky with the sun cut out and a ground below the horizon. */
  environment: THREE.Texture;
  /** Rotation about y applied to background and environment so the sun stands at the requested azimuth. */
  turn: number;
  /** Toward the sun, after the turn. */
  sun: THREE.Vector3;
  /** The sun's irradiance (the directional light's intensity). */
  irradiance: number;
  /** Mean radiance of the sky just above the horizon (linear), the colour distant haze fades to. */
  horizon: THREE.Color;
}

/** Loads the manifest's HDRI and turns it so the sun stands at `azimuth` (radians, atan2(z, x) of the direction toward it). */
export async function loadSky(renderer: THREE.Renderer, azimuth: number): Promise<Sky> {
  let built: { background: THREE.DataTexture; environment: THREE.Texture } | undefined;
  const files = await bundle(
    "sky@1",
    {
      hdr: { path: `assets/${manifest().hdri.file}` },
      sky: { path: "src/render/sky.ts" },
      three: { package: "three" },
      backend: { value: renderer.coordinateSystem },
    },
    async () => {
      const hdr = await new HDRLoader().setDataType(THREE.FloatType).loadAsync(assetUrl(manifest().hdri.file));
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const { sky, direction, irradiance, horizon } = removeSun(hdr);
      const pmrem = new THREE.PMREMGenerator(renderer);
      const environment = pmrem.fromEquirectangular(sky);
      const pixels = await renderer.readRenderTargetPixelsAsync(environment, 0, 0, environment.width, environment.height);
      if (!(pixels instanceof Uint16Array)) throw new Error("Expected half-float PMREM pixels");
      pmrem.dispose();
      sky.dispose();
      built = { background: hdr, environment: environment.texture };
      const backgroundPixels = hdr.image.data;
      if (!(backgroundPixels instanceof Float32Array)) throw new Error("Expected float HDR pixels");
      const [background, lighting] = await Promise.all([compress(backgroundPixels), compress(pixels)]);
      return {
        background,
        lighting,
        metadata: new TextEncoder().encode(
          JSON.stringify({
            background: [hdr.image.width, hdr.image.height],
            environment: [environment.width, environment.height],
            direction: direction.toArray(),
            irradiance,
            horizon: horizon.toArray(),
          }),
        ),
      };
    },
  );
  const data = record(JSON.parse(new TextDecoder().decode(file(files, "metadata"))));
  const direction = new THREE.Vector3().fromArray(numbers(data.direction, 3));
  const turn = Math.atan2(direction.z, direction.x) - azimuth;
  const textures = built ?? (await decode(renderer, files, dimensions(data.background), dimensions(data.environment)));
  return {
    ...textures,
    turn,
    sun: direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), turn),
    irradiance: number(data.irradiance),
    horizon: new THREE.Color().fromArray(numbers(data.horizon, 3)),
  };
}

async function decode(renderer: THREE.Renderer, files: Record<string, Uint8Array>, backgroundSize: [number, number], environmentSize: [number, number]) {
  const [backgroundBytes, environmentBytes] = await Promise.all([decompress(file(files, "background")), decompress(file(files, "lighting"))]);
  const [width, height] = backgroundSize;
  const [lightWidth, lightHeight] = environmentSize;
  if (backgroundBytes.byteLength !== width * height * 16 || environmentBytes.byteLength !== lightWidth * lightHeight * 8)
    throw new Error("Cached sky texture dimensions do not match its pixels");
  const background = new THREE.DataTexture(new Float32Array(backgroundBytes), width, height, THREE.RGBAFormat, THREE.FloatType);
  background.mapping = THREE.EquirectangularReflectionMapping;
  background.colorSpace = THREE.LinearSRGBColorSpace;
  background.minFilter = background.magFilter = THREE.LinearFilter;
  background.flipY = true;
  background.needsUpdate = true;
  const pixels = new THREE.DataTexture(new Uint16Array(environmentBytes), lightWidth, lightHeight, THREE.RGBAFormat, THREE.HalfFloatType);
  pixels.needsUpdate = true;
  const environment = new THREE.RenderTarget(lightWidth, lightHeight, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
  });
  environment.texture.mapping = THREE.CubeUVReflectionMapping;
  // Three's PMREM sampling flips a render target's direction and UV; retain both conventions.
  renderer.initRenderTarget(environment);
  renderer.copyTextureToTexture(pixels, environment.texture);
  pixels.dispose();
  return { background, environment: environment.texture };
}

function dimensions(value: unknown): [number, number] {
  const [width, height] = numbers(value, 2);
  if (width === undefined || height === undefined || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new Error("Invalid cached sky dimensions");
  return [width, height];
}

async function compress(data: ArrayBufferView): Promise<Uint8Array> {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

async function decompress(bytes: Uint8Array): Promise<ArrayBuffer> {
  return new Response(new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

/**
 * Splits an equirectangular HDR into sky (pixels clamped to `limit`) and sun: the clamped
 * energy integrated over solid angle is the sun's irradiance, its brightest pixel the direction.
 */
function removeSun(hdr: THREE.DataTexture, limit = 20) {
  const { data, width, height } = hdr.image;
  if (!(data instanceof Float32Array)) throw new Error("expected a float HDR");
  const sky = new Float32Array(data);
  const luminance = (i: number) => 0.2126 * (sky[i] ?? 0) + 0.7152 * (sky[i + 1] ?? 0) + 0.0722 * (sky[i + 2] ?? 0);
  let irradiance = 0;
  let best = 0;
  let at = 0;
  for (let i = 0; i < width * height; i++) {
    const lum = luminance(i * 4);
    if (lum > best) {
      best = lum;
      at = i;
    }
    if (lum <= limit) continue;
    const latitude = (0.5 - (Math.floor(i / width) + 0.5) / height) * Math.PI;
    irradiance += (lum - limit) * ((2 * Math.PI) / width) * (Math.PI / height) * Math.cos(latitude);
    for (let c = 0; c < 3; c++) sky[i * 4 + c] = (sky[i * 4 + c] ?? 0) * (limit / lum);
  }
  // A "puresky" HDRI continues the sky below the horizon, which would light everything from
  // underneath. Replace that half with ground: radiance of a 20 % albedo surface under the
  // sun and the upper sky.
  const direction = equirectDirection(at % width, Math.floor(at / width), width, height);
  let skyIrradiance = 0;
  const horizon = new THREE.Color(0, 0, 0);
  let horizonRows = 0;
  for (let y = 0; y < height / 2; y++) {
    const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
    const nearHorizon = latitude > 0.02 && latitude < 0.1;
    if (nearHorizon) horizonRows++;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      skyIrradiance += luminance(i) * Math.sin(latitude) * Math.cos(latitude) * ((2 * Math.PI) / width) * (Math.PI / height);
      if (nearHorizon) horizon.add(new THREE.Color(sky[i] ?? 0, sky[i + 1] ?? 0, sky[i + 2] ?? 0));
    }
  }
  if (horizonRows === 0) throw new Error("HDRI too small to sample its horizon");
  horizon.multiplyScalar(1 / (horizonRows * width));
  const ground = (0.2 * (skyIrradiance + irradiance * Math.max(0, direction.y))) / Math.PI;
  // grassland: a muted green
  const tint = [0.85, 1.0, 0.65];
  for (let i = (width * height) / 2; i < width * height; i++) for (let c = 0; c < 3; c++) sky[i * 4 + c] = ground * (tint[c] ?? 1);
  const texture = new THREE.DataTexture(sky, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.flipY = hdr.flipY;
  texture.needsUpdate = true;
  return { sky: texture, direction, irradiance, horizon };
}

/** three's equirect lookup is u = atan2(z, x) / 2π + 0.5, v = asin(y) / π + 0.5; image rows run top down. */
function equirectDirection(x: number, y: number, width: number, height: number): THREE.Vector3 {
  const azimuth = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
  const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
  return new THREE.Vector3(Math.cos(azimuth) * Math.cos(latitude), Math.sin(latitude), Math.sin(azimuth) * Math.cos(latitude));
}
