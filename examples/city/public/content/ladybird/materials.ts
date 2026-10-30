import type { GLTSSource } from "@drawcall/glts";
import * as THREE from "three/webgpu";
import { type Library } from "../materials.ts";
import { file, pixelMaterial } from "../cache.ts";

const SHELL = "ladybird-elytra";
const RELIEF = 2048;

/** Black chitin: glossy but not mirror-like. */
export const blackMaterial = (library: Library) =>
  library.material(
    "ladybird/materials.ts:blackMaterial",
    () =>
      new THREE.MeshPhysicalMaterial({
        name: "ladybird-black",
        color: "#0d0d0c",
        vertexColors: true,
        roughness: 0.35,
        clearcoat: 0.7,
        clearcoatRoughness: 0.2,
      }),
  );

/** `shellMaterial`, its dimples generated once and then cached. */
export const cachedShell = (source: GLTSSource, library: Library) =>
  pixelMaterial(source, library, {
    version: "ladybird-normal@1",
    name: SHELL,
    sizes: { normal: RELIEF * RELIEF * 4 },
    make: (library, pixels) => shellMaterial(library, pixels && file(pixels, "normal")),
    maps: (shell) => {
      if (!(shell instanceof THREE.MeshPhysicalMaterial)) throw new Error("Ladybird shell is not a physical material");
      return { normal: shell.clearcoatNormalMap };
    },
  });

/** Elytra: lacquer red with the spot pattern and a finely dimpled clear coat. */
export const shellMaterial = (library: Library, pixels?: Uint8Array) =>
  library.material("ladybird/materials.ts:shellMaterial", () => {
    const relief = pixels ? normalTexture(pixels, RELIEF) : dimples(RELIEF, 9000, 2.2, 0.0012);
    return new THREE.MeshPhysicalMaterial({
      name: SHELL,
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
  });

/** Pronotum: black with the cream patches in its front corners. */
export const pronotumMaterial = (library: Library) =>
  library.material(
    "ladybird/materials.ts:pronotumMaterial",
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
export const headMaterial = (library: Library) =>
  library.material(
    "ladybird/materials.ts:headMaterial",
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
