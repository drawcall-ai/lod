import * as THREE from "three/webgpu";
import { type Detail, type Parts, tint, tube, tubeSegments } from "./geometry.ts";
import type seedrandom from "seedrandom";
import type { Materials } from "./materials.ts";

/** Branched tassel: a central spike plus drooping side branches, all set with paired spikelets. */
export function tassel(materials: Materials, parts: Parts, top: THREE.Vector3, dir: THREE.Vector3, length: number, r: seedrandom.PRNG, detail: Detail) {
  // spikelets 9 mm apart, or for the field's plants three times as far and larger
  const pitch = detail === "fine" ? 0.009 : 0.027;
  const straw = new THREE.Color("#c4ae6a");
  const spike = new THREE.QuadraticBezierCurve3(
    top,
    top.clone().addScaledVector(dir, length * 0.5),
    top
      .clone()
      .addScaledVector(dir, length)
      .add(new THREE.Vector3(-0.04 + 0.08 * r(), 0, -0.04 + 0.08 * r())),
  );
  parts.add(
    materials.tissue,
    tube(
      spike,
      (t) => 0.0035 * (1 - t * 0.7),
      ...tubeSegments(detail, 16, 6),
      () => straw,
    ),
  );
  spikelets(materials, parts, spike, 0.15, r, pitch);
  const branches = 10 + Math.floor(7 * r());
  for (let i = 0; i < branches; i++) {
    // side branches leave the lower third of the central spike
    const at = top.clone().addScaledVector(dir, length * (0.05 + 0.3 * r()));
    const a = Math.PI * 2 * r();
    const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const len = 0.15 + 0.15 * r();
    const rise = 0.4 + 0.5 * r();
    const mid = at
      .clone()
      .addScaledVector(out, len * 0.5 * Math.sin(rise))
      .add(new THREE.Vector3(0, len * 0.45 * Math.cos(rise), 0));
    const end = at
      .clone()
      .addScaledVector(out, len * 0.85)
      .add(new THREE.Vector3(0, -len * (0.1 + 0.4 * r()), 0));
    const curve = new THREE.QuadraticBezierCurve3(at, mid, end);
    parts.add(
      materials.tissue,
      tube(
        curve,
        (t) => 0.0018 * (1 - t * 0.5),
        ...tubeSegments(detail, 12, 5),
        () => straw,
      ),
    );
    spikelets(materials, parts, curve, 0.2, r, pitch);
  }
}

/** Small paired spikelets hanging along a tassel branch, `pitch` apart. */
function spikelets(materials: Materials, parts: Parts, curve: THREE.Curve<THREE.Vector3>, skip: number, r: seedrandom.PRNG, pitch: number) {
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
          .add(new THREE.Vector3(s * 0.4, -0.5, -0.3 + 0.6 * r()))
          .normalize(),
      );
      g.applyQuaternion(q).translate(at.x + s * 0.0015, at.y - 0.002, at.z);
      const c = new THREE.Color("#cdb873").lerp(new THREE.Color(r() < 0.3 ? "#9a6a58" : "#9fae62"), 0.45 * r());
      pieces.push(tint(g, c));
    }
  }
  if (pieces.length) parts.add(materials.tissue, ...pieces);
}
