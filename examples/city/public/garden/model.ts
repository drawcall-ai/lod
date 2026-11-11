import * as THREE from "three/webgpu";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { glass, paints, surface } from "./materials.ts";

// Things in a garden besides plants: buildings, furniture and the odds and ends of
// family life. Each stands on y = 0, its front toward +z.

/**
 * A garden shed, 2.4 × 1.8 m, its door on the front (+z): plank walls on a concrete
 * footing, a pitched roof of corrugated iron with a little overhang.
 */
export function shed(manager: THREE.LoadingManager, color: THREE.ColorRepresentation): THREE.Group {
  const parts = new Parts();
  const planks = surface(manager, "white_planks_clean", { color, weather: 0.9, roughness: 1.2 });
  const iron = surface(manager, "corrugated_iron", { normalScale: 1.5, weather: 0.8 });
  const concrete = surface(manager, "brushed_concrete_04", { weather: 0.6 });
  const w = 2.4;
  const d = 1.8;
  const h = 2.0;
  const pitch = 0.45;
  parts.add(concrete, box(w + 0.1, 0.1, d + 0.1).translate(0, 0.05, 0));
  parts.add(planks, box(w, h, d).translate(0, 0.1 + h / 2, 0));
  // gable ends under the ridge (the ridge runs along x)
  const gable = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, (d / 2) * Math.tan(pitch))]);
  for (const s of [-1, 1]) parts.add(planks, new THREE.ShapeGeometry(gable).rotateY(s * (Math.PI / 2)).translate((s * w) / 2, 0.1 + h, 0));
  const slope = d / 2 / Math.cos(pitch) + 0.15;
  for (const s of [-1, 1])
    parts.add(
      iron,
      box(w + 0.3, 0.03, slope)
        .translate(0, 0, slope / 2)
        .rotateX(s > 0 ? pitch : Math.PI - pitch)
        .translate(0, 0.1 + h + (d / 2) * Math.tan(pitch) + 0.02, 0),
    );
  parts.add(surface(manager, "distressed_painted_planks", { weather: 0.8 }), box(0.85, 1.75, 0.04).translate(0.4, 0.1 + 0.875, d / 2 + 0.02));
  return parts.build("shed");
}

/** A letterbox on a post by the garden gate: a painted metal box with a slot and a rounded lid. */
export function letterbox(manager: THREE.LoadingManager): THREE.Group {
  const parts = new Parts();
  const post = surface(manager, "wood_table_001", { color: "#6b5a48", weather: 0.8 });
  const metal = paints.letterbox();
  const dark = paints.slot();
  parts.add(post, box(0.08, 1.05, 0.08).translate(0, 0.525, 0));
  parts.add(metal, box(0.3, 0.32, 0.38).translate(0, 1.2, 0));
  parts.add(
    metal,
    new THREE.CylinderGeometry(0.15, 0.15, 0.38, 12, 1, false, 0, Math.PI)
      .rotateX(Math.PI / 2)
      .rotateZ(Math.PI / 2)
      .translate(0, 1.36, 0),
  );
  parts.add(dark, box(0.2, 0.025, 0.01).translate(0, 1.26, 0.195));
  return parts.build("letterbox");
}

/** A small greenhouse, 2.5 × 1.9 m: an aluminium frame, glass walls and roof on a low brick base. */
export function greenhouse(manager: THREE.LoadingManager): THREE.Group {
  const parts = new Parts();
  const frame = paints.aluminium();
  const brick = surface(manager, "red_brick", { weather: 0.8 });
  const panes = glass();
  const w = 2.5;
  const d = 1.9;
  const h = 1.6;
  const ridge = 0.6;
  parts.add(brick, box(w, 0.4, d).translate(0, 0.2, 0));
  for (const x of [-w / 2, -w / 6, w / 6, w / 2]) for (const z of [-d / 2, d / 2]) parts.add(frame, box(0.04, h, 0.04).translate(x, 0.4 + h / 2, z));
  parts.add(frame, box(w, 0.04, 0.04).translate(0, 0.4 + h + ridge, 0));
  for (const s of [-1, 1]) parts.add(frame, box(w, 0.04, 0.04).translate(0, 0.4 + h, (s * d) / 2));
  const pane = (width: number, height: number) => new THREE.PlaneGeometry(width, height);
  for (const s of [-1, 1]) {
    parts.add(panes, pane(w, h).translate(0, 0.4 + h / 2, (s * d) / 2));
    parts.add(
      panes,
      pane(d, h)
        .rotateY(Math.PI / 2)
        .translate((s * w) / 2, 0.4 + h / 2, 0),
    );
    const slope = Math.hypot(d / 2, ridge);
    parts.add(
      panes,
      pane(w, slope)
        .rotateX(-Math.PI / 2 + s * Math.atan2(ridge, d / 2))
        .translate(0, 0.4 + h + ridge / 2, (s * d) / 4),
    );
  }
  // tomatoes inside: a row of green
  parts.add(paints.plants(), box(w - 0.4, 0.9, 0.5).translate(0, 0.85, -d / 4));
  return parts.build("greenhouse");
}

/** A swing frame: two A-frames of timber, a beam, and two seats on ropes. */
export function swing(manager: THREE.LoadingManager): THREE.Group {
  const parts = new Parts();
  const timber = surface(manager, "wood_table_001", { color: "#8a6a4a", weather: 0.7 });
  const rope = paints.rope();
  const seat = paints.seat();
  const h = 2.1;
  const span = 2.4;
  for (const x of [-span / 2, span / 2])
    for (const s of [-1, 1])
      parts.add(
        timber,
        box(0.08, 2.25, 0.08)
          .rotateX(s * 0.32)
          .translate(x, h / 2, s * 0.35),
      );
  parts.add(timber, box(span + 0.2, 0.1, 0.1).translate(0, h, 0));
  for (const x of [-0.55, 0.55]) {
    for (const dx of [-0.2, 0.2]) parts.add(rope, new THREE.CylinderGeometry(0.008, 0.008, 1.6, 4).translate(x + dx, h - 0.8, 0));
    parts.add(seat, box(0.45, 0.03, 0.18).translate(x, h - 1.6, 0));
  }
  return parts.build("swing");
}

/** A washing line between two posts, with a row of washing pegged to it. */
export function washingLine(): THREE.Group {
  const parts = new Parts();
  const post = paints.post();
  const line = paints.line();
  const cloth = paints.washing();
  const length = 5;
  for (const x of [-length / 2, length / 2]) parts.add(post, new THREE.CylinderGeometry(0.03, 0.03, 1.9, 6).translate(x, 0.95, 0));
  parts.add(line, new THREE.CylinderGeometry(0.004, 0.004, length, 4).rotateZ(Math.PI / 2).translate(0, 1.82, 0));
  const colors = ["#f2f2ee", "#7b9bc4", "#e3c25a", "#c45a5a", "#f2f2ee", "#6f8a6a"];
  colors.forEach((c, i) => {
    const w = 0.5 + (i % 3) * 0.15;
    const h = 0.4 + (i % 2) * 0.3;
    parts.add(cloth, tint(new THREE.PlaneGeometry(w, h).translate(-length / 2 + 0.6 + i * 0.75, 1.8 - h / 2, 0), new THREE.Color(c)));
  });
  return parts.build("washing line");
}

/** A patio set: a round table and four chairs, white painted metal. */
export function patioSet(): THREE.Group {
  const parts = new Parts();
  const paint = paints["garden furniture"]();
  parts.add(paint, new THREE.CylinderGeometry(0.45, 0.45, 0.03, 20).translate(0, 0.72, 0));
  parts.add(paint, new THREE.CylinderGeometry(0.03, 0.03, 0.72, 8).translate(0, 0.36, 0));
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + 0.3;
    const m = new THREE.Matrix4().makeRotationY(-a).setPosition(Math.cos(a) * 0.75, 0, Math.sin(a) * 0.75);
    parts.add(paint, box(0.42, 0.03, 0.42).translate(0, 0.45, 0).applyMatrix4(m));
    parts.add(paint, box(0.42, 0.45, 0.03).translate(0, 0.68, 0.2).applyMatrix4(m));
    for (const [x, z] of [
      [-0.18, -0.18],
      [0.18, -0.18],
      [-0.18, 0.18],
      [0.18, 0.18],
    ] as const)
      parts.add(paint, box(0.025, 0.45, 0.025).translate(x, 0.225, z).applyMatrix4(m));
  }
  return parts.build("patio set");
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
