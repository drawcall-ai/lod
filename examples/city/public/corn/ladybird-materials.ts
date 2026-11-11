import * as THREE from "three/webgpu";
import type { Materials } from "../shared/materials.ts";

/** Black chitin: glossy but not mirror-like. */
export const blackMaterial = (materials: Materials) =>
  materials.material(
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

/** [x across from the suture, z forward, radius] in footprint units, as `spot` takes them. */
type Spot = [number, number, number];

/**
 * The elytra's spots: one shared across the suture at the front, then shoulder, middle (largest) and rear on each
 * side.
 */
const SPOTS: Spot[] = [
  [0, 0.8, 0.17],
  ...[-1, 1].flatMap((s): Spot[] => [
    [s * 0.58, 0.45, 0.14],
    [s * 0.46, -0.02, 0.21],
    [s * 0.36, -0.52, 0.15],
  ]),
];

/** Elytra: lacquer red with the spot pattern and a finely dimpled clear coat. */
export const shellMaterial = (materials: Materials) =>
  materials.material(
    "ladybird/materials.ts:shellMaterial",
    () =>
      new THREE.MeshPhysicalMaterial({
        name: "ladybird-elytra",
        map: paint(1024, (x, z, texel) => {
          // a radial gradient from the shell's crown, just forward of its centre, to its rim
          const t = THREE.MathUtils.clamp((Math.hypot(x, z - 0.1) / 2 - 0.05) / 0.5, 0, 1);
          let color = t < 0.85 ? mix(hex("#d8341a"), hex("#c0240f"), t / 0.85) : mix(hex("#c0240f"), hex("#8e1a0c"), (t - 0.85) / 0.15);
          // a soft edge, about three texels wide: pigment, not a printed decal
          for (const [sx, sz, r] of SPOTS) color = mix(color, hex("#14100e"), spot(x, z, sx, sz, r, 3 * texel));
          // the suture between the elytra, from the rear to just behind the front spot
          const suture = z < 0.84 ? THREE.MathUtils.clamp((0.005 - Math.abs(x)) / texel + 0.5, 0, 1) : 0;
          return mix(color, [40, 6, 2], 0.85 * suture);
        }),
        // the punctation lies under the lacquer-like coat: it only breaks up the highlight, and
        // spots and red share the one coat, so they reflect identically
        clearcoatNormalMap: dimples(2048, 9000, 2.2, 0.0012),
        clearcoatNormalScale: new THREE.Vector2(0.35, 0.35),
        roughness: 0.55,
        clearcoat: 1,
        clearcoatRoughness: 0.15,
      }),
  );

/** Pronotum: black with the cream patches in its front corners. */
export const pronotumMaterial = (materials: Materials) =>
  materials.material(
    "ladybird/materials.ts:pronotumMaterial",
    () =>
      new THREE.MeshPhysicalMaterial({
        name: "ladybird-pronotum",
        map: paint(512, (x, z, texel) => mix(hex("#0d0d0c"), hex("#ede5cf"), Math.max(spot(x, z, -0.7, 0.5, 0.2, texel), spot(x, z, 0.7, 0.5, 0.2, texel)))),
        roughness: 0.35,
        clearcoat: 1,
        clearcoatRoughness: 0.15,
      }),
  );

/** Head: black with two small pale spots between the eyes. */
export const headMaterial = (materials: Materials) =>
  materials.material(
    "ladybird/materials.ts:headMaterial",
    () =>
      new THREE.MeshPhysicalMaterial({
        name: "ladybird-head",
        map: paint(256, (x, z, texel) =>
          mix(hex("#0d0d0c"), hex("#e3dcc6"), Math.max(spot(x, z, -0.42, 0.25, 0.15, texel), spot(x, z, 0.42, 0.25, 0.15, texel))),
        ),
        roughness: 0.3,
        clearcoat: 0.8,
        clearcoatRoughness: 0.15,
      }),
  );

/** An sRGB colour, 0–255 a channel. */
type Rgb = [number, number, number];

function hex(color: string): Rgb {
  const channel = (at: number) => parseInt(color.slice(at, at + 2), 16);
  return [channel(1), channel(3), channel(5)];
}
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * A square sRGB texture whose u/v match the dome's footprint coordinates: `color` answers each texel's colour at its
 * footprint coordinates (x across, z forward, each in [-1, 1]), given the width of a texel in those units.
 */
function paint(size: number, color: (x: number, z: number, texel: number) => Rgb): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const [r, g, b] = color(((column + 0.5) / size) * 2 - 1, ((row + 0.5) / size) * 2 - 1, 2 / size);
      data.set([Math.round(r), Math.round(g), Math.round(b), 255], (row * size + column) * 4);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/**
 * How much of a slightly irregular round spot centred at footprint coordinates (sx, sz), of radius about `r` in the
 * same units, covers (x, z): 1 inside, fading to 0 across `edge` at its outline.
 */
function spot(x: number, z: number, sx: number, sz: number, r: number, edge: number): number {
  const dx = x - sx;
  const dz = z - sz;
  if (Math.abs(dx) > 1.1 * r + edge || Math.abs(dz) > 1.1 * r + edge) return 0;
  // angles as a canvas with v running down measured them, so the outline keeps its shape
  const a = Math.atan2(-dz, dx);
  const radius = r * (1 + 0.05 * Math.sin(a * 3 + sx * 7) + 0.03 * Math.sin(a * 5 + sz * 11));
  return THREE.MathUtils.clamp((radius - Math.hypot(dx, dz)) / edge + 0.5, 0, 1);
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
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
