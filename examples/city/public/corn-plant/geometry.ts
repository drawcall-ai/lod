import * as THREE from "three/webgpu";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

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

  /**
   * Quads over a grid of vertices added row by row from index `first`: `rows` + 1 rows of `columns` + 1 vertices, each
   * quad wound counter-clockwise seen from the front, or the other way if `reversed`.
   */
  grid(first: number, rows: number, columns: number, reversed = false): void {
    const at = (row: number, column: number) => first + row * (columns + 1) + column;
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < columns; j++) {
        const [a, b, c, d] = [at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)];
        if (reversed) this.quad(a, d, c, b);
        else this.quad(a, b, c, d);
      }
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
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const center = curve.getPointAt(t);
    const n = frames.normals[i];
    const bn = frames.binormals[i];
    if (!n || !bn) throw new Error("missing Frenet frame");
    const r = radius(t);
    const c = color(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      p.copy(center)
        .addScaledVector(n, Math.cos(a) * r)
        .addScaledVector(bn, Math.sin(a) * r * aspect);
      b.vertex(p, j / radial, t * length, c);
    }
  }
  b.grid(0, segments, radial);
  // cap the far end so thin tubes do not show their hollow inside
  const end = curve.getPointAt(1);
  const last = segments * (radial + 1);
  const tip = b.vertex(end, 0.5, length, color(1));
  for (let j = 0; j < radial; j++) b.triangle(last + j, last + j + 1, tip);
  return b.geometry();
}

/**
 * How finely the round parts (stalk, sheaths, roots, silk, tassel) are tessellated:
 * "fine" for close-ups, "field" for the plants of a field, seen from a metre or more.
 */
export type Detail = "fine" | "field";

/** `segments` along and `radial` around a tube at `detail`. */
export function tubeSegments(detail: Detail, segments: number, radial: number): [number, number] {
  return detail === "fine" ? [segments, radial] : [Math.max(3, Math.round(segments * 0.35)), Math.max(4, Math.round(radial * 0.6))];
}
