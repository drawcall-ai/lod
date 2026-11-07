import type { Library } from "../materials.ts";
import * as THREE from "three/webgpu";
import { type Parts, tint, tube } from "../geometry.ts";
import type { Random } from "../random.ts";
import { type Detail, tissue, tubeSegments } from "./tissue.ts";

/** Branched tassel: a central spike plus drooping side branches, all set with paired spikelets. */
export function tassel(library: Library, parts: Parts, top: THREE.Vector3, dir: THREE.Vector3, length: number, r: Random, detail: Detail) {
  // spikelets 9 mm apart, or for the field's plants three times as far and larger
  const pitch = detail === "fine" ? 0.009 : 0.027;
  const straw = new THREE.Color("#c4ae6a");
  const spike = new THREE.QuadraticBezierCurve3(
    top,
    top.clone().addScaledVector(dir, length * 0.5),
    top
      .clone()
      .addScaledVector(dir, length)
      .add(new THREE.Vector3(r.range(-0.04, 0.04), 0, r.range(-0.04, 0.04))),
  );
  parts.add(
    tissue(library),
    tube(
      spike,
      (t) => 0.0035 * (1 - t * 0.7),
      ...tubeSegments(detail, 16, 6),
      () => straw,
    ),
  );
  spikelets(library, parts, spike, 0.15, r, pitch);
  const branches = r.int(10, 16);
  for (let i = 0; i < branches; i++) {
    // side branches leave the lower third of the central spike
    const at = top.clone().addScaledVector(dir, length * r.range(0.05, 0.35));
    const a = r.range(0, Math.PI * 2);
    const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const len = r.range(0.15, 0.3);
    const rise = r.range(0.4, 0.9);
    const mid = at
      .clone()
      .addScaledVector(out, len * 0.5 * Math.sin(rise))
      .add(new THREE.Vector3(0, len * 0.45 * Math.cos(rise), 0));
    const end = at
      .clone()
      .addScaledVector(out, len * 0.85)
      .add(new THREE.Vector3(0, -len * r.range(0.1, 0.5), 0));
    const curve = new THREE.QuadraticBezierCurve3(at, mid, end);
    parts.add(
      tissue(library),
      tube(
        curve,
        (t) => 0.0018 * (1 - t * 0.5),
        ...tubeSegments(detail, 12, 5),
        () => straw,
      ),
    );
    spikelets(library, parts, curve, 0.2, r, pitch);
  }
}

/** Small paired spikelets hanging along a tassel branch, `pitch` apart. */
function spikelets(library: Library, parts: Parts, curve: THREE.Curve<THREE.Vector3>, skip: number, r: Random, pitch: number) {
  const length = curve.getLength();
  const count = Math.floor((length * (1 - skip)) / pitch);
  const size = pitch / 0.009;
  const pieces: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const t = skip + ((1 - skip) * (i + 0.5)) / count;
    const at = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);
    for (const s of [-1, 1]) {
      const g = new THREE.OctahedronGeometry(1, 0).scale(0.0012 * Math.sqrt(size), 0.0045 * Math.sqrt(size), 0.0012 * Math.sqrt(size));
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        tangent
          .clone()
          .add(new THREE.Vector3(s * 0.4, -0.5, r.range(-0.3, 0.3)))
          .normalize(),
      );
      g.applyQuaternion(q).translate(at.x + s * 0.0015, at.y - 0.002, at.z);
      const c = new THREE.Color("#cdb873").lerp(new THREE.Color(r.chance(0.3) ? "#9a6a58" : "#9fae62"), r.range(0, 0.45));
      pieces.push(tint(g, c));
    }
  }
  if (pieces.length) parts.add(tissue(library), ...pieces);
}
