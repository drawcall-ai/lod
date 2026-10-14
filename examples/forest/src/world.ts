import * as THREE from "three";

// The static world: rolling ground, sky dome and fog, and the light rig. Everything
// here is deterministic so screenshots are comparable between runs.

export const WORLD_SIZE = 1500;
export const HORIZON = new THREE.Color(0xc4d3dc);
const ZENITH = new THREE.Color(0x5d8fc4);
export const SUN_DIRECTION = new THREE.Vector3(-0.55, 0.62, -0.56).normalize();

/** Ground height in metres; the ground mesh and every placed object read this. */
export function height(x: number, z: number): number {
  return (
    16 * Math.sin(x / 190 + 0.6) * Math.cos(z / 230 - 0.3) +
    4 * Math.sin((x + z) / 95 + 1.3) +
    1.2 * Math.sin(x / 37 + 2.1) * Math.sin(z / 43 + 0.4)
  );
}

export function createGround(): THREE.Mesh {
  const segments = 600; // 2.5 m quads: interpolation error vs height() stays sub-centimetre
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) position.setY(i, height(position.getX(i), position.getZ(i)));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({ color: 0x5c7d36, roughness: 0.95, metalness: 0 });
  // Mottled grass from world-space value noise: two scales of brightness and a
  // low-frequency shift toward dry grass. Cheap, and it breaks up the flat colour.
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGroundWorld;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vGroundWorld;
float groundHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float groundNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(groundHash(i), groundHash(i + vec2(1, 0)), f.x), mix(groundHash(i + vec2(0, 1)), groundHash(i + vec2(1, 1)), f.x), f.y);
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
{
  vec2 p = vGroundWorld.xz;
  float dry = smoothstep(0.35, 0.8, groundNoise(p * 0.012) * 0.7 + groundNoise(p * 0.05) * 0.3);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.50, 0.48, 0.28), dry * 0.4);
  diffuseColor.rgb *= 0.82 + 0.3 * groundNoise(p * 0.35) * groundNoise(p * 1.7 + 3.0);
}`,
      );
  };
  const ground = new THREE.Mesh(geometry, material);
  ground.receiveShadow = true;
  ground.name = "ground";
  return ground;
}

/** A dome that follows the camera: horizon matches the fog, a soft glow around the sun. */
export function createSky(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      horizon: { value: HORIZON.clone() },
      zenith: { value: ZENITH.clone() },
      sun: { value: SUN_DIRECTION.clone() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w; // on the far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 horizon;
      uniform vec3 zenith;
      uniform vec3 sun;
      varying vec3 vDirection;
      void main() {
        vec3 d = normalize(vDirection);
        vec3 c = mix(horizon, zenith, pow(clamp(d.y, 0.0, 1.0), 0.55));
        float s = max(dot(d, sun), 0.0);
        c += vec3(1.0, 0.92, 0.75) * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.18);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), material);
  sky.name = "sky";
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

/**
 * A sun whose shadow map covers a square around a focus point. Call `follow` every
 * frame: the shadow camera is snapped to whole texels so shadows do not crawl as the
 * camera moves. `extent` can grow (e.g. with altitude); it is quantised so it only
 * changes in steps.
 */
export function createSun(mapSize: number) {
  const light = new THREE.DirectionalLight(0xfff1dc, 2.6);
  light.castShadow = true;
  light.shadow.mapSize.set(mapSize, mapSize);
  light.shadow.bias = -0.0004;
  light.shadow.normalBias = 0.04;

  // Light-space basis for texel snapping.
  const forward = SUN_DIRECTION.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward);
  const focus = new THREE.Vector3();
  let extent = 0;

  function follow(point: THREE.Vector3, size: number): void {
    const quantised = Math.floor(size / 25) * 25;
    if (quantised !== extent) {
      extent = quantised;
      const half = extent / 2;
      Object.assign(light.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 200 + extent });
      light.shadow.camera.updateProjectionMatrix();
    }
    const texel = extent / mapSize;
    const r = Math.round(point.dot(right) / texel) * texel;
    const u = Math.round(point.dot(up) / texel) * texel;
    const f = point.dot(forward);
    focus.copy(right).multiplyScalar(r).addScaledVector(up, u).addScaledVector(forward, f);
    light.target.position.copy(focus);
    light.position.copy(focus).addScaledVector(SUN_DIRECTION, 100 + extent / 2);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
  }
  return { light, follow };
}

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 2D value noise in 0..1, for placement density and species patches. */
export function noise2(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const a = h(ix, iz) + (h(ix + 1, iz) - h(ix, iz)) * sx;
  const b = h(ix, iz + 1) + (h(ix + 1, iz + 1) - h(ix, iz + 1)) * sx;
  return a + (b - a) * sz;
}
