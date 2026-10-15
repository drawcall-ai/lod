import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

/** A box with UVs in metres on every face, so tiling textures keep their real-world scale. */
export function box(w: number, h: number, d: number): THREE.BufferGeometry {
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

/** A translation followed by rotations about x, then y (radians). */
export function pose(x: number, y: number, z: number, ry = 0, rx = 0): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0, "YXZ"));
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
}

/** Merges geometries that share attributes; non-indexed inputs get an index first. */
export function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
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

/** Adds a constant vertex colour so the geometry can merge with vertex-coloured parts. */
export function tint(g: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
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
export class Parts {
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

/** Appends vertices and triangles by hand for surfaces no three.js geometry produces. */
export class MeshBuilder {
  private readonly position: number[] = [];
  private readonly uv: number[] = [];
  private readonly color: number[] = [];
  private readonly index: number[] = [];

  get count(): number {
    return this.position.length / 3;
  }

  vertex(p: THREE.Vector3, u: number, v: number, c: THREE.Color): number {
    this.position.push(p.x, p.y, p.z);
    this.uv.push(u, v);
    this.color.push(c.r, c.g, c.b);
    return this.count - 1;
  }

  /** Two triangles over a, b, c, d in counter-clockwise order seen from the front. */
  quad(a: number, b: number, c: number, d: number): void {
    this.index.push(a, b, c, a, c, d);
  }

  triangle(a: number, b: number, c: number): void {
    this.index.push(a, b, c);
  }

  /** Vertex normals are averaged only over shared vertices, so separate pieces stay separate. */
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.color, 3));
    g.setIndex(this.index);
    g.computeVertexNormals();
    return g;
  }
}

/** A polyline with its corners rounded by quadratic arcs, for tubes such as downpipes. */
export function roundedPath(points: THREE.Vector3[], radius: number): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  let from = points[0]?.clone();
  if (!from) throw new Error("roundedPath needs points");
  for (let i = 1; i < points.length; i++) {
    const corner = points[i];
    if (!corner) break;
    const next = points[i + 1];
    if (!next) {
      path.add(new THREE.LineCurve3(from, corner));
      break;
    }
    const inLen = corner.distanceTo(from);
    const outLen = corner.distanceTo(next);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const a = corner.clone().addScaledVector(from.clone().sub(corner).normalize(), r);
    const b = corner.clone().addScaledVector(next.clone().sub(corner).normalize(), r);
    path.add(new THREE.LineCurve3(from, a));
    path.add(new THREE.QuadraticBezierCurve3(a, corner.clone(), b));
    from = b;
  }
  return path;
}

/**
 * A closed-ended tube along a curve whose radius varies with t ∈ [0, 1] (stalks, stems,
 * legs). UVs: u around, v along in metres; colour per t allows gradients.
 */
export function tube(
  curve: THREE.Curve<THREE.Vector3>,
  radius: (t: number) => number,
  segments: number,
  radial: number,
  color: (t: number) => THREE.Color,
  /** Cross-section height over width, for flattened tubes such as insect legs. */
  aspect = 1,
): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const frames = curve.computeFrenetFrames(segments, false);
  const length = curve.getLength();
  const p = new THREE.Vector3();
  const rings: number[][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const center = curve.getPointAt(t);
    const n = frames.normals[i];
    const bn = frames.binormals[i];
    if (!n || !bn) throw new Error("missing Frenet frame");
    const r = radius(t);
    const c = color(t);
    const ring: number[] = [];
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      p.copy(center)
        .addScaledVector(n, Math.cos(a) * r)
        .addScaledVector(bn, Math.sin(a) * r * aspect);
      ring.push(b.vertex(p, j / radial, t * length, c));
    }
    rings.push(ring);
  }
  for (let i = 0; i < segments; i++) {
    const a = rings[i];
    const c = rings[i + 1];
    if (!a || !c) break;
    for (let j = 0; j < radial; j++) b.quad(a[j] ?? 0, a[j + 1] ?? 0, c[j + 1] ?? 0, c[j] ?? 0);
  }
  // cap the far end so thin tubes do not show their hollow inside
  const end = curve.getPointAt(1);
  const last = rings[segments];
  if (last) {
    const tip = b.vertex(end, 0.5, length, color(1));
    for (let j = 0; j < radial; j++) b.triangle(last[j] ?? 0, last[j + 1] ?? 0, tip);
  }
  return b.geometry();
}

export function triangles(object: THREE.Object3D): number {
  let count = 0;
  object.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g: THREE.BufferGeometry = o.geometry;
    const n = (g.index ? g.index.count : g.getAttribute("position").count) / 3;
    count += o instanceof THREE.InstancedMesh ? n * o.count : n;
  });
  return count;
}
