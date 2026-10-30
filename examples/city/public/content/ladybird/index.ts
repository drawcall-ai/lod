import type { Library } from "../materials.ts";
import * as THREE from "three/webgpu";
import { MeshBuilder, Parts, tint, tube } from "../geometry.ts";
import { blackMaterial, shellMaterial, pronotumMaterial, headMaterial } from "./materials.ts";

/** The model is laid out in millimetres and scaled to metres at the end. */
const mm = 0.001;
/** Height of the body's underside above the ground (mm). */
const clearance = 0.35;
const ink = new THREE.Color("#ffffff");

/**
 * A seven-spot ladybird (Coccinella septempunctata), 7 mm long, standing on y = 0 and facing
 * +z, in the proportions of macro photographs: slightly ovoid elytra (5.4 wide x 5.7 mm long,
 * 2.1 mm high) with a faint ridge along the suture and the spot pattern painted into the same
 * clear-coated surface; a thin, flattened pronotum shield with cream front corners that hides
 * most of the head; short antennae under the head; legs folded under the body so that at rest
 * mostly the tarsi show.
 */
export function ladybird(library: Library): THREE.Group {
  const parts = new Parts();
  // elytra are centred 0.9 mm behind the origin; the pronotum abuts their front edge
  parts.add(shellMaterial(library), dome({ hw: 2.7, hl: 2.85, height: 2.1, z: -0.9, y: clearance, taper: 0.08, exponent: 0.55, lip: 0.1, seam: 0.035 }));
  parts.add(
    blackMaterial(library),
    tint(
      new THREE.CircleGeometry(1, 48)
        .scale(2.6, 2.75, 1)
        .rotateX(Math.PI / 2)
        .translate(0, clearance + 0.01, -0.9),
      ink,
    ),
  );
  // pronotum: its back emerges from the steep front of the elytra, its front edge hugs the head
  parts.add(pronotumMaterial(library), dome({ hw: 1.7, hl: 0.75, height: 0.8, z: 1.95, y: clearance + 0.1, taper: 0.32, exponent: 0.6, lip: 0, seam: 0 }));
  // head: tucked under the pronotum's front edge, only its front showing
  parts.add(headMaterial(library), dome({ hw: 0.6, hl: 0.38, height: 0.4, z: 2.62, y: clearance, taper: 0.2, exponent: 0.6, lip: 0, seam: 0 }));

  // antennae: short and clubbed, folded back under the head
  for (const s of [-1, 1]) {
    const base = new THREE.Vector3(s * 0.4, clearance + 0.08, 2.8);
    const curve = new THREE.QuadraticBezierCurve3(
      base,
      base.clone().add(new THREE.Vector3(s * 0.25, 0.02, 0.15)),
      base.clone().add(new THREE.Vector3(s * 0.55, -0.08, 0.05)),
    );
    parts.add(
      blackMaterial(library),
      tube(
        curve,
        (t) => 0.03 + 0.05 * t ** 6,
        10,
        6,
        () => ink,
      ),
    );
  }
  // legs folded under the body: femur and tibia stay beneath the elytra, tarsi reach the rim
  for (const s of [-1, 1]) {
    for (const [i, z] of [1.3, 0.1, -1.2].entries()) {
      const forward = 1 - i;
      const hip = new THREE.Vector3(s * 0.7, clearance + 0.1, z);
      const knee = new THREE.Vector3(s * 1.75, clearance - 0.1, z + forward * 0.35);
      const ankle = new THREE.Vector3(s * 2.15, 0.08, z + forward * 0.7);
      const toe = new THREE.Vector3(s * 2.6, 0.03, z + forward * 1.0 + (forward === 0 ? 0.2 : 0));
      parts.add(
        blackMaterial(library),
        tube(
          new THREE.LineCurve3(hip, knee),
          (t) => 0.17 - 0.04 * t,
          8,
          8,
          () => ink,
          0.6,
        ),
      );
      parts.add(
        blackMaterial(library),
        tube(
          new THREE.LineCurve3(knee, ankle),
          (t) => 0.11 - 0.03 * t,
          8,
          8,
          () => ink,
          0.7,
        ),
      );
      // three tarsal segments, each swelling then pinching
      parts.add(
        blackMaterial(library),
        tube(
          new THREE.LineCurve3(ankle, toe),
          (t) => 0.045 + 0.035 * Math.abs(Math.sin(t * Math.PI * 3)),
          18,
          6,
          () => ink,
          0.6,
        ),
      );
    }
  }
  const group = parts.build("ladybird");
  group.scale.setScalar(mm);
  return group;
}

interface DomeShape {
  /** Half width and half length of the footprint (mm). */
  hw: number;
  hl: number;
  height: number;
  /** Centre of the footprint along z, and height of its rim. */
  z: number;
  y: number;
  /** How much narrower the front (+z) is than the back. */
  taper: number;
  /** Profile exponent: 0.5 is elliptical, larger is flatter-topped with steeper sides. */
  exponent: number;
  /** Height of the flat rim at the edge, relative to `height` (0 for none). */
  lip: number;
  /** Height of the ridge along the midline (mm), where the elytra meet. */
  seam: number;
}

/**
 * Height of the dome at normalised radius rho: elliptical-ish, with the last few percent
 * flattened into a narrow lip (the explanate margin of the elytra) that ends in a short edge.
 */
function profile(rho: number, x: number, s: DomeShape): number {
  const dome = s.height * Math.max(0, 1 - rho * rho) ** s.exponent + s.seam * Math.exp(-((x / 0.07) ** 2)) * (1 - rho);
  const lip = s.height * s.lip * THREE.MathUtils.smoothstep(rho, 0.86, 0.97);
  return rho < 1 ? Math.max(dome, lip) : 0;
}

/** A dome over an egg-shaped footprint, with planar top-down UVs (u across, v from back to front). */
function dome(s: DomeShape): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const rings = 48;
  const around = 96;
  const p = new THREE.Vector3();
  const grid: number[][] = [];
  for (let i = 0; i <= rings; i++) {
    const rho = i / rings;
    const row: number[] = [];
    for (let j = 0; j <= around; j++) {
      const a = (j / around) * Math.PI * 2;
      const fz = Math.sin(a);
      const x = rho * Math.cos(a) * s.hw * (1 - s.taper * Math.max(0, fz));
      const z = rho * fz * s.hl;
      p.set(x, s.y + profile(rho, x, s), s.z + z);
      row.push(b.vertex(p, 0.5 + x / (2 * s.hw), 0.5 + z / (2 * s.hl), ink));
    }
    grid.push(row);
  }
  for (let i = 0; i < rings; i++) {
    const a = grid[i];
    const c = grid[i + 1];
    if (!a || !c) break;
    for (let j = 0; j < around; j++) b.quad(a[j] ?? 0, a[j + 1] ?? 0, c[j + 1] ?? 0, c[j] ?? 0);
  }
  return b.geometry();
}
