import * as THREE from "three";
import { box, Parts, tint } from "./geometry.ts";
import { surface } from "./materials.ts";
import { Random } from "./random.ts";

/**
 * A painted picket fence along +x from the origin: square posts with pyramid caps every
 * 2.4 m, two rails behind the pickets, pointed pickets with irregular wear.
 */
export function picketFence(length: number, seed = 1): THREE.Group {
  const r = new Random(seed);
  const parts = new Parts();
  const paint = surface("wood_table_001", { albedo: false, color: "#ffffff", vertexColors: true, normalScale: 0.4, roughness: 1.8, weather: 0.8 });
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
    const h = r.range(0.97, 1.01);
    const picket = new THREE.ExtrudeGeometry(outline, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 1 });
    picket
      .scale(1, h, 1)
      .rotateZ(r.range(-0.01, 0.01))
      .translate(x, 0.05, 0.08 + 0.003);
    parts.add(paint, tint(picket, shade(white, r)));
  }
  return parts.build("fence");
}

/** Paint varies a little from board to board; some boards are greyer with age. */
function shade(base: THREE.Color, r: Random): THREE.Color {
  const c = base.clone().offsetHSL(0, r.range(-0.02, 0.02), r.range(-0.05, 0.02));
  return r.chance(0.12) ? c.lerp(new THREE.Color("#b9b5a8"), r.range(0.2, 0.5)) : c;
}
