import * as THREE from "three";

/**
 * Aerial perspective for every material, impostors included: three's fog chunks replaced
 * by height fog. Its density falls off exponentially with height, so a view from 2 km up
 * looks through thin air while the horizon at ground level fades fully into the sky's
 * horizon colour; looking toward the sun, the haze brightens with forward scattering.
 * Driven by a `FogExp2` on the scene: its colour is the haze's, its density the density
 * at y = 0 (per metre). Call before the first material compiles.
 */
export function installHaze(sun: THREE.Vector3, sunColor: THREE.Color): void {
  const glsl = (v: THREE.Vector3 | THREE.Color) =>
    `vec3(${v
      .toArray()
      .map((x) => x.toFixed(5))
      .join(", ")})`;
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
    #ifdef USE_FOG
      varying vec3 vHazeRay;
    #endif`;
  // the world-space offset from the camera: the view rotation's transpose turns view space back
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
    #ifdef USE_FOG
      vHazeRay = transpose(mat3(viewMatrix)) * mvPosition.xyz;
    #endif`;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      uniform float fogDensity;
      varying vec3 vHazeRay;
    #endif`;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
    #ifdef USE_FOG
    {
      const float falloff = 1.0 / 1700.0;
      float dist = length(vHazeRay);
      float rise = falloff * vHazeRay.y;
      // density integrated along the ray through air thinning with height
      float path = abs(rise) > 1e-4 ? (1.0 - exp(-rise)) / rise : 1.0;
      float depth = fogDensity * exp(-falloff * max(cameraPosition.y, 0.0)) * dist * path;
      float amount = 1.0 - exp(-depth);
      float toward = max(dot(vHazeRay / max(dist, 1e-6), ${glsl(sun)}), 0.0);
      vec3 haze = fogColor + ${glsl(sunColor)} * (0.15 * pow(toward, 6.0) + 0.35 * pow(toward, 48.0));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, haze, amount);
    }
    #endif`;
}
