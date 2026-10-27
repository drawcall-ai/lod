import * as THREE from "three/webgpu";
import { box, type Parts } from "../geometry.ts";
import type { Random } from "../random.ts";
import { brass, glass } from "./materials.ts";
import type { Opening } from "./wall.ts";

/** Materials an opening is dressed with; null leaves the feature out. */
export interface Dressing {
  frame: THREE.Material;
  sill: THREE.Material;
  /** Raised render band around the opening (stucco houses). */
  surround: THREE.Material | null;
  /** Soldier-course lintel above the opening (brick houses). */
  lintel: THREE.Material | null;
  shutters: THREE.Material | null;
}

/** How deep the window frame sits behind the outer wall face. */
const inset = 0.11;

/** A casement window in a wall frame (outer face z = 0): frame, sashes, glass, sill and trim. */
export function windowUnit(parts: Parts, o: Opening, d: Dressing, r: Random) {
  const fw = 0.068;
  const fd = 0.075;
  const z = -inset - fd / 2;
  rectFrame(parts, d.frame, o.x, o.y, o.w, o.h, fw, fd, z);

  const sashes = o.w > 0.85 ? 2 : 1;
  const sw = (o.w - 2 * fw) / sashes;
  const sh = o.h - 2 * fw;
  const bars = o.h > 1.1 && r.chance(0.5);
  for (let i = 0; i < sashes; i++) {
    const cx = o.x - o.w / 2 + fw + sw * (i + 0.5);
    const cy = o.y + fw;
    rectFrame(parts, d.frame, cx, cy, sw, sh, 0.058, 0.06, z + 0.012, 0.075);
    const gw = sw - 2 * 0.058;
    const gh = sh - 0.058 - 0.075;
    parts.add(glass(), box(gw, gh, 0.006).translate(cx, cy + 0.075 + gh / 2, z + 0.01));
    if (bars) {
      parts.add(d.frame, box(0.024, gh, 0.03).translate(cx, cy + 0.075 + gh / 2, z + 0.022));
      for (const f of [1 / 3, 2 / 3]) parts.add(d.frame, box(gw, 0.024, 0.03).translate(cx, cy + 0.075 + gh * f, z + 0.022));
    }
  }
  // the sill sheds water past the wall face
  parts.add(d.sill, box(o.w + 0.12, 0.035, inset + 0.07).translate(o.x, o.y - 0.0175, (0.07 - inset) / 2));

  if (d.surround) {
    const b = 0.13;
    const p = 0.018;
    parts.add(d.surround, box(b, o.h + b, p).translate(o.x - o.w / 2 - b / 2, o.y + (o.h + b) / 2, p / 2));
    parts.add(d.surround, box(b, o.h + b, p).translate(o.x + o.w / 2 + b / 2, o.y + (o.h + b) / 2, p / 2));
    parts.add(d.surround, box(o.w + 2 * b + 0.06, b + 0.04, p + 0.012).translate(o.x, o.y + o.h + (b + 0.04) / 2, (p + 0.012) / 2));
  }
  if (d.lintel) parts.add(d.lintel, soldierCourse(o.w + 0.2).translate(o.x, o.y + o.h + 0.11, 0.004));
  if (d.shutters) {
    for (const side of [-1, 1]) shutter(parts, d.shutters, o.x + side * (o.w / 2 + o.w / 4 + 0.04), o.y, o.w / 2 + 0.02, o.h);
  }
}

/** Four bars around a rectangle whose bottom edge is at y; `bottom` widens the lower rail. */
function rectFrame(parts: Parts, m: THREE.Material, x: number, y: number, w: number, h: number, bar: number, depth: number, z: number, bottom = bar) {
  parts.add(m, box(bar, h, depth).translate(x - w / 2 + bar / 2, y + h / 2, z));
  parts.add(m, box(bar, h, depth).translate(x + w / 2 - bar / 2, y + h / 2, z));
  parts.add(m, box(w - 2 * bar, bar, depth).translate(x, y + h - bar / 2, z));
  parts.add(m, box(w - 2 * bar, bottom, depth).translate(x, y + bottom / 2, z));
}

/** Bricks on end above an opening: a box whose UVs are turned a quarter so courses run vertically. */
function soldierCourse(w: number): THREE.BufferGeometry {
  const g = box(w, 0.215, 0.008);
  const uv = g.getAttribute("uv");
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i), uv.getX(i));
  return g;
}

/** A louvred shutter folded back against the wall. */
function shutter(parts: Parts, m: THREE.Material, x: number, y: number, w: number, h: number) {
  const z = 0.03;
  rectFrame(parts, m, x, y, w, h, 0.055, 0.032, z);
  const slat = 0.048;
  const count = Math.floor((h - 0.11) / (slat * 0.8));
  for (let i = 0; i < count; i++) {
    const g = box(w - 0.11, slat, 0.008).rotateX(-0.75);
    parts.add(m, g.translate(x, y + 0.055 + (i + 0.5) * ((h - 0.11) / count), z));
  }
}

/** A panelled front door with frame, glazed top light, handle and steps down to the ground. */
export function doorUnit(parts: Parts, o: Opening, frame: THREE.Material, leaf: THREE.Material, stone: THREE.Material, wallThickness: number) {
  const fw = 0.08;
  const z = -0.14;
  rectFrame(parts, frame, o.x, o.y, o.w, o.h + fw, fw, 0.09, z);
  const lw = o.w - 2 * fw;
  const lh = o.h - fw;
  const lz = z - 0.005;
  const ly = o.y;
  const light = 0.42;
  // stiles and rails of the leaf, with raised panels between them
  rectFrame(parts, leaf, o.x, ly, lw, lh, 0.12, 0.05, lz, 0.2);
  parts.add(leaf, box(lw - 0.24, 0.1, 0.05).translate(o.x, ly + lh - 0.12 - light - 0.05, lz));
  parts.add(glass(), box(lw - 0.24, light, 0.008).translate(o.x, ly + lh - 0.12 - light / 2, lz));
  const ph = (lh - 0.12 - light - 0.1 - 0.2) / 2 - 0.03;
  for (const row of [0, 1]) {
    const py = ly + 0.2 + 0.03 + row * (ph + 0.06) + ph / 2;
    parts.add(leaf, box(lw - 0.24, ph, 0.03).translate(o.x, py, lz));
    parts.add(leaf, box(lw - 0.36, ph - 0.12, 0.05).translate(o.x, py, lz + 0.01));
  }
  parts.add(brass(), box(0.04, 0.2, 0.012).translate(o.x + lw / 2 - 0.08, ly + 1.05, lz + 0.03));
  parts.add(brass(), new THREE.CylinderGeometry(0.011, 0.011, 0.13, 10).rotateZ(Math.PI / 2).translate(o.x + lw / 2 - 0.12, ly + 1.08, lz + 0.07));
  parts.add(brass(), box(0.22, 0.05, 0.012).translate(o.x, ly + 0.9, lz + 0.03));
  // threshold and steps down from the floor level (o.y) to the ground
  parts.add(stone, box(o.w + 0.1, 0.04, wallThickness).translate(o.x, o.y - 0.02, -wallThickness / 2 + 0.02));
  const rise = o.y / Math.max(1, Math.round(o.y / 0.17));
  const steps = Math.round(o.y / rise);
  for (let i = 0; i < steps; i++) {
    const top = o.y - i * rise;
    const depth = 0.55 + i * 0.3;
    parts.add(stone, box(o.w + 0.6 + i * 0.1, top, depth).translate(o.x, top / 2, depth / 2));
  }
}
