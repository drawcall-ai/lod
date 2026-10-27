import type { Node } from "three/webgpu";
import { Fn, floor, fract, mix, vec2, vec3 } from "three/tsl";

/**
 * Value noise in [0, 1] (3D, and a cheaper 2D one) and a 4-octave 2D fbm, shared by the
 * procedural shading, each a function of its own in the shader. Each fbm octave is
 * rotated: value noise flattens out along its lattice lines, and unrotated octaves stack
 * those lines into a visible grid on large flat surfaces.
 */

const hash3 = Fn(
  ([q]: [Node<"vec3">]) => {
    const p = fract(q.mul(0.3183099).add(0.1)).mul(17);
    return fract(p.x.mul(p.y).mul(p.z).mul(p.x.add(p.y).add(p.z)));
  },
  { q: "vec3", return: "float" },
);

export const noise3 = Fn(
  ([x]: [Node<"vec3">]) => {
    const i = floor(x).toVar();
    const t = fract(x);
    const f = t.mul(t).mul(t.mul(-2).add(3)).toVar();
    const at = (dx: number, dy: number, dz: number) => hash3(i.add(vec3(dx, dy, dz)));
    const near = mix(mix(at(0, 0, 0), at(1, 0, 0), f.x), mix(at(0, 1, 0), at(1, 1, 0), f.x), f.y);
    const far = mix(mix(at(0, 0, 1), at(1, 0, 1), f.x), mix(at(0, 1, 1), at(1, 1, 1), f.x), f.y);
    return mix(near, far, f.z);
  },
  { x: "vec3", return: "float" },
);

const hash2 = Fn(
  ([q]: [Node<"vec2">]) => {
    const p = fract(q.mul(0.3183099).add(0.1)).mul(17);
    return fract(p.x.mul(p.y).mul(p.x.add(p.y)));
  },
  { q: "vec2", return: "float" },
);

export const noise2 = Fn(
  ([x]: [Node<"vec2">]) => {
    const i = floor(x).toVar();
    const t = fract(x);
    const f = t.mul(t).mul(t.mul(-2).add(3)).toVar();
    const at = (dx: number, dy: number) => hash2(i.add(vec2(dx, dy)));
    return mix(mix(at(0, 0), at(1, 0), f.x), mix(at(0, 1), at(1, 1), f.x), f.y);
  },
  { x: "vec2", return: "float" },
);

export const fbm = Fn(
  ([start]: [Node<"vec2">]) => {
    let p: Node<"vec2"> = start;
    let sum: Node<"float"> = noise2(p).mul(0.5);
    for (const amp of [0.25, 0.125, 0.0625]) {
      // turned by (0.8, 0.6) and scaled by 2.03 per octave
      p = vec2(p.x.mul(0.8).sub(p.y.mul(0.6)), p.x.mul(0.6).add(p.y.mul(0.8))).mul(2.03).add(17).toVar();
      sum = sum.add(noise2(p).mul(amp));
    }
    return sum.div(0.9375);
  },
  { start: "vec2", return: "float" },
);
