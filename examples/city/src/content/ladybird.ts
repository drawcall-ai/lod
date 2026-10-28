import * as THREE from "three/webgpu";
import { MeshBuilder, Parts, tint, tube } from "./geometry.ts";
import { once } from "./materials.ts";

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
export function ladybird(): THREE.Group {
  const parts = new Parts();
  // elytra are centred 0.9 mm behind the origin; the pronotum abuts their front edge
  parts.add(shellMaterial(), dome({ hw: 2.7, hl: 2.85, height: 2.1, z: -0.9, y: clearance, taper: 0.08, exponent: 0.55, lip: 0.1, seam: 0.035 }));
  parts.add(
    blackMaterial(),
    tint(
      new THREE.CircleGeometry(1, 48)
        .scale(2.6, 2.75, 1)
        .rotateX(Math.PI / 2)
        .translate(0, clearance + 0.01, -0.9),
      ink,
    ),
  );
  // pronotum: its back emerges from the steep front of the elytra, its front edge hugs the head
  parts.add(pronotumMaterial(), dome({ hw: 1.7, hl: 0.75, height: 0.8, z: 1.95, y: clearance + 0.1, taper: 0.32, exponent: 0.6, lip: 0, seam: 0 }));
  // head: tucked under the pronotum's front edge, only its front showing
  parts.add(headMaterial(), dome({ hw: 0.6, hl: 0.38, height: 0.4, z: 2.62, y: clearance, taper: 0.2, exponent: 0.6, lip: 0, seam: 0 }));

  // antennae: short and clubbed, folded back under the head
  for (const s of [-1, 1]) {
    const base = new THREE.Vector3(s * 0.4, clearance + 0.08, 2.8);
    const curve = new THREE.QuadraticBezierCurve3(
      base,
      base.clone().add(new THREE.Vector3(s * 0.25, 0.02, 0.15)),
      base.clone().add(new THREE.Vector3(s * 0.55, -0.08, 0.05)),
    );
    parts.add(
      blackMaterial(),
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
        blackMaterial(),
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
        blackMaterial(),
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
        blackMaterial(),
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

export function ladybirdMaterial(name: string, relief?: Uint8Array): THREE.Material | undefined {
  switch (name) {
    case "ladybird-black":
      return blackMaterial();
    case "ladybird-elytra":
      return shellMaterial(relief);
    case "ladybird-pronotum":
      return pronotumMaterial();
    case "ladybird-head":
      return headMaterial();
    default:
      return undefined;
  }
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

/** Black chitin: glossy but not mirror-like. */
const blackMaterial = once(
  () =>
    new THREE.MeshPhysicalMaterial({ name: "ladybird-black", color: "#0d0d0c", vertexColors: true, roughness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.2 }),
);

/** Elytra: lacquer red with the spot pattern and a finely dimpled clear coat. */
let shell: THREE.MeshPhysicalMaterial | undefined;
function shellMaterial(pixels?: Uint8Array): THREE.MeshPhysicalMaterial {
  if (shell) return shell;
  const relief = pixels ? normalTexture(pixels, 2048) : dimples(2048, 9000, 2.2, 0.0012);
  shell = new THREE.MeshPhysicalMaterial({
    name: "ladybird-elytra",
    map: paint(1024, (g, w) => {
      const base = g.createRadialGradient(w * 0.5, w * 0.45, w * 0.05, w * 0.5, w * 0.5, w * 0.55);
      base.addColorStop(0, "#d8341a");
      base.addColorStop(0.85, "#c0240f");
      base.addColorStop(1, "#8e1a0c");
      g.fillStyle = base;
      g.fillRect(0, 0, w, w);
      // [x across from the suture, z forward, radius] in footprint units: one spot shared
      // across the suture at the front, then shoulder, middle (largest) and rear on each side
      const spots: [number, number, number][] = [[0, 0.8, 0.17]];
      for (const s of [-1, 1]) spots.push([s * 0.58, 0.45, 0.14], [s * 0.46, -0.02, 0.21], [s * 0.36, -0.52, 0.15]);
      g.fillStyle = "#14100e";
      // a soft edge: pigment, not a printed decal
      g.filter = "blur(1.5px)";
      for (const [x, z, r] of spots) blob(g, w, x, z, r);
      g.filter = "none";
      g.fillStyle = "rgba(40,6,2,0.85)";
      g.fillRect(w * 0.4975, w * 0.08, w * 0.005, w * 0.92);
    }),
    // the punctation lies under the lacquer-like coat: it only breaks up the highlight, and
    // spots and red share the one coat, so they reflect identically
    clearcoatNormalMap: relief,
    clearcoatNormalScale: new THREE.Vector2(0.35, 0.35),
    roughness: 0.55,
    clearcoat: 1,
    clearcoatRoughness: 0.15,
  });
  return shell;
}

/** Pronotum: black with the cream patches in its front corners. */
const pronotumMaterial = once(
  () =>
    new THREE.MeshPhysicalMaterial({
      name: "ladybird-pronotum",
      map: paint(512, (g, w) => {
        g.fillStyle = "#0d0d0c";
        g.fillRect(0, 0, w, w);
        g.fillStyle = "#ede5cf";
        for (const s of [-1, 1]) blob(g, w, s * 0.7, 0.5, 0.2);
      }),
      roughness: 0.35,
      clearcoat: 1,
      clearcoatRoughness: 0.15,
    }),
);

/** Head: black with two small pale spots between the eyes. */
const headMaterial = once(
  () =>
    new THREE.MeshPhysicalMaterial({
      name: "ladybird-head",
      map: paint(256, (g, w) => {
        g.fillStyle = "#0d0d0c";
        g.fillRect(0, 0, w, w);
        g.fillStyle = "#e3dcc6";
        for (const s of [-1, 1]) blob(g, w, s * 0.42, 0.25, 0.15);
      }),
      roughness: 0.3,
      clearcoat: 0.8,
      clearcoatRoughness: 0.15,
    }),
);

/** Paints a square canvas texture whose u/v match the dome's footprint coordinates. */
function paint(size: number, draw: (g: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("2d canvas unavailable");
  draw(g, size);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** A slightly irregular round spot at footprint coordinates (x, z ∈ [-1, 1]); r in the same units. */
function blob(g: CanvasRenderingContext2D, size: number, x: number, z: number, r: number) {
  const cx = (0.5 + x / 2) * size;
  // a canvas texture is flipped on upload, so v (forward) runs up the image
  const cy = (0.5 - z / 2) * size;
  g.beginPath();
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const k = 1 + 0.05 * Math.sin(a * 3 + x * 7) + 0.03 * Math.sin(a * 5 + z * 11);
    const px = cx + Math.cos(a) * (r / 2) * size * k;
    const py = cy + Math.sin(a) * (r / 2) * size * k;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.fill();
}

/** A normal map of shallow round punctures scattered over the surface, as on beetle cuticle. */
function dimples(size: number, count: number, radius: number, depth: number): THREE.DataTexture {
  const height = new Float32Array(size * size);
  let seed = 9;
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let k = 0; k < count; k++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const r = radius * (0.7 + 0.6 * rand());
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d >= 1) continue;
        const i = ((y + size) % size) * size + ((x + size) % size);
        height[i] = (height[i] ?? 0) - depth * size * (1 - d * d) ** 2;
      }
    }
  }
  const data = new Uint8Array(size * size * 4);
  const n = new THREE.Vector3();
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)] ?? 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      n.set(-(at(x + 1, y) - at(x - 1, y)), -(at(x, y + 1) - at(x, y - 1)), 1).normalize();
      const i = (y * size + x) * 4;
      data[i] = Math.round((n.x * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((n.y * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((n.z * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  return normalTexture(data, size);
}

function normalTexture(data: Uint8Array, size: number): THREE.DataTexture {
  if (data.length !== size * size * 4) throw new Error("Invalid ladybird normal map");
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
