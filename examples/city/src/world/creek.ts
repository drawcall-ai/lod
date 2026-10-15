import * as THREE from "three";
import type { Random } from "../content/random.ts";
import { smooth } from "./country.ts";
import { type Land, Use } from "./land.ts";
import { type Spot, spot } from "./plan.ts";
import type { Terrain } from "./terrain.ts";

/** The creek's course across the north of the map, west to east, its valley's depth and its water's width. */
export const CREEK = {
  course: smooth(
    [
      [-2350, 1600],
      [-1700, 1380],
      [-1100, 1250],
      [-650, 1180],
      [-300, 1050],
      [150, 990],
      [700, 950],
      [1150, 1060],
      [1500, 1150],
      [1950, 1020],
      [2350, 900],
    ].map(([x = 0, z = 0]) => new THREE.Vector2(x, z)),
    30,
  ),
  depth: 4,
  width: 5,
};

/** Where `a` and `b` (polylines) cross. */
export function crossings(a: THREE.Vector2[], b: THREE.Vector2[]): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i + 1 < a.length; i++)
    for (let j = 0; j + 1 < b.length; j++) {
      const p = a[i];
      const p2 = a[i + 1];
      const q = b[j];
      const q2 = b[j + 1];
      if (!p || !p2 || !q || !q2) continue;
      const r = p2.clone().sub(p);
      const s = q2.clone().sub(q);
      const denominator = r.cross(s);
      if (Math.abs(denominator) < 1e-9) continue;
      const t = q.clone().sub(p).cross(s) / denominator;
      const u = q.clone().sub(p).cross(r) / denominator;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push(p.clone().addScaledVector(r, t));
    }
  return out;
}

/** Marks the water on the land and plants the banks: willowy shrubs and trees in a broken line on both sides. */
export function banks(land: Land, terrain: Terrain, r: Random, add: (id: string, spot: Spot) => void): void {
  const course = CREEK.course;
  course.forEach((p, i) => {
    const q = course[i + 1];
    if (q) land.strip(Use.Water, p.x, p.y, q.x, q.y, CREEK.width + 2);
  });
  for (let i = 0; i + 1 < course.length; i++) {
    const p = course[i];
    const q = course[i + 1];
    if (!p || !q) continue;
    const dir = q.clone().sub(p);
    const length = dir.length();
    dir.normalize();
    for (let t = 0; t < length; t += 6)
      for (const side of [1, -1]) {
        if (!r.chance(0.6)) continue;
        const at = p
          .clone()
          .addScaledVector(dir, t)
          .add(new THREE.Vector2(-dir.y, dir.x).multiplyScalar(side * r.range(5, 13)));
        const use = land.at(at.x, at.y);
        if (use !== Use.Lawn && use !== Use.Crop) continue;
        const pick = r.next();
        const angle = r.range(0, Math.PI * 2);
        if (pick < 0.45) add("searsia_lucida", spot(terrain, at.x, at.y, angle, r.range(1.6, 2.4)));
        else if (pick < 0.8) add("tree_small_02", spot(terrain, at.x, at.y, angle, r.range(2.2, 3.1)));
        else add("shrub_02", spot(terrain, at.x, at.y, angle, r.range(1.2, 1.8)));
      }
  }
}

/** The water: a ribbon along the course, half a metre above the channel's floor, reflecting the sky. */
export function water(terrain: Terrain): THREE.Mesh {
  const line: THREE.Vector2[] = [];
  CREEK.course.forEach((p, i) => {
    const q = CREEK.course[i + 1];
    if (!q) return line.push(p);
    const n = Math.ceil(p.distanceTo(q) / 4);
    for (let k = 0; k < n; k++) line.push(p.clone().lerp(q, k / n));
  });
  const position: number[] = [];
  const index: number[] = [];
  line.forEach((p, i) => {
    const prev = line[i - 1] ?? p;
    const next = line[i + 1] ?? p;
    const dir = next.clone().sub(prev).normalize();
    // the water's width wanders a little
    const half = (CREEK.width / 2) * (0.8 + 0.4 * Math.sin(i * 0.37) * Math.sin(i * 0.11));
    const y = terrain.height(p.x, p.y) + 0.5;
    for (const s of [-1, 1]) position.push(p.x - dir.y * s * half, y, p.y + dir.x * s * half);
    if (i + 1 < line.length) index.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  const material = new THREE.MeshPhysicalMaterial({ name: "water", color: "#14302b", roughness: 0.06, metalness: 0, ior: 1.33 });
  const mesh = new THREE.Mesh(g, material);
  mesh.name = "creek";
  mesh.receiveShadow = true;
  return mesh;
}
