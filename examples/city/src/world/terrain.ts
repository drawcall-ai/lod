import * as THREE from "three";
import { Random } from "../content/random.ts";

/** Half the edge of the detailed square of ground; the world's content lies within it. */
export const EXTENT = 2400;
/** Grid spacing of the detailed ground (m). */
const CELL = 8;
/** How far the coarse ring of ground reaches, to the haze. */
const HORIZON = 40000;

/**
 * Gentle rolling ground. Heights live on a grid and between grid points are interpolated
 * over the same two triangles per cell as the mesh draws, so anything placed with
 * `height` stands exactly on the drawn surface. The relief fades to flat toward the edge
 * of the detailed square, where a coarse flat ring takes over, and the ground is at
 * y = 0 at the origin, where the smallest detail lives.
 */
export class Terrain {
  private readonly cells = Math.round((2 * EXTENT) / CELL);
  private readonly heights: Float32Array;

  /**
   * `flats` are sites the relief eases off around (the town, fields); `creek` cuts a
   * valley along its course, `depth` deep, except within 40 m of each `crossing` (where a
   * road passes over it at grade).
   */
  constructor(seed: number, flats: { x: number; z: number; radius: number }[], creek: { course: THREE.Vector2[]; depth: number; crossings: THREE.Vector2[] }) {
    const n = this.cells + 1;
    this.heights = new Float32Array(n * n);
    const waves = new Random(seed);
    const terms = Array.from({ length: 6 }, (_, i) => {
      const angle = waves.range(0, Math.PI * 2);
      const wavelength = 2600 / 1.7 ** i;
      return {
        kx: (Math.cos(angle) * 2 * Math.PI) / wavelength,
        kz: (Math.sin(angle) * 2 * Math.PI) / wavelength,
        phase: waves.range(0, 6.3),
        amplitude: 12 / 1.6 ** i,
      };
    });
    const raw = (x: number, z: number) => {
      let h = 0;
      for (const t of terms) h += t.amplitude * Math.sin(t.kx * x + t.kz * z + t.phase);
      // flatten toward the edge, and wherever a flat site (the town) needs it
      let keep = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(x), Math.abs(z)), EXTENT * 0.8, EXTENT * 0.97);
      for (const f of flats) keep *= 0.25 + 0.75 * THREE.MathUtils.smoothstep(Math.hypot(x - f.x, z - f.z), f.radius * 0.6, f.radius * 1.3);
      // the creek's valley: a broad trough with the channel in its floor
      const d = distanceTo(creek.course, x, z);
      let cut = creek.depth * Math.exp(-((d / 35) ** 2)) + 0.8 * Math.exp(-((d / 4) ** 2));
      for (const c of creek.crossings) cut *= THREE.MathUtils.smoothstep(Math.hypot(x - c.x, z - c.y), 20, 40);
      return h * keep - cut;
    };
    const base = raw(0, 0);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++)
        this.heights[j * n + i] = raw(-EXTENT + i * CELL, -EXTENT + j * CELL) - base * this.fade(-EXTENT + i * CELL, -EXTENT + j * CELL);
  }

  /** The origin offset fades out with the relief, so the outer ring stays at y = 0. */
  private fade(x: number, z: number): number {
    return 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(x), Math.abs(z)), EXTENT * 0.8, EXTENT * 0.97);
  }

  private at(i: number, j: number): number {
    const n = this.cells + 1;
    return this.heights[THREE.MathUtils.clamp(j, 0, this.cells) * n + THREE.MathUtils.clamp(i, 0, this.cells)] ?? 0;
  }

  /** Ground height at x, z, exactly on the drawn mesh; 0 outside the detailed square. */
  height(x: number, z: number): number {
    const u = (x + EXTENT) / CELL;
    const v = (z + EXTENT) / CELL;
    if (u < 0 || v < 0 || u >= this.cells || v >= this.cells) return 0;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fx = u - i;
    const fz = v - j;
    // each cell is split along its diagonal from (i, j + 1) to (i + 1, j), as in `mesh`
    if (fx + fz <= 1) {
      const h00 = this.at(i, j);
      return h00 + (this.at(i + 1, j) - h00) * fx + (this.at(i, j + 1) - h00) * fz;
    }
    const h11 = this.at(i + 1, j + 1);
    return h11 + (this.at(i, j + 1) - h11) * (1 - fx) + (this.at(i + 1, j) - h11) * (1 - fz);
  }

  /** Slope of the ground: dh/dx and dh/dz at x, z. */
  slope(x: number, z: number): THREE.Vector2 {
    const e = 0.5;
    return new THREE.Vector2((this.height(x + e, z) - this.height(x - e, z)) / (2 * e), (this.height(x, z + e) - this.height(x, z - e)) / (2 * e));
  }

  /**
   * The ground as one mesh with UVs in metres: the detailed square, then rings of cells
   * growing outward to the horizon. Grid lines are shared, so the ring meets the square
   * without cracks.
   */
  mesh(material: THREE.Material): THREE.Mesh {
    const lines = [-EXTENT];
    for (let i = 1; i <= this.cells; i++) lines.push(-EXTENT + i * CELL);
    let step = CELL * 4;
    const outer: number[] = [];
    for (let at = EXTENT + step; at < HORIZON; at += step, step *= 1.25) outer.push(at);
    outer.push(HORIZON);
    const axis = [...outer.map((a) => -a).reverse(), ...lines, ...outer];
    const n = axis.length;
    const position = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const x = axis[i] ?? 0;
        const z = axis[j] ?? 0;
        const k = j * n + i;
        position.set([x, this.height(x, z), z], k * 3);
        uv.set([x, z], k * 2);
      }
    const index: number[] = [];
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        // split along (i, j + 1)–(i + 1, j); counter-clockwise seen from above (+y)
        index.push(a, c, b, b, c, d);
      }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "terrain";
    mesh.receiveShadow = true;
    return mesh;
  }
}

/** Distance from x, z to a polyline. */
function distanceTo(line: THREE.Vector2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dz = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.y) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - a.x - t * dx, z - a.y - t * dz));
  }
  return best;
}
