import * as THREE from "three/webgpu";
import { at } from "./must.js";
import { context2d } from "./page.js";

// Procedural test subjects shared by the lab pages: a brick texture and a house with its
// authored low shell.

// --- procedural brick wall ------------------------------------------------------------

export function bricks(): { map: THREE.Texture; normalMap: THREE.Texture } {
  const W = 512;
  const H = 256;
  const rows = 4;
  const perRow = 4;
  const mortar = 6;
  const color = document.createElement("canvas");
  color.width = W;
  color.height = H;
  const ctx = context2d(color);
  ctx.fillStyle = "#b9b2a6";
  ctx.fillRect(0, 0, W, H);
  const height = new Float32Array(W * H);
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const bh = H / rows;
  const bw = W / perRow;
  for (let r = 0; r < rows; r++)
    for (let b = -1; b < perRow; b++) {
      const x0 = b * bw + (r % 2 ? bw / 2 : 0) + mortar / 2;
      const y0 = r * bh + mortar / 2;
      const shade = 0.75 + rand() * 0.3;
      ctx.fillStyle = `rgb(${Math.round(160 * shade)}, ${Math.round(70 * shade)}, ${Math.round(50 * shade)})`;
      ctx.fillRect(x0, y0, bw - mortar, bh - mortar);
      // Bevelled brick: height rises over `bevel` pixels from the mortar.
      const bevel = 5;
      for (let y = Math.ceil(y0); y < y0 + bh - mortar; y++)
        for (let x = Math.ceil(x0); x < x0 + bw - mortar; x++) {
          if (x < 0 || x >= W) continue;
          const edge = Math.min(x - x0, x0 + bw - mortar - x, y - y0, y0 + bh - mortar - y);
          height[y * W + x] = Math.min(1, (edge + 0.5) / bevel);
        }
    }
  // Tangent-space normal map from the height field. Canvas textures upload with flipY, so
  // image +y is -v: n = normalize(-dh/du, -dh/dv, 1/strength) with dh/dv = -dh/dy.
  const normal = document.createElement("canvas");
  normal.width = W;
  normal.height = H;
  const nctx = context2d(normal);
  const pixels = nctx.createImageData(W, H);
  const h = (x: number, y: number) => at(height, ((y + H) % H) * W + ((x + W) % W));
  const strength = 3;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * 0.5 * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * 0.5 * strength;
      const n = new THREE.Vector3(-dx, dy, 1).normalize();
      const o = (y * W + x) * 4;
      pixels.data[o] = (n.x * 0.5 + 0.5) * 255;
      pixels.data[o + 1] = (n.y * 0.5 + 0.5) * 255;
      pixels.data[o + 2] = (n.z * 0.5 + 0.5) * 255;
      pixels.data[o + 3] = 255;
    }
  nctx.putImageData(pixels, 0, 0);
  const map = new THREE.CanvasTexture(color);
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = new THREE.CanvasTexture(normal);
  for (const t of [map, normalMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
  }
  return { map, normalMap };
}

/** `texture` repeated `x` × `y` times over a face. */
export function tiled(texture: THREE.Texture, x: number, y: number): THREE.Texture {
  const copy = texture.clone();
  copy.repeat.set(x, y);
  return copy;
}

// --- procedural house: hard surface with small geometric detail -----------------------

const HOUSE = { width: 10, depth: 8, wall: 5, ridge: 2.5, overhang: 0.5, thickness: 0.2 };

/** Window openings: size, sill-to-centre height, centres along the front/back (x) and on the sides (z). */
const WINDOW = { width: 1.2, height: 1.4, y: 2.75, xs: [-3, 0, 3], zs: [0] };

/**
 * A wall slab `length` long (along shape x, centred), `HOUSE.wall` high, `HOUSE.thickness`
 * thick along +z from 0, with a window opening at each of `centres`. UVs in metres.
 */
function wallSlab(length: number, centres: number[]): THREE.BufferGeometry {
  const { wall: height, thickness } = HOUSE;
  const { width: w, height: h, y } = WINDOW;
  const shape = new THREE.Shape([
    new THREE.Vector2(-length / 2, 0),
    new THREE.Vector2(length / 2, 0),
    new THREE.Vector2(length / 2, height),
    new THREE.Vector2(-length / 2, height),
  ]);
  for (const x of centres)
    shape.holes.push(
      new THREE.Path([
        new THREE.Vector2(x - w / 2, y - h / 2),
        new THREE.Vector2(x - w / 2, y + h / 2),
        new THREE.Vector2(x + w / 2, y + h / 2),
        new THREE.Vector2(x + w / 2, y - h / 2),
      ]),
    );
  return new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
}

/** Roof tiles: rows of shaded tiles with dark gaps. */
function tiles(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = context2d(canvas);
  ctx.fillStyle = "#3a1a14";
  ctx.fillRect(0, 0, 256, 256);
  for (let row = 0; row < 8; row++)
    for (let col = -1; col < 8; col++) {
      const x = col * 32 + (row % 2 ? 16 : 0);
      const gradient = ctx.createLinearGradient(0, row * 32, 0, row * 32 + 30);
      gradient.addColorStop(0, "#a4462e");
      gradient.addColorStop(1, "#6e2a1c");
      ctx.fillStyle = gradient;
      ctx.fillRect(x + 1, row * 32 + 1, 30, 29);
    }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;
  return map;
}

/** The roof volume between the walls' top and the ridge: a triangle prism along x, its bottom face hidden inside the house. */
function gable(): THREE.BufferGeometry {
  const { width, depth, wall: height, ridge } = HOUSE;
  const shape = new THREE.Shape([new THREE.Vector2(-depth / 2, 0), new THREE.Vector2(depth / 2, 0), new THREE.Vector2(0, ridge)]);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  // Shape x → z, extrusion z → x, centred.
  geometry.rotateY(Math.PI / 2);
  geometry.translate(-width / 2, height, 0);
  return geometry;
}

export function house(): THREE.Object3D {
  const { width, depth, wall: height, ridge, overhang } = HOUSE;
  const group = new THREE.Group();
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  const brick = bricks();
  // Brick tiles are 2 m × 1 m; the slabs' UVs are in metres.
  const walls = new THREE.MeshStandardMaterial({ map: tiled(brick.map, 0.5, 1), normalMap: tiled(brick.normalMap, 0.5, 1), roughness: 0.85 });
  // Modelled as a generator would: wall slabs with window openings, a closed prism for
  // the gable with faces nobody sees (its bottom), which the bake's error leaves out.
  const { thickness } = HOUSE;
  for (const side of [-1, 1]) {
    add(wallSlab(width, WINDOW.xs), walls, 0, 0, side > 0 ? depth / 2 - thickness : -depth / 2);
    add(wallSlab(depth - 2 * thickness, WINDOW.zs), walls, side > 0 ? width / 2 - thickness : -width / 2, 0, 0).rotation.y = Math.PI / 2;
  }
  const floor = add(new THREE.PlaneGeometry(width, depth), walls);
  floor.rotation.x = Math.PI / 2;
  add(gable(), new THREE.MeshStandardMaterial({ map: tiled(brick.map, 4, 2), normalMap: tiled(brick.normalMap, 4, 2), roughness: 0.85 }));

  // Roof: two slabs with tiles, meeting at the ridge, reaching past the walls.
  const slope = Math.atan2(ridge, depth / 2);
  const run = Math.hypot(ridge, depth / 2) + overhang;
  const roof = new THREE.MeshStandardMaterial({ map: tiled(tiles(), 6, 3), roughness: 0.6 });
  for (const side of [-1, 1]) {
    const slab = add(new THREE.BoxGeometry(width + 2 * overhang, 0.15, run, 12, 1, 6), roof);
    slab.rotation.x = side * slope;
    const along = run / 2 - overhang * 0.2;
    slab.position.set(0, height + ridge - Math.sin(slope) * along + 0.1, side * Math.cos(slope) * along);
    // Gutter under the eave.
    const gutter = add(
      new THREE.CylinderGeometry(0.09, 0.09, width + 2 * overhang, 12, 1, true, 0, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x8a9096, metalness: 0.8, roughness: 0.35, side: THREE.DoubleSide }),
    );
    gutter.rotation.set(Math.PI, 0, Math.PI / 2);
    gutter.position.set(0, height - Math.tan(slope) * overhang + 0.02, side * (depth / 2 + overhang - 0.05));
  }
  add(new THREE.BoxGeometry(0.8, 2, 0.8), walls, width * 0.25, height + ridge * 0.9, -depth * 0.15);

  // Windows: white frames proud of the wall, clear glass set back into the opening.
  const frame = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xb8ccd8, roughness: 0.05, transparent: true, opacity: 0.3 });
  const window_ = (x: number, z: number, facing: number) => {
    const pane = new THREE.Group();
    const { width: w, height: h } = WINDOW;
    const bar = 0.1;
    const parts: Array<[number, number, number, number]> = [
      [0, h / 2, w + bar, bar],
      [0, -h / 2, w + bar, bar],
      [-w / 2, 0, bar, h],
      [w / 2, 0, bar, h],
      [0, 0, bar * 0.6, h],
      [0, 0, w, bar * 0.6],
    ];
    for (const [px, py, sx, sy] of parts) pane.add(new THREE.Mesh(new THREE.BoxGeometry(sx, sy, 0.12), frame).translateX(px).translateY(py).translateZ(0.04));
    pane.add(new THREE.Mesh(new THREE.PlaneGeometry(w, h), glass).translateZ(-0.08));
    pane.position.set(x, WINDOW.y, z);
    pane.rotation.y = facing;
    group.add(pane);
  };
  for (const x of WINDOW.xs) {
    window_(x, depth / 2 + 0.01, 0);
    window_(x, -depth / 2 - 0.01, Math.PI);
  }
  for (const side of [-1, 1]) for (const z of WINDOW.zs) window_(side * (width / 2 + 0.01), z, side * (Math.PI / 2));
  // Door with a step.
  add(new THREE.BoxGeometry(1.1, 2.2, 0.12), new THREE.MeshStandardMaterial({ color: 0x5a3820, roughness: 0.7 }), -1.5, 1.1, depth / 2 + 0.03);
  add(new THREE.BoxGeometry(1.6, 0.2, 0.6), new THREE.MeshStandardMaterial({ color: 0x9a968e, roughness: 0.9 }), -1.5, 0.1, depth / 2 + 0.3);
  return group;
}

/**
 * The authored low mesh for `house`: one closed hull of walls, roof and floor (the
 * house's cross-section, extruded along it), closed where the house is.
 */
export function houseShell(): THREE.Object3D {
  const { width, depth, wall: height, ridge } = HOUSE;
  // Cross-section in (z, y), counter-clockwise seen from +x.
  type Point = readonly [z: number, y: number];
  const a: Point = [depth / 2, 0];
  const b: Point = [depth / 2, height];
  const c: Point = [0, height + ridge];
  const d: Point = [-depth / 2, height];
  const e: Point = [-depth / 2, 0];
  const section = [a, b, c, d, e];
  const vertex = (x: number, [z, y]: Point) => [x, y, z];
  const positions: number[] = [];
  const triangle = (...corners: number[][]) => positions.push(...corners.flat());
  const front = width / 2;
  // Gable ends: the pentagon as three triangles, facing +x and -x.
  for (const [p, q, r] of [
    [a, b, e],
    [b, d, e],
    [b, c, d],
  ] as const) {
    triangle(vertex(front, p), vertex(front, r), vertex(front, q));
    triangle(vertex(-front, p), vertex(-front, q), vertex(-front, r));
  }
  // Sides between consecutive section points, the floor (e → a) included.
  section.forEach((p, i) => {
    const q = at(section, (i + 1) % section.length);
    triangle(vertex(front, p), vertex(front, q), vertex(-front, q));
    triangle(vertex(front, p), vertex(-front, q), vertex(-front, p));
  });
  const geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry);
}

// --- the house's interior: its own asset, one child per room --------------------------

/** Vertical stripes of `a` and `b`: wallpaper. */
function stripes(a: string, b: string): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = context2d(canvas);
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = b;
  for (let x = 0; x < 64; x += 16) ctx.fillRect(x, 0, 6, 64);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}

/**
 * The rooms behind the house's windows, in the house's space: three rooms side by side
 * along x, each filling its box inside the walls, from the floor to a ceiling above the
 * windows, with furniture. Rooms are seen from inside: their walls face in.
 */
export function houseInterior(): THREE.Object3D {
  const { width, depth, thickness } = HOUSE;
  const height = 3.6;
  const inner = { x: width / 2 - thickness, z: depth / 2 - thickness };
  // Room walls sit a hair inside the house's, so the two never z-fight.
  const inset = 0.005;
  const splits = [-inner.x, -1.6, 1.6, inner.x];
  const papers = [
    ["#d9c9a3", "#c4b088"],
    ["#a9c4d9", "#8fb0c8"],
    ["#d9a9b4", "#c48f9c"],
  ] as const;
  const floor = new THREE.MeshStandardMaterial({ map: tiled(stripes("#8a5a32", "#6e4526"), 6, 6), roughness: 0.6, side: THREE.BackSide });
  const ceiling = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.9, side: THREE.BackSide });
  const wood = new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 });
  const cloth = [0x3d6e8f, 0x8f3d4e, 0x5e8f3d].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffe0a0, emissiveIntensity: 1 });
  const interior = new THREE.Group();
  interior.name = "interior";
  papers.forEach(([a, b], i) => {
    const x0 = at(splits, i) + inset;
    const x1 = at(splits, i + 1) - inset;
    const w = x1 - x0;
    const d = 2 * (inner.z - inset);
    const paper = new THREE.MeshStandardMaterial({ map: tiled(stripes(a, b), w / 1.5, height / 1.5), roughness: 0.9, side: THREE.BackSide });
    const room = new THREE.Group();
    room.name = `room ${i}`;
    room.position.set((x0 + x1) / 2, 0, 0);
    // +x, -x, ceiling, floor, +z, -z
    const shell = new THREE.Mesh(new THREE.BoxGeometry(w, height - inset, d), [paper, paper, ceiling, floor, paper, paper]);
    shell.position.y = (height + inset) / 2;
    room.add(shell);
    const piece = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) =>
      room.add(new THREE.Mesh(geometry, material).translateX(x).translateY(y).translateZ(z));
    // A shelf against the back wall, a sofa facing it, a table, a lamp.
    piece(new THREE.BoxGeometry(Math.min(2, w - 0.6), 2.2, 0.4), wood, 0, 1.1, -d / 2 + 0.2);
    piece(new THREE.BoxGeometry(Math.min(2.2, w - 0.6), 0.8, 0.9), at(cloth, i % cloth.length), 0, 0.4, d / 2 - 1.2);
    piece(new THREE.BoxGeometry(1.0, 0.7, 0.6), wood, (i - 1) * 0.4, 0.35, 0);
    piece(new THREE.SphereGeometry(0.25, 16, 8), lamp, 0, height - 0.6, 0);
    interior.add(room);
  });
  return interior;
}
