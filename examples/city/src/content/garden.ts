import * as THREE from "three/webgpu";
import { box, Parts, tint } from "./geometry.ts";
import { glass } from "./house/materials.ts";
import { once, surface } from "./materials.ts";

const materials = {
  letterbox: once(() => new THREE.MeshStandardMaterial({ name: "letterbox", color: "#2f3d33", roughness: 0.45, metalness: 0.6 })),
  slot: once(() => new THREE.MeshStandardMaterial({ name: "slot", color: "#111111", roughness: 0.8 })),
  aluminium: once(() => new THREE.MeshStandardMaterial({ name: "aluminium", color: "#b8bcbd", metalness: 1, roughness: 0.4 })),
  plants: once(() => new THREE.MeshStandardMaterial({ name: "plants", color: "#3d6b2a", roughness: 0.9 })),
  rope: once(() => new THREE.MeshStandardMaterial({ name: "rope", color: "#c8b88a", roughness: 0.9 })),
  seat: once(() => new THREE.MeshStandardMaterial({ name: "seat", color: "#b03a2e", roughness: 0.6 })),
  post: once(() => new THREE.MeshStandardMaterial({ name: "post", color: "#9da3a5", metalness: 0.8, roughness: 0.5 })),
  line: once(() => new THREE.MeshStandardMaterial({ name: "line", color: "#e8e8e0", roughness: 0.7 })),
  washing: once(() => new THREE.MeshStandardMaterial({ name: "washing", vertexColors: true, roughness: 0.9, side: THREE.DoubleSide })),
  "garden furniture": once(() => new THREE.MeshStandardMaterial({ name: "garden furniture", color: "#ecebe6", metalness: 0.3, roughness: 0.5 })),
};

export function gardenMaterial(name: string): THREE.Material | undefined {
  return Object.entries(materials).find(([key]) => key === name)?.[1]();
}

// Things in a garden besides plants: buildings, furniture and the odds and ends of
// family life. Each stands on y = 0, its front toward +z.

/**
 * A garden shed, 2.4 × 1.8 m, its door on the front (+z): plank walls on a concrete
 * footing, a pitched roof of corrugated iron with a little overhang.
 */
export function shed(color: THREE.ColorRepresentation): THREE.Group {
  const parts = new Parts();
  const planks = surface("white_planks_clean", { color, weather: 0.9, roughness: 1.2 });
  const iron = surface("corrugated_iron", { normalScale: 1.5, weather: 0.8 });
  const concrete = surface("brushed_concrete_04", { weather: 0.6 });
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
  parts.add(surface("distressed_painted_planks", { weather: 0.8 }), box(0.85, 1.75, 0.04).translate(0.4, 0.1 + 0.875, d / 2 + 0.02));
  return parts.build("shed");
}

/** A letterbox on a post by the garden gate: a painted metal box with a slot and a rounded lid. */
export function letterbox(): THREE.Group {
  const parts = new Parts();
  const post = surface("wood_table_001", { color: "#6b5a48", weather: 0.8 });
  const metal = materials["letterbox"]();
  const dark = materials["slot"]();
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
export function greenhouse(): THREE.Group {
  const parts = new Parts();
  const frame = materials["aluminium"]();
  const brick = surface("red_brick", { weather: 0.8 });
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
    parts.add(glass(), pane(w, h).translate(0, 0.4 + h / 2, (s * d) / 2));
    parts.add(
      glass(),
      pane(d, h)
        .rotateY(Math.PI / 2)
        .translate((s * w) / 2, 0.4 + h / 2, 0),
    );
    const slope = Math.hypot(d / 2, ridge);
    parts.add(
      glass(),
      pane(w, slope)
        .rotateX(-Math.PI / 2 + s * Math.atan2(ridge, d / 2))
        .translate(0, 0.4 + h + ridge / 2, (s * d) / 4),
    );
  }
  // tomatoes inside: a row of green
  parts.add(materials["plants"](), box(w - 0.4, 0.9, 0.5).translate(0, 0.85, -d / 4));
  return parts.build("greenhouse");
}

/** A swing frame: two A-frames of timber, a beam, and two seats on ropes. */
export function swing(): THREE.Group {
  const parts = new Parts();
  const timber = surface("wood_table_001", { color: "#8a6a4a", weather: 0.7 });
  const rope = materials["rope"]();
  const seat = materials["seat"]();
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
  const post = materials["post"]();
  const line = materials["line"]();
  const cloth = materials["washing"]();
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
  const paint = materials["garden furniture"]();
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
