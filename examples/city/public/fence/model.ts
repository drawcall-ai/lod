import * as THREE from "three/webgpu";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import seedrandom from "seedrandom";
import { paintMaterial } from "./materials.ts";

/**
 * A painted picket fence along +x from the origin: square posts with pyramid caps every
 * 2.4 m, two rails behind the pickets, pointed pickets with irregular wear.
 */
export function picketFence(manager: THREE.LoadingManager, length: number, seed = 1): THREE.Group {
  const r = seedrandom(String(seed));
  const parts = new Parts();
  const paint = paintMaterial(manager);
  const white = new THREE.Color("#ebe8e0");
  const bays = Math.max(1, Math.round(length / 2.4));
  const bay = length / bays;
  const height = 1.0;

  for (let i = 0; i <= bays; i++) {
    const x = i * bay;
    parts.add(paint, tint(box(0.09, height + 0.12, 0.09).translate(x, (height + 0.12) / 2, 0), shade(white, r)));
    const cap = new THREE.ConeGeometry(0.075, 0.07, 4, 1).rotateY(Math.PI / 4).translate(x, height + 0.12 + 0.035, 0);
    parts.add(paint, tint(cap, shade(white, r)));
  }
  for (const y of [0.22, height - 0.2]) parts.add(paint, tint(box(length, 0.085, 0.035).translate(length / 2, y, 0.0625), shade(white, r)));

  const width = 0.085;
  const gap = 0.06;
  const outline = new THREE.Shape([
    new THREE.Vector2(-width / 2, 0),
    new THREE.Vector2(width / 2, 0),
    new THREE.Vector2(width / 2, 0.9),
    new THREE.Vector2(0, 0.9 + width * 0.7),
    new THREE.Vector2(-width / 2, 0.9),
  ]);
  for (let x = 0.045 + width / 2; x < length - 0.045 - width / 2; x += width + gap) {
    const h = 0.97 + 0.04 * r();
    const picket = new THREE.ExtrudeGeometry(outline, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 1 });
    picket
      .scale(1, h, 1)
      .rotateZ(-0.01 + 0.02 * r())
      .translate(x, 0.05, 0.08 + 0.003);
    parts.add(paint, tint(picket, shade(white, r)));
  }
  return parts.build("fence");
}

/** Paint varies a little from board to board; some boards are greyer with age. */
function shade(base: THREE.Color, r: seedrandom.PRNG): THREE.Color {
  const c = base.clone().offsetHSL(0, -0.02 + 0.04 * r(), -0.05 + 0.07 * r());
  return r() < 0.12 ? c.lerp(new THREE.Color("#b9b5a8"), 0.2 + 0.3 * r()) : c;
}

/** A box with UVs in metres on every face, so tiling textures keep their real-world scale. */
function box(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute("uv");
  // BoxGeometry faces in order ±x, ±y, ±z, four vertices each; [u span, v span] per face
  const spans = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let i = 0; i < uv.count; i++) {
    const [su = 1, sv = 1] = spans[Math.floor(i / 4)] ?? [];
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  return g;
}

/** Adds a constant vertex colour so the geometry can merge with vertex-coloured parts. */
function tint(g: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const n = g.getAttribute("position").count;
  const data = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) color.toArray(data, i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(data, 3));
  return g;
}

/**
 * Collects geometry per material and builds one shadowed mesh per material. `at(matrix)`
 * returns a view that places everything added through it in a local frame.
 */
class Parts {
  constructor(
    private readonly byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>(),
    private readonly matrix?: THREE.Matrix4,
  ) {}

  at(matrix: THREE.Matrix4): Parts {
    return new Parts(this.byMaterial, this.matrix ? this.matrix.clone().multiply(matrix) : matrix);
  }

  add(material: THREE.Material, ...geometries: THREE.BufferGeometry[]): void {
    const list = this.byMaterial.get(material) ?? [];
    for (const g of geometries) list.push(this.matrix ? g.applyMatrix4(this.matrix) : g);
    this.byMaterial.set(material, list);
  }

  build(name: string): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [material, list] of this.byMaterial) {
      const mesh = new THREE.Mesh(merge(list), material);
      mesh.name = `${name}:${material.name}`;
      mesh.castShadow = mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
}

/** Merges geometries that share attributes; non-indexed inputs get an index first. */
function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = list.map((g) => (g.index ? strip(g) : mergeVertices(strip(g))));
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error("mergeGeometries failed: inputs have different attributes");
  return merged;
}

/** Keeps only the attributes all generators share, so any two parts can merge. */
function strip(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv", "color"].includes(name)) g.deleteAttribute(name);
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}
