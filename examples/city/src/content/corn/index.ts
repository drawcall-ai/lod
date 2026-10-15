import * as THREE from "three";
import { Parts, tube } from "../geometry.ts";
import { Random } from "../random.ts";
import { ear } from "./ear.ts";
import { dryLeafMaterial, leaf, leafMaterial } from "./leaf.ts";
import { tassel } from "./tassel.ts";
import { type Detail, tissue, tubeSegments } from "./tissue.ts";

export { leaf, leafMaterial } from "./leaf.ts";

/**
 * A field-corn (maize) plant at tasselling stage, origin at the ground: a jointed stalk
 * 2.5–3 cm thick wrapped in leaf sheaths, 15–17 alternate leaves that rise, arch over and
 * droop (the longest, about a metre, at the ear; the lowest dead and dry), brace roots, a
 * branched tassel and one or two husked ears with silk at mid-height. `leafSegments`
 * (along, across each blade) sets the leaves' tessellation, `detail` that of the round
 * parts; `tassel: false` leaves the tassel off.
 */
export function cornPlant(seed: number, options: { leafSegments?: [number, number]; detail?: Detail; tassel?: boolean } = {}): THREE.Group {
  const detail = options.detail ?? "fine";
  const r = new Random(seed);
  const parts = new Parts();
  const height = r.range(2.0, 2.5);
  const stalk = stalkCurve(height * 0.86, r);
  const nodes = nodeHeights(r.int(16, 18));
  const radius = (t: number) => THREE.MathUtils.lerp(0.0135, 0.0065, t ** 1.2);

  // maize stalks are a slightly blue-grey green under their waxy bloom, not lime
  const green = new THREE.Color("#52703c");
  const stem = tube(
    stalk,
    (t) => radius(t) * (1 + 0.12 * nodeBulge(t, nodes)),
    ...tubeSegments(detail, 120, 10),
    (t) => green.clone().lerp(new THREE.Color("#8a7a4a"), nodeBulge(t, nodes) * 0.6),
  );
  parts.add(tissue(), stem);

  const ears: THREE.Vector3[] = [];
  let azimuth = r.range(0, Math.PI * 2);
  const earNodes = new Set([Math.round(nodes.length * 0.42), ...(r.chance(0.4) ? [Math.round(nodes.length * 0.42) - 1] : [])]);
  for (let i = 1; i < nodes.length; i++) {
    azimuth += Math.PI + r.range(-0.25, 0.25);
    const t = nodes[i] ?? 0;
    const next = nodes[i + 1] ?? 1;
    // the sheath wraps the stalk from this node most of the way up to the next
    const sheathColor = new THREE.Color("#4c6c36").offsetHSL(0, 0, r.range(-0.03, 0.03));
    parts.add(
      tissue(),
      tube(
        new SubCurve(stalk, t, t + (next - t) * 0.85),
        (s) => radius(t + (next - t) * 0.85 * s) + 0.0022 * (1 - s * 0.5),
        ...tubeSegments(detail, 10, 12),
        () => sheathColor,
      ),
    );
    const tc = Math.min(1, t + (next - t) * 0.85);
    const collar = stalk.getPointAt(tc).add(new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth)).multiplyScalar(radius(tc)));
    const rank = (i - 1) / (nodes.length - 2);
    // leaf size peaks at the ear leaf a little below mid-stalk
    const bell = Math.exp(-(((rank - 0.4) / 0.33) ** 2));
    const dead = i <= 2;
    // living leaves just above the dead ones are yellowing
    const age = dead ? 0 : Math.max(0, 1 - (i - 3) / 2) * r.range(0.2, 0.45);
    const color = new THREE.Color("#ffffff").offsetHSL(0, 0, r.range(-0.05, 0.03)).lerp(new THREE.Color("#ffe9a0"), age);
    parts.add(
      dead ? dryLeafMaterial() : leafMaterial(),
      leaf(collar, azimuth, {
        length: (dead ? r.range(0.35, 0.55) : 0.45 + 0.55 * bell) * r.range(0.92, 1.06),
        width: 0.06 + 0.045 * bell,
        rise: 0.32 + 0.18 * (1 - rank) + r.range(-0.08, 0.08),
        droop: dead ? r.range(2.4, 2.9) : THREE.MathUtils.lerp(2.3, 1.1, THREE.MathUtils.smoothstep(rank, 0.5, 1)) + r.range(-0.25, 0.25),
        twist: r.range(-0.8, 0.8),
        color,
        seed: r.int(0, 1e9),
        segments: options.leafSegments,
      }),
    );
    if (earNodes.has(i)) ears.push(ear(parts, stalk.getPointAt(t), stalk.getTangentAt(t), azimuth + r.range(-0.3, 0.3), r, detail));
  }
  braceRoots(parts, stalk, nodes, radius, r, detail);
  if (options.tassel !== false) tassel(parts, stalk.getPointAt(1), stalk.getTangentAt(1), height * 0.17, r, detail);
  const group = parts.build("corn");
  // empty markers so callers can find the ears, e.g. to frame a close-up
  for (const at of ears) {
    const marker = new THREE.Object3D();
    marker.name = "ear";
    marker.position.copy(at);
    group.add(marker);
  }
  return group;
}

/** A slightly leaning, gently curved stalk axis. */
function stalkCurve(height: number, r: Random): THREE.CatmullRomCurve3 {
  const lean = new THREE.Vector2(r.range(-1, 1), r.range(-1, 1)).normalize().multiplyScalar(r.range(0.02, 0.07));
  const points = [0, 0.25, 0.5, 0.75, 1].map(
    (f) => new THREE.Vector3(lean.x * f * f + r.range(-0.008, 0.008), f * height, lean.y * f * f + r.range(-0.008, 0.008)),
  );
  return new THREE.CatmullRomCurve3(points);
}

/** Node positions along the stalk (0–1): short internodes at the base, longest in the middle. */
function nodeHeights(count: number): number[] {
  const lengths = Array.from({ length: count }, (_, i) => 0.35 + Math.sin((Math.PI * (i + 0.5)) / count) ** 0.7 + (i < 3 ? -0.25 : 0));
  const total = lengths.reduce((a, b) => a + b, 0);
  let at = 0.015;
  return lengths.map((l) => {
    const t = at;
    at += (l / total) * 0.98;
    return t;
  });
}

/** 1 right at a node, falling to 0 within a centimetre or two, for the slight swelling and colour band. */
function nodeBulge(t: number, nodes: number[]): number {
  let d = Infinity;
  for (const n of nodes) d = Math.min(d, Math.abs(t - n));
  return Math.max(0, 1 - d / 0.008);
}

class SubCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    private readonly parent: THREE.Curve<THREE.Vector3>,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  override getPoint(t: number, target = new THREE.Vector3()): THREE.Vector3 {
    return this.parent.getPointAt(Math.min(1, this.from + (this.to - this.from) * t), target);
  }
}

/** Brace roots from the lowest nodes, arching out and down into the soil. */
function braceRoots(parts: Parts, stalk: THREE.Curve<THREE.Vector3>, nodes: number[], radius: (t: number) => number, r: Random, detail: Detail) {
  for (const n of nodes.slice(0, 2)) {
    const count = r.int(6, 9);
    const base = stalk.getPointAt(n);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + r.range(-0.3, 0.3);
      const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const reach = r.range(0.04, 0.09) + base.y * 0.5;
      const start = base.clone().addScaledVector(dir, radius(n) * 0.8);
      const mid = start
        .clone()
        .addScaledVector(dir, reach * 0.6)
        .setY(base.y * 0.7 + 0.005);
      const end = start.clone().addScaledVector(dir, reach).setY(-0.02);
      const c = new THREE.Color("#8f8a5e").lerp(new THREE.Color("#7a5048"), r.range(0, 0.5));
      parts.add(
        tissue(),
        tube(
          new THREE.QuadraticBezierCurve3(start, mid, end),
          (t) => 0.0035 * (1 - t * 0.4),
          ...tubeSegments(detail, 8, 6),
          () => c,
        ),
      );
    }
  }
}
