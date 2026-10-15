import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { assetUrl, manifest } from "../content/materials.ts";

/** The HDRI split into image-based light without its sun, and the sun as a direction and irradiance. */
export interface Sky {
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
export async function loadSky(renderer: THREE.WebGLRenderer, azimuth: number): Promise<Sky> {
  const hdr = await new HDRLoader().setDataType(THREE.FloatType).loadAsync(assetUrl(manifest().hdri.file));
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const { sky, direction, irradiance, horizon } = removeSun(hdr);
  const turn = Math.atan2(direction.z, direction.x) - azimuth;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromEquirectangular(sky).texture;
  pmrem.dispose();
  sky.dispose();
  return { background: hdr, environment, turn, sun: direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), turn), irradiance, horizon };
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
