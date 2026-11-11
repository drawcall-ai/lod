import * as THREE from "three/webgpu";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { type Materials, surface } from "../shared/materials.ts";

const plate = { w: 0.76, h: 0.17, corner: 0.02, thick: 0.002 };

/**
 * A street-name sign: a galvanised post with a domed cap, a cast bracket on top holding an
 * aluminium blade, printed on both faces with the name in white on green reflective sheeting.
 */
export function streetSign(materials: Materials, text: string): THREE.Group {
  const parts = new Parts();
  const galvanised = surface(materials, "metal_plate_02", { albedo: false, color: "#b9bdbd", metalness: 1, normalScale: 0.25, roughness: 0.8, weather: 0.6 });
  const height = 2.55;
  parts.add(galvanised, new THREE.CylinderGeometry(0.03, 0.03, height, 20).translate(0, height / 2, 0));
  parts.add(galvanised, new THREE.SphereGeometry(0.032, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, height, 0));
  parts.add(galvanised, new THREE.CylinderGeometry(0.036, 0.036, 0.1, 20).translate(0, height - 0.12, 0));
  parts.add(galvanised, box(0.05, 0.04, 0.012).translate(0, height + 0.01, 0));

  const y = height + 0.03 + plate.h / 2;
  parts.add(galvanised, box(plate.w * 0.9, 0.012, 0.012).translate(0, y - plate.h / 2 - 0.006, 0));
  parts.add(galvanised, box(plate.w * 0.9, 0.012, 0.012).translate(0, y + plate.h / 2 + 0.006, 0));
  const outline = roundedRect(plate.w, plate.h, plate.corner);
  const blade = new THREE.ExtrudeGeometry(outline, { depth: plate.thick, bevelEnabled: false, curveSegments: 4 });
  parts.add(galvanised, blade.translate(0, y, -plate.thick / 2));
  const face = faceMaterial(materials, text);
  for (const side of [0, 1]) {
    const g = new THREE.ShapeGeometry(outline, 4);
    const uv = g.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / plate.w + 0.5, uv.getY(i) / plate.h + 0.5);
    g.translate(0, 0, plate.thick / 2 + 0.0003)
      .rotateY(side * Math.PI)
      .translate(0, y, 0);
    parts.add(face, g);
  }
  return parts.build("sign");
}

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return s;
}

/** Reflective sheeting printed with a border and the street name, plus faint grime. */
function faceMaterial(materials: Materials, text: string): THREE.Material {
  return materials.material(`sign:${text}`, () => {
    const w = 1600;
    const h = Math.round((w * plate.h) / plate.w);
    const map = new THREE.DataTexture(face(text, w, h), w, h);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    map.generateMipmaps = true;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.magFilter = THREE.LinearFilter;
    map.needsUpdate = true;
    return new THREE.MeshStandardMaterial({ name: "street-sign", map, roughness: 0.38, metalness: 0 });
  });
}

const GREEN = [0x0f, 0x6b, 0x3d];
const WHITE = [0xf4, 0xf4, 0xee];
const GRIME = [60, 50, 30];

/**
 * The face's sRGB pixels, `w` × `h` with the first row at the bottom, as a DataTexture reads them: a white rounded
 * border on green, the name in white capitals of FONT centred on it, and grime darkening toward the bottom edge.
 */
function face(text: string, w: number, h: number): Uint8Array {
  const inset = h * 0.07;
  const line = h * 0.035;
  const radius = h * 0.08;
  const glyphs = [...text.toUpperCase()].map((char) => {
    const glyph = FONT[char];
    if (!glyph) throw new Error(`The sign font has no ${JSON.stringify(char)}`);
    return glyph;
  });
  const columns = glyphs.length * 6 - 1;
  // Pixels per font cell: the capitals fill 56% of the height, narrowed to fit inside the border.
  const cell = Math.min((h * 0.56) / 7, (w - 6 * inset) / columns);
  const left = (w - columns * cell) / 2;
  const top = h * 0.53 - 3.5 * cell;
  const data = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    // Measured from the top, as the face is drawn.
    const y = h - 1 - row + 0.5;
    const grime = (y / h) * 0.12;
    for (let x = 0; x < w; x++) {
      const border = Math.abs(roundedBox(x + 0.5 - w / 2, y - h / 2, w / 2 - inset, h / 2 - inset, radius)) < line / 2;
      const color = border || inked(glyphs, (x + 0.5 - left) / cell, (y - top) / cell) ? WHITE : GREEN;
      const at = (row * w + x) * 4;
      for (let c = 0; c < 3; c++) data[at + c] = Math.round((color[c] ?? 0) * (1 - grime) + (GRIME[c] ?? 0) * grime);
      data[at + 3] = 255;
    }
  }
  return data;
}

/** The signed distance from (x, y) to a box of half size (bx, by) about the origin with corners of `radius`. */
function roundedBox(x: number, y: number, bx: number, by: number, radius: number): number {
  const qx = Math.abs(x) - bx + radius;
  const qy = Math.abs(y) - by + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Whether font cell (column, row) of `glyphs` laid side by side, a blank column between them, is inked. */
function inked(glyphs: readonly string[][], column: number, row: number): boolean {
  if (column < 0 || row < 0 || row >= 7) return false;
  const glyph = glyphs[Math.floor(column / 6)];
  return glyph?.[Math.floor(row)]?.[Math.floor(column % 6)] === "#";
}

/** A 5 × 7 pixel font of capitals, rows from the top. */
const FONT: Record<string, string[]> = {
  A: [" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  B: ["#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "],
  C: [" ### ", "#   #", "#    ", "#    ", "#    ", "#   #", " ### "],
  D: ["#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "],
  E: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"],
  F: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "],
  G: [" ### ", "#   #", "#    ", "# ###", "#   #", "#   #", " ####"],
  H: ["#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  I: [" ### ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  J: ["  ###", "   # ", "   # ", "   # ", "   ##", "   # ", "###  "],
  K: ["#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"],
  L: ["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
  M: ["#   #", "## ##", "# # #", "#   #", "#   #", "#   #", "#   #"],
  N: ["#   #", "##  #", "# # #", "#  ##", "#   #", "#   #", "#   #"],
  O: [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  P: ["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "],
  Q: [" ### ", "#   #", "#   #", "#   #", "# # #", "#  # ", " ## #"],
  R: ["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"],
  S: [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
  U: ["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  V: ["#   #", "#   #", "#   #", "#   #", "#   #", " # # ", "  #  "],
  W: ["#   #", "#   #", "#   #", "# # #", "# # #", "# # #", " # # "],
  X: ["#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"],
  Y: ["#   #", "#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "],
  Z: ["#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"],
  " ": ["     ", "     ", "     ", "     ", "     ", "     ", "     "],
  ".": ["     ", "     ", "     ", "     ", "     ", "##   ", "##   "],
};

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
