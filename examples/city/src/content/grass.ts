import * as THREE from "three";
import { foliage } from "./foliage.ts";
import { Random } from "./random.ts";
import type { groundShading } from "./terrain.ts";

export interface ClumpShape {
  /** Edge of the square patch the blades grow in (m). */
  size: number;
  blades: number;
  /** Blade height range (m). */
  height: [number, number];
  /** Blade width at the base (m). */
  width: number;
}

/**
 * A square patch of grass blades, the patch centred on the origin on y = 0: each blade a
 * tapering strip of four segments that leans and bends over to a random side. `blade`
 * holds each vertex's blade root (x, z in the patch) and how far up the blade it is (0–1),
 * for `grassMaterial`.
 */
export function grassClump(seed: number, s: ClumpShape): THREE.BufferGeometry {
  const r = new Random(seed);
  const position: number[] = [];
  const normal: number[] = [];
  const blade: number[] = [];
  const index: number[] = [];
  const segments = 4;
  for (let b = 0; b < s.blades; b++) {
    const x = r.range(-s.size / 2, s.size / 2);
    const z = r.range(-s.size / 2, s.size / 2);
    const height = r.range(s.height[0], s.height[1]);
    const facing = r.range(0, Math.PI * 2);
    const lean = r.range(0.05, 0.5);
    const bend = r.range(0.3, 1.2);
    const lateral = new THREE.Vector3(Math.cos(facing), 0, Math.sin(facing));
    const forward = new THREE.Vector3(-lateral.z, 0, lateral.x);
    const width = s.width * r.range(0.7, 1.3);
    const first = position.length / 3;
    const p = new THREE.Vector3(x, 0, z);
    for (let k = 0; k <= segments; k++) {
      const t = k / segments;
      const half = (width / 2) * (1 - t) ** 0.8;
      // up the blade, curving over toward `forward`
      const angle = lean + bend * t * t;
      const along = new THREE.Vector3(0, Math.cos(angle), 0).addScaledVector(forward, Math.sin(angle));
      const n = new THREE.Vector3().crossVectors(lateral, along).normalize();
      // lit mostly as the ground below is: blades pointing at the sky read as a meadow, not as glints
      n.lerp(new THREE.Vector3(0, 1, 0), 0.6).normalize();
      for (const side of [-1, 1]) {
        position.push(p.x + lateral.x * side * half, p.y, p.z + lateral.z * side * half);
        normal.push(n.x, n.y, n.z);
        blade.push(x, z, t);
      }
      p.addScaledVector(along, height / segments);
    }
    for (let k = 0; k < segments; k++) {
      const a = first + k * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute("blade", new THREE.Float32BufferAttribute(blade, 3));
  g.setIndex(index);
  return g;
}

/**
 * Blades coloured by the ground they grow from (`cityGround` at their root, see
 * `groundShading`): darker at the base, a little lighter and drier at the tips, each
 * blade a touch different. Two-sided, translucent in the sun.
 */
export function grassMaterial(ground: ReturnType<typeof groundShading>): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ name: "grass", roughness: 0.75, side: THREE.DoubleSide });
  foliage(m, { translucency: 0.5 });
  const leaf = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    leaf.call(m, shader, renderer);
    Object.assign(shader.uniforms, ground.uniforms);
    shader.vertexShader = `attribute vec3 blade;\nvarying vec2 vRoot;\nvarying float vAlong;\nvarying float vBlade;\n${shader.vertexShader}`.replace(
      "#include <worldpos_vertex>",
      /* glsl */ `#include <worldpos_vertex>
      {
        mat4 model = modelMatrix;
        #ifdef USE_INSTANCING
          model = modelMatrix * instanceMatrix;
        #endif
        vRoot = (model * vec4(blade.x, 0.0, blade.y, 1.0)).xz;
        vAlong = blade.z;
        vBlade = fract(sin(dot(blade.xy, vec2(127.1, 311.7))) * 43758.5453);
      }`,
    );
    shader.fragmentShader = `varying vec2 vRoot;\nvarying float vAlong;\nvarying float vBlade;\n${ground.glsl}\n${shader.fragmentShader}`.replace(
      "#include <map_fragment>",
      /* glsl */ `{
        vec3 base = cityGround(vRoot, distance(cameraPosition, vec3(vRoot.x, cameraPosition.y, vRoot.y)));
        float lift = mix(0.5, 1.25, smoothstep(0.0, 1.0, vAlong));
        // one blade in six is dry: straw at the tip
        float dry = step(0.83, vBlade) * smoothstep(0.3, 1.0, vAlong);
        vec3 tip = mix(base, base * vec3(1.15, 1.08, 0.8), smoothstep(0.6, 1.0, vAlong) * vBlade);
        tip = mix(tip, vec3(dot(base, vec3(0.3, 0.59, 0.11))) * vec3(1.6, 1.35, 0.8), dry * 0.7);
        diffuseColor.rgb *= tip * lift * (0.8 + 0.4 * fract(vBlade * 7.13));
      }`,
    );
  };
  m.customProgramCacheKey = () => `grass-${ground.key}`;
  return m;
}
