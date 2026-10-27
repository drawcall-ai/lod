import type * as THREE from "three/webgpu";
import { abs, cameraPosition, dot, exp, float, length, max, mix, output, positionWorld, pow, select, vec3, vec4 } from "three/tsl";

/** How fast the air thins with height (per metre). */
const FALLOFF = 1 / 1700;

/**
 * Aerial perspective for every material, impostors included, as the scene's fog node:
 * height fog. Its density falls off exponentially with height, so a view from 2 km up
 * looks through thin air while the horizon at ground level fades fully into the sky's
 * horizon colour (`tone`); looking toward the sun, the haze brightens with forward
 * scattering. `density` is the density at y = 0 (per metre).
 */
export function haze(tone: THREE.Color, density: number, sun: THREE.Vector3, sunColor: THREE.Color): THREE.Node<"vec4"> {
  // the world-space offset from the camera
  const ray = positionWorld.sub(cameraPosition).toVar();
  const dist = length(ray).toVar();
  const rise = ray.y.mul(FALLOFF).toVar();
  // density integrated along the ray through air thinning with height
  const path = select(abs(rise).greaterThan(1e-4), exp(rise.negate()).oneMinus().div(rise), float(1));
  const depth = exp(max(cameraPosition.y, 0).mul(-FALLOFF)).mul(density).mul(dist).mul(path);
  const amount = exp(depth.negate()).oneMinus();
  const toward = max(dot(ray.div(max(dist, 1e-6)), vec3(sun.x, sun.y, sun.z)), 0);
  const glow = pow(toward, 6).mul(0.15).add(pow(toward, 48).mul(0.35));
  const light = vec3(tone.r, tone.g, tone.b).add(vec3(sunColor.r, sunColor.g, sunColor.b).mul(glow));
  return vec4(mix(output.rgb, light, amount), output.a);
}
