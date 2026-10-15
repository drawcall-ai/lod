import * as THREE from "three";
import { chimneySize, chimneyZ, heights, type HouseParams } from "./params.ts";

type Face = { points: THREE.Vector3[]; group: number };

/**
 * The house as a clean closed shell from the same params: a wall box and a roof prism that
 * covers the overhangs (plus the chimney stack). Every face gets its own island in one
 * non-overlapping 0–1 UV atlas with uniform texel density, ready for baking.
 */
export function low(p: HouseParams): THREE.Mesh {
  const { ridge } = heights(p);
  const a = (p.roof.pitch * Math.PI) / 180;
  const hw = p.width / 2;
  const hd = p.depth / 2;
  // outer edge of the roof matching the detailed roof: deck + tiles on top, fascia below
  const thick = 0.3 / Math.cos(a);
  const ex = hw + 0.32;
  const ez = hd + p.roof.overhang * Math.cos(a);
  const et = ridge + thick - ez * Math.tan(a);
  const eb = et - 0.32;
  const top = ridge + thick;

  const faces: Face[] = [];
  const face = (group: number, ...points: THREE.Vector3[]) => faces.push({ points, group });
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // walls up to the soffit
  face(0, v(-hw, 0, hd), v(hw, 0, hd), v(hw, eb, hd), v(-hw, eb, hd));
  face(0, v(hw, 0, -hd), v(-hw, 0, -hd), v(-hw, eb, -hd), v(hw, eb, -hd));
  face(0, v(hw, 0, hd), v(hw, 0, -hd), v(hw, eb, -hd), v(hw, eb, hd));
  face(0, v(-hw, 0, -hd), v(-hw, 0, hd), v(-hw, eb, hd), v(-hw, eb, -hd));
  face(0, v(-hw, 0, -hd), v(hw, 0, -hd), v(hw, 0, hd), v(-hw, 0, hd));
  // roof prism: slopes, fascias, gable pentagons, soffit
  face(1, v(-ex, et, ez), v(ex, et, ez), v(ex, top, 0), v(-ex, top, 0));
  face(1, v(ex, et, -ez), v(-ex, et, -ez), v(-ex, top, 0), v(ex, top, 0));
  face(1, v(-ex, eb, ez), v(ex, eb, ez), v(ex, et, ez), v(-ex, et, ez));
  face(1, v(ex, eb, -ez), v(-ex, eb, -ez), v(-ex, et, -ez), v(ex, et, -ez));
  face(1, v(ex, eb, ez), v(ex, eb, -ez), v(ex, et, -ez), v(ex, top, 0), v(ex, et, ez));
  face(1, v(-ex, eb, -ez), v(-ex, eb, ez), v(-ex, et, ez), v(-ex, top, 0), v(-ex, et, -ez));
  face(1, v(-ex, eb, -ez), v(ex, eb, -ez), v(ex, eb, ez), v(-ex, eb, ez));
  if (p.chimney) {
    const { w, d } = chimneySize;
    const [x0, x1, z0, z1, y1] = [p.chimney.x - w / 2, p.chimney.x + w / 2, chimneyZ - d / 2, chimneyZ + d / 2, ridge + p.chimney.height + 0.08];
    const y0 = ridge - Math.abs(z0) * Math.tan(a);
    face(2, v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1));
    face(2, v(x1, y0, z0), v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0));
    face(2, v(x1, y0, z1), v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1));
    face(2, v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0));
    face(2, v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0), v(x0, y1, z0));
  }

  return new THREE.Mesh(atlas(faces), [
    new THREE.MeshStandardMaterial({ name: "low-walls", color: p.wall.kind === "brick" ? "#9a5a45" : p.wall.color, roughness: 0.9 }),
    new THREE.MeshStandardMaterial({ name: "low-roof", color: p.roof.color, roughness: 0.8 }),
    new THREE.MeshStandardMaterial({ name: "low-chimney", color: "#8a4a3a", roughness: 0.9 }),
  ]);
}

/** Packs each planar face into its own shelf-packed island; metres map uniformly to texels. */
function atlas(faces: Face[]): THREE.BufferGeometry {
  const pad = 0.15;
  const islands = faces.map((f) => {
    const [o, b, c] = f.points;
    if (!o || !b || !c) throw new Error("face needs at least three points");
    const e1 = b.clone().sub(o).normalize();
    const n = e1.clone().cross(c.clone().sub(o)).normalize();
    const e2 = n.clone().cross(e1);
    const local = f.points.map((q) => new THREE.Vector2(q.clone().sub(o).dot(e1), q.clone().sub(o).dot(e2)));
    const min = new THREE.Vector2(Infinity, Infinity);
    const max = new THREE.Vector2(-Infinity, -Infinity);
    for (const q of local) {
      min.min(q);
      max.max(q);
    }
    return { face: f, normal: n, local: local.map((q) => q.sub(min)), size: max.sub(min), at: new THREE.Vector2() };
  });

  // shelf packing, tallest first, into a strip as wide as a square of the total area
  const area = islands.reduce((s, i) => s + (i.size.x + pad) * (i.size.y + pad), 0);
  const stripWidth = Math.sqrt(area) * 1.15;
  let x = pad;
  let y = pad;
  let shelf = 0;
  let width = 0;
  for (const i of [...islands].sort((a, b) => b.size.y - a.size.y)) {
    if (x + i.size.x + pad > stripWidth && x > pad) {
      x = pad;
      y += shelf + pad;
      shelf = 0;
    }
    i.at.set(x, y);
    x += i.size.x + pad;
    shelf = Math.max(shelf, i.size.y);
    width = Math.max(width, x);
  }
  const scale = 1 / Math.max(width, y + shelf + pad);

  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const g = new THREE.BufferGeometry();
  for (const i of islands) {
    const start = position.length / 3;
    const fan = i.face.points.length - 2;
    for (let k = 0; k < fan; k++) {
      for (const idx of [0, k + 1, k + 2]) {
        const q = i.face.points[idx];
        const t = i.local[idx];
        if (!q || !t) throw new Error("face index out of range");
        position.push(q.x, q.y, q.z);
        normal.push(i.normal.x, i.normal.y, i.normal.z);
        uv.push((i.at.x + t.x) * scale, (i.at.y + t.y) * scale);
      }
    }
    g.addGroup(start, fan * 3, i.face.group);
  }
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  return g;
}
