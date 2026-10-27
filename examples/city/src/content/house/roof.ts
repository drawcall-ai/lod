import * as THREE from "three/webgpu";
import { box, merge, MeshBuilder, type Parts, pose, roundedPath, tint } from "../geometry.ts";
import { Random } from "../random.ts";
import { brick, concrete, paint, tiles, zinc } from "./materials.ts";
import { chimneySize, chimneyZ, heights, type HouseParams } from "./params.ts";

/** Rafters plus boarding under the tiles; its underside is the visible soffit. */
const deck = 0.2;
/** Battens lift the tiles off the deck. */
const batten = 0.035;
/** Roof extends past the gable walls by this much. */
const verge = 0.32;

/**
 * Frame of the front roof slope: x along the ridge, y the slope's outward normal, z downhill.
 * The origin is the ridge line on the underside of the deck.
 */
function slopeFrame(p: HouseParams): THREE.Matrix4 {
  const { ridge } = heights(p);
  const a = (p.roof.pitch * Math.PI) / 180;
  const n = new THREE.Vector3(0, Math.cos(a), Math.sin(a));
  const s = new THREE.Vector3(0, -Math.sin(a), Math.cos(a));
  return new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), n, s).setPosition(0, ridge, 0);
}

/** Length of one slope from the ridge to the eave edge, measured along the slope. */
function slopeLength(p: HouseParams): number {
  const a = (p.roof.pitch * Math.PI) / 180;
  return p.depth / 2 / Math.cos(a) + p.roof.overhang;
}

/** Both slopes, the ridge, verges, fascia, gutters and downpipes. Shared geometry is built per slope. */
export function roof(parts: Parts, p: HouseParams) {
  const r = new Random(p.seed * 7 + 1);
  for (const side of [0, 1]) {
    const sideParts = parts.at(pose(0, 0, 0, side * Math.PI));
    slope(sideParts.at(slopeFrame(p)), p, r);
    eave(sideParts, p);
  }
  ridgeTiles(parts, p, r);
  if (p.chimney) chimney(parts, p, p.chimney);
}

function slope(parts: Parts, p: HouseParams, r: Random) {
  const W = p.width + 2 * verge;
  const L = slopeLength(p);
  const trim = paint(p.trim);
  parts.add(trim, box(W, deck, L).translate(0, deck / 2, L / 2));
  for (const x of [-1, 1]) parts.add(trim, box(0.035, 0.3, L + 0.02).translate(x * (W / 2 + 0.0175), deck / 2 + 0.06, L / 2));
  parts.add(tiles(), p.roof.tiles === "clay" ? pantiles(p, W, L, r) : slates(p, W, L, r));
}

/** Per-tile colour: the roof colour varied in lightness, with some weathered or lichen-spotted tiles. */
function tileColor(base: THREE.Color, r: Random): THREE.Color {
  const c = base.clone().offsetHSL(r.range(-0.01, 0.01), r.range(-0.12, 0.0), r.range(-0.04, 0.035));
  if (r.chance(0.12)) c.multiplyScalar(r.range(0.65, 0.85));
  if (r.chance(0.05)) c.lerp(new THREE.Color("#5f6150"), r.range(0.2, 0.4));
  return c;
}

/** Clay pantiles: S-profiled tiles in overlapping rows, each tile its own piece with a visible lower edge. */
function pantiles(p: HouseParams, W: number, L: number, r: Random): THREE.BufferGeometry {
  const base = new THREE.Color(p.roof.color);
  const length = 0.42;
  const exposure = 0.335;
  const count = Math.round(W / 0.215);
  const pitch = W / count;
  const wave = 0.042;
  const thick = 0.016;
  const segs = 6;
  const profile = (u: number) => wave * (0.5 - 0.5 * Math.cos(2 * Math.PI * u)) + 0.18 * wave * Math.sin(4 * Math.PI * u);
  const b = new MeshBuilder();
  const v = new THREE.Vector3();
  for (let low = L + 0.05; low > 0; low -= exposure) {
    const high = Math.max(0, low - length);
    for (let i = 0; i < count; i++) {
      const c = tileColor(base, r);
      const x0 = -W / 2 + i * pitch + r.range(-0.004, 0.004);
      const lift = r.range(0.018, 0.026);
      const yaw = r.range(-0.012, 0.012);
      const at = (u: number, t: number, down: number) => {
        const s = high + (low - high) * t;
        const x = x0 + u * pitch + yaw * (s - low);
        return v.set(x, deck + batten + profile(u) + lift * t - down, s);
      };
      const top: number[][] = [];
      for (let k = 0; k <= 2; k++) {
        const row: number[] = [];
        for (let j = 0; j <= segs; j++) {
          const p3 = at(j / segs, k / 2, 0);
          row.push(b.vertex(p3, p3.x, p3.z, c));
        }
        top.push(row);
      }
      const edge: number[][] = [[], []];
      for (let j = 0; j <= segs; j++) {
        for (const [k, down] of [
          [0, 0],
          [1, thick],
        ] as const) {
          const p3 = at(j / segs, 1, down);
          edge[k]?.push(b.vertex(p3, p3.x, p3.z + down, c));
        }
      }
      for (let k = 0; k < 2; k++) for (let j = 0; j < segs; j++) quad(b, top[k + 1]?.[j], top[k + 1]?.[j + 1], top[k]?.[j + 1], top[k]?.[j]);
      for (let j = 0; j < segs; j++) quad(b, edge[1]?.[j], edge[1]?.[j + 1], edge[0]?.[j + 1], edge[0]?.[j]);
    }
  }
  return b.geometry();
}

function quad(b: MeshBuilder, ...ids: (number | undefined)[]) {
  const [a, c, d, e] = ids;
  if (a === undefined || c === undefined || d === undefined || e === undefined) throw new Error("tile grid index out of range");
  b.quad(a, c, d, e);
}

/** Natural slates: thin rectangles laid double-lap in half-bond, each slightly irregular. */
function slates(p: HouseParams, W: number, L: number, r: Random): THREE.BufferGeometry {
  const base = new THREE.Color(p.roof.color);
  const pieces: THREE.BufferGeometry[] = [];
  const length = 0.46;
  const exposure = 0.19;
  const width = 0.26;
  let row = 0;
  for (let low = L + 0.05; low > 0; low -= exposure, row++) {
    const high = Math.max(0, low - length);
    const len = low - high;
    for (let x = -W / 2 - (row % 2) * width * 0.5; x < W / 2; x += width) {
      const w = Math.min(width, W / 2 - x) - 0.004;
      const x0 = Math.max(x, -W / 2);
      const ww = w - (x0 - x);
      if (ww < 0.02) continue;
      const g = box(ww, 0.008, len)
        .rotateX(-0.03 - r.range(0, 0.008))
        .rotateY(r.range(-0.008, 0.008))
        .translate(x0 + ww / 2, deck + batten + 0.004 + 0.012 + r.range(-0.002, 0.002), (low + high) / 2);
      const c = base.clone().offsetHSL(r.range(-0.006, 0.006), r.range(-0.02, 0.02), r.range(-0.018, 0.018));
      if (r.chance(0.03)) c.multiplyScalar(0.85);
      pieces.push(tint(g, c));
    }
  }
  return merge(pieces);
}

/** Half-round ridge tiles bedded in mortar along the ridge. */
function ridgeTiles(parts: Parts, p: HouseParams, r: Random) {
  const { ridge } = heights(p);
  const a = (p.roof.pitch * Math.PI) / 180;
  const W = p.width + 2 * verge;
  const top = ridge + (deck + batten + 0.03) / Math.cos(a);
  parts.add(concrete(), box(W, 0.06, 0.15).translate(0, top - 0.035, 0));
  const base = new THREE.Color(p.roof.color);
  const step = 0.36;
  const pieces: THREE.BufferGeometry[] = [];
  for (let x = -W / 2; x < W / 2 - 0.05; x += step) {
    const g = new THREE.CylinderGeometry(0.12, 0.13, step + 0.05, 14, 1, true, Math.PI, Math.PI).rotateZ(-Math.PI / 2).scale(1, 0.8, 1);
    pieces.push(tint(g.translate(x + step / 2, top + 0.02, 0), tileColor(base, r)));
  }
  for (const s of [-1, 1]) {
    const cap = new THREE.CircleGeometry(0.12, 14, 0, Math.PI).rotateY((s * Math.PI) / 2).scale(1, 0.8, 1);
    pieces.push(tint(cap.translate(s * (W / 2 + 0.02), top + 0.02, 0), tileColor(base, r)));
  }
  for (const g of pieces) g.deleteAttribute("uv");
  for (const g of pieces) g.setAttribute("uv", planarUV(g));
  parts.add(tiles(), ...pieces);
}

/** UVs in metres from the x/y position, for parts whose own UVs are not metric. */
function planarUV(g: THREE.BufferGeometry): THREE.BufferAttribute {
  const pos = g.getAttribute("position");
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) + pos.getZ(i);
    uv[i * 2 + 1] = pos.getY(i);
  }
  return new THREE.BufferAttribute(uv, 2);
}

/** Fascia board, half-round gutter on brackets, and a downpipe with swan neck down to the ground. */
function eave(parts: Parts, p: HouseParams) {
  const L = slopeLength(p);
  const W = p.width + 2 * verge;
  const lip = new THREE.Vector3(0, deck, L).applyMatrix4(slopeFrame(p));
  const metal = zinc();
  parts.add(paint(p.trim), box(W, 0.24, 0.028).translate(0, lip.y - 0.1, lip.z + 0.014));

  const R = 0.075;
  const gy = lip.y - 0.06;
  const gz = lip.z + 0.03 + R;
  const arc = (radius: number, i: number) => new THREE.Vector2(radius * Math.cos((-Math.PI * i) / 16), radius * Math.sin((-Math.PI * i) / 16));
  const outline = [...Array.from({ length: 17 }, (_, i) => arc(R, i)), ...Array.from({ length: 17 }, (_, i) => arc(R - 0.004, 16 - i))];
  const shape = new THREE.Shape(outline);
  const gutter = new THREE.ExtrudeGeometry(shape, { depth: W - 0.1, bevelEnabled: false, curveSegments: 1 });
  parts.add(
    metal,
    gutter
      .translate(0, 0, -(W - 0.1) / 2)
      .rotateY(Math.PI / 2)
      .translate(0, gy, gz),
  );
  parts.add(metal, new THREE.CylinderGeometry(0.008, 0.008, W - 0.1, 8).rotateZ(Math.PI / 2).translate(0, gy + 0.002, gz + R));
  for (let x = -W / 2 + 0.3; x < W / 2 - 0.2; x += 0.75) {
    const bracket = new THREE.TorusGeometry(R + 0.004, 0.0045, 4, 14, Math.PI).rotateX(Math.PI).rotateY(Math.PI / 2);
    parts.add(metal, bracket.translate(x, gy, gz));
    parts.add(metal, box(0.025, 0.004, 0.08).translate(x, gy + 0.002, lip.z + 0.03));
  }

  const x = p.width / 2 - 0.3;
  const wallZ = p.depth / 2 + 0.075;
  const pipe = roundedPath(
    [
      new THREE.Vector3(x, gy - R + 0.01, gz),
      new THREE.Vector3(x, gy - R - 0.12, gz),
      new THREE.Vector3(x, gy - R - 0.42, wallZ),
      new THREE.Vector3(x, 0.25, wallZ),
      new THREE.Vector3(x, 0.08, wallZ + 0.16),
    ],
    0.09,
  );
  parts.add(metal, new THREE.TubeGeometry(pipe, Math.ceil(pipe.getLength() / 0.04), 0.045, 14));
  for (let y = 0.6; y < gy - R - 0.6; y += 1.5) {
    parts.add(metal, new THREE.CylinderGeometry(0.05, 0.05, 0.035, 14).translate(x, y, wallZ));
    parts.add(metal, box(0.02, 0.02, 0.06).translate(x, y, wallZ - 0.05));
  }
}

/** A brick stack through the back slope with concrete cap, lead flashing and clay pots. */
function chimney(parts: Parts, p: HouseParams, c: NonNullable<HouseParams["chimney"]>) {
  const { eave: e, ridge, slope: k } = heights(p);
  const a = (p.roof.pitch * Math.PI) / 180;
  const { w, d } = chimneySize;
  const z = chimneyZ;
  const top = ridge + c.height;
  parts.add(brick(), box(w, top - e, d).translate(c.x, (top + e) / 2, z));
  parts.add(concrete(), box(w + 0.12, 0.08, d + 0.12).translate(c.x, top + 0.04, z));
  for (let i = 0; i < c.pots; i++) {
    const px = c.x + (c.pots === 2 ? (i - 0.5) * 0.28 : 0);
    const pot = new THREE.CylinderGeometry(0.09, 0.11, 0.34, 16);
    parts.add(tiles(), tint(pot.translate(px, top + 0.08 + 0.17, z), new THREE.Color(p.roof.tiles === "clay" ? p.roof.color : "#a9563a")));
  }
  // lead flashing collar where the stack meets the tiles (the roof rises toward the ridge)
  const roofY = ridge - Math.abs(z) * k + (deck + batten + 0.04) / Math.cos(a);
  parts.add(zinc(), box(w + 0.05, 0.22, d + 0.05).translate(c.x, roofY + 0.04, z));
}
