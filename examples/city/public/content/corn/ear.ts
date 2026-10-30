import type { Library } from "../materials.ts";
import * as THREE from "three/webgpu";
import { MeshBuilder, type Parts, tube } from "../geometry.ts";
import type { Random } from "../random.ts";
import { huskMaterial } from "./leaf.ts";
import { type Detail, tissue, tubeSegments } from "./tissue.ts";

/** An ear on a short shank: wrapped husk leaves with flared tips, and a tuft of silk. Returns its middle. */
export function ear(library: Library, parts: Parts, node: THREE.Vector3, stalkDir: THREE.Vector3, azimuth: number, r: Random, detail: Detail): THREE.Vector3 {
  const out = new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
  const axis = stalkDir.clone().multiplyScalar(Math.cos(0.55)).addScaledVector(out, Math.sin(0.55)).normalize();
  const start = node.clone().addScaledVector(out, 0.018);
  const shankEnd = start.clone().addScaledVector(axis, 0.05);
  const husk = new THREE.Color("#7f9a52");
  parts.add(
    tissue(library),
    tube(
      new THREE.LineCurve3(start, shankEnd),
      () => 0.008,
      4,
      8,
      () => husk,
    ),
  );
  const length = r.range(0.2, 0.25);
  const core = (t: number) => 0.024 * Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.88)) ** 0.55 * (1 - 0.35 * t);
  const sideA = new THREE.Vector3().crossVectors(axis, out).normalize();
  const sideB = new THREE.Vector3().crossVectors(axis, sideA).normalize();
  const layers = 7;
  for (let l = 0; l < layers; l++) {
    const b = new MeshBuilder();
    const center = r.range(0, Math.PI * 2);
    const span = r.range(2.2, 3.4);
    const extra = r.range(1.0, 1.28);
    // the husk texture carries the colour; vertex colour only varies it, outer leaves paler
    const c = new THREE.Color("#ffffff").lerp(new THREE.Color("#fff2c0"), 0.2 + 0.08 * l).multiplyScalar(r.range(0.92, 1.05));
    const rows: number[][] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const along = t * length * extra;
      const tc = Math.min(1, along / length);
      const rad =
        (core(tc) + 0.0012 * (layers - l)) * (t * extra > 1 ? Math.max(0.15, 1 - (t * extra - 1) * 2.5) : 1) +
        (t * extra > 0.95 ? (t * extra - 0.95) * 0.06 : 0);
      const width = span * (1 - Math.max(0, t - 0.55) / 0.45) ** 0.8;
      const row: number[] = [];
      for (let k = 0; k <= 6; k++) {
        const a = center + (k / 6 - 0.5) * width;
        const p = shankEnd
          .clone()
          .addScaledVector(axis, along)
          .addScaledVector(sideA, Math.cos(a) * rad)
          .addScaledVector(sideB, Math.sin(a) * rad);
        row.push(b.vertex(p, k / 6, t, c));
      }
      rows.push(row);
    }
    for (let i = 0; i < 16; i++) {
      const a = rows[i];
      const d = rows[i + 1];
      if (!a || !d) break;
      for (let k = 0; k < 6; k++) b.quad(a[k] ?? 0, a[k + 1] ?? 0, d[k + 1] ?? 0, d[k] ?? 0);
    }
    parts.add(huskMaterial(library), b.geometry());
  }
  const tip = shankEnd.clone().addScaledVector(axis, length * 1.02);
  const silk = r.int(24, 40);
  for (let i = 0; i < silk; i++) {
    // the field's plants keep every third strand: the tuft reads the same from a metre
    const drawn = detail === "fine" || i % 3 === 0;
    const a = r.range(0, Math.PI * 2);
    const spread = sideA.clone().multiplyScalar(Math.cos(a)).addScaledVector(sideB, Math.sin(a));
    const len = r.range(0.04, 0.11);
    const from = tip.clone().addScaledVector(spread, r.range(0, 0.004));
    const mid = from
      .clone()
      .addScaledVector(axis, len * 0.5)
      .addScaledVector(spread, len * 0.35);
    const end = mid
      .clone()
      .addScaledVector(spread, len * 0.4)
      .add(new THREE.Vector3(0, -len * r.range(0.3, 0.9), 0));
    const young = new THREE.Color("#d8cf8a");
    const old = new THREE.Color("#8a5a34");
    if (drawn)
      parts.add(
        tissue(library),
        tube(
          new THREE.QuadraticBezierCurve3(from, mid, end),
          () => 0.0006,
          ...tubeSegments(detail, 8, 3),
          (t) => young.clone().lerp(old, Math.min(1, t * 1.3)),
        ),
      );
  }
  return shankEnd.clone().addScaledVector(axis, length / 2);
}
