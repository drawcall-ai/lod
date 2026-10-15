import * as THREE from "three";

/** A rectangular hole in a wall, in the wall's local frame (x along the wall, y up). */
export interface Opening {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A wall slab with openings: its outer face lies at z = 0 facing +z, the inner face at
 * z = -thickness. The inner face is dropped: glazing is opaque, so nothing sees it.
 */
export function wallSlab(outline: THREE.Vector2[], openings: Opening[], thickness: number) {
  const shape = new THREE.Shape(outline);
  for (const o of openings) {
    shape.holes.push(
      new THREE.Path([
        new THREE.Vector2(o.x - o.w / 2, o.y),
        new THREE.Vector2(o.x + o.w / 2, o.y),
        new THREE.Vector2(o.x + o.w / 2, o.y + o.h),
        new THREE.Vector2(o.x - o.w / 2, o.y + o.h),
      ]),
    );
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  g.translate(0, 0, -thickness);
  return keepTriangles(g, (n) => n.z > -0.5);
}

/** The triangles of a non-indexed geometry whose (flat) normal passes the test. */
function keepTriangles(g: THREE.BufferGeometry, test: (normal: THREE.Vector3) => boolean): THREE.BufferGeometry {
  const normal = g.getAttribute("normal");
  const n = new THREE.Vector3();
  const out = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"]) {
    const a = g.getAttribute(name);
    const kept: number[] = [];
    for (let tri = 0; tri < normal.count / 3; tri++) {
      if (!test(n.fromBufferAttribute(normal, tri * 3))) continue;
      for (let i = tri * 3 * a.itemSize; i < (tri + 1) * 3 * a.itemSize; i++) kept.push(a.array[i] ?? 0);
    }
    out.setAttribute(name, new THREE.Float32BufferAttribute(kept, a.itemSize));
  }
  return out;
}
