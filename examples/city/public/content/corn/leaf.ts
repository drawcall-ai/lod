import * as THREE from "three/webgpu";
import { Foliage, type FoliageOptions, foliage } from "../foliage.ts";
import { MeshBuilder } from "../geometry.ts";
import type { Library } from "../materials.ts";
import { Random } from "../random.ts";

/** Base, body and tip colours (sRGB) of a blade, plus its midrib. */
interface Palette {
  base: string;
  body: string;
  tip: string;
  rib: string;
}

const green: Palette = { base: "#86a23c", body: "#538223", tip: "#a09a46", rib: "#c6da92" };
const husk: Palette = { base: "#b8c886", body: "#9bb466", tip: "#c4c088", rib: "#d8e4b0" };
const dry: Palette = { base: "#a0905a", body: "#b39a62", tip: "#8a6e44", rib: "#d2c296" };

/** The foliage shading of living blades, which make up most of a plant. */
export const LEAF_FOLIAGE: FoliageOptions = { translucency: 0.75 };

/** Living maize blades; per-leaf variation comes through vertex colours. */
export const leafMaterial = (library: Library, pixels?: BladePixels) => bladeMaterial(library, "corn-leaf", green, LEAF_FOLIAGE, pixels);
/** Dead lower leaves: straw coloured, hardly translucent. */
export const dryLeafMaterial = (library: Library, pixels?: BladePixels) => bladeMaterial(library, "corn-leaf-dry", dry, { translucency: 0.25 }, pixels);
/** Ear husks: paler and more yellow than the blades, with the same parallel fibres. */
export const huskMaterial = (library: Library, pixels?: BladePixels) => bladeMaterial(library, "corn-husk", husk, { translucency: 0.6 }, pixels);

export interface BladePixels {
  color: Uint8Array;
  normal: Uint8Array;
}

function bladeMaterial(library: Library, name: string, palette: Palette, shading: FoliageOptions, pixels?: BladePixels): Foliage {
  const material = library.material(name, () => {
    const { color, normal } = pixels
      ? { color: dataTexture(pixels.color, THREE.SRGBColorSpace), normal: dataTexture(pixels.normal, THREE.NoColorSpace) }
      : bladeTextures(palette);
    const m = new Foliage({
      name,
      map: color,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.5, 0.5),
      vertexColors: true,
      roughness: 0.48,
      // the fine hairs on a maize blade give it a soft, silvery sheen at grazing angles
      sheen: 0.25,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color("#b9d98a"),
      side: THREE.DoubleSide,
    });
    return foliage(m, shading);
  });
  if (!(material instanceof Foliage)) throw new Error(`Invalid corn leaf material ${name}`);
  return material;
}

export const LEAF_SIZE = 2048;
const size = LEAF_SIZE;

/**
 * Colour and normal maps of a blade (u across, v from collar to tip), computed per texel so
 * they filter cleanly: a pale sunken midrib, ~16 stronger lateral veins per half with 6 fine
 * ones between each pair, slight puckering near the margins, cell-scale mottling.
 */
function bladeTextures(palette: Palette): { color: THREE.DataTexture; normal: THREE.DataTexture } {
  const r = new Random(11);
  const height = new Float32Array(size);
  const tone = new Float32Array(size);
  const veins: { at: number; strength: number }[] = [];
  const majors = 16;
  for (let k = 0; k < majors; k++) {
    const from = 0.06 + (k / majors) * 0.92;
    const to = 0.06 + ((k + 1) / majors) * 0.92;
    veins.push({ at: from + r.range(-0.004, 0.004), strength: 1 });
    for (let j = 1; j < 7; j++) veins.push({ at: from + ((to - from) * j) / 7 + r.range(-0.002, 0.002), strength: 0.3 });
  }
  for (let x = 0; x < size; x++) {
    // q: distance from the midrib in half-widths
    const q = Math.abs((x + 0.5) / size - 0.5) * 2;
    let h = -0.5 * smooth(0.05, 0.02, q) + 0.3 * Math.exp(-(((q - 0.05) / 0.008) ** 2));
    let t = 0.55 * smooth(0.05, 0.03, q);
    for (const v of veins) {
      const g = Math.exp(-(((q - v.at) / (v.strength === 1 ? 0.0035 : 0.0018)) ** 2));
      h += g * 0.3 * v.strength;
      t += g * 0.06 * v.strength;
    }
    height[x] = h;
    tone[x] = t + 0.06 * smooth(0.975, 1, q);
  }

  const base = new THREE.Color(palette.base);
  const body = new THREE.Color(palette.body);
  const tip = new THREE.Color(palette.tip);
  const rib = new THREE.Color(palette.rib);
  const color = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const c = new THREE.Color();
  const n = new THREE.Vector3();
  const relief = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const q = Math.abs((x + 0.5) / size - 0.5) * 2;
      const pucker = 0.25 * q ** 4 * Math.sin(y * 0.045 + q * 9);
      relief[y * size + x] = (height[x] ?? 0) + pucker + 0.05 * valueNoise(x * 0.5, y * 0.12);
    }
  }
  // wraps across u and clamps along v
  const at = (x: number, y: number) => relief[Math.min(size - 1, Math.max(0, y)) * size + ((x + size) % size)] ?? 0;
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    const along = v < 0.08 ? base.clone().lerp(body, v / 0.08) : v < 0.88 ? body : body.clone().lerp(tip, (v - 0.88) / 0.12);
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const q = Math.abs((x + 0.5) / size - 0.5) * 2;
      const mottle = valueNoise(x / 24, y / 160) - 0.5;
      c.copy(along)
        .lerp(rib, Math.min(1, tone[x] ?? 0))
        .multiplyScalar(1 + 0.16 * mottle + 0.05 * (valueNoise(x * 0.7, y * 0.2) - 0.5) - 0.12 * smooth(0.9, 1, q));
      color[i] = Math.round(THREE.MathUtils.clamp(c.r, 0, 1) * 255);
      color[i + 1] = Math.round(THREE.MathUtils.clamp(c.g, 0, 1) * 255);
      color[i + 2] = Math.round(THREE.MathUtils.clamp(c.b, 0, 1) * 255);
      color[i + 3] = 255;
      n.set(-(at(x + 1, y) - at(x - 1, y)) * 1.6, -(at(x, y + 1) - at(x, y - 1)) * 1.6, 1).normalize();
      normal[i] = Math.round((n.x * 0.5 + 0.5) * 255);
      normal[i + 1] = Math.round((n.y * 0.5 + 0.5) * 255);
      normal[i + 2] = Math.round((n.z * 0.5 + 0.5) * 255);
      normal[i + 3] = 255;
    }
  }
  return { color: dataTexture(color, THREE.SRGBColorSpace), normal: dataTexture(normal, THREE.NoColorSpace) };
}

function dataTexture(data: Uint8Array, colorSpace: THREE.ColorSpace): THREE.DataTexture {
  if (data.length !== size * size * 4) throw new Error("Invalid corn leaf pixels");
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = colorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Hermite step from edge0 to edge1 (either order). */
function smooth(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Smooth 2D value noise in [0, 1]. */
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface LeafShape {
  length: number;
  width: number;
  /** Angle of the blade's base from vertical (radians). */
  rise: number;
  /** How far the outer part of the blade bends over (radians). */
  droop: number;
  twist: number;
  /** Depth of the V along the midrib relative to the half-width, at the base. */
  fold?: number;
  color: THREE.Color;
  seed: number;
  /** Height of the margin waves (m); default 3 mm. */
  ripple?: number;
  /** Grid resolution along and across the blade; raise it for millimetre close-ups. */
  segments?: [number, number];
}

/**
 * A strap-shaped blade from the collar outward along `azimuth`: rising, then arching over
 * and drooping in its outer half, V-folded along the midrib (flattening toward the tip),
 * twisting, with crinkled margins.
 */
export function leaf(base: THREE.Vector3, azimuth: number, s: LeafShape): THREE.BufferGeometry {
  const r = new Random(s.seed);
  const b = new MeshBuilder();
  const up = new THREE.Vector3(0, 1, 0);
  const out = new THREE.Vector3(Math.cos(azimuth), 0, Math.sin(azimuth));
  const side = new THREE.Vector3().crossVectors(up, out).normalize();
  const [segments, across] = s.segments ?? [48, 8];
  const p = base.clone();
  const rows: number[][] = [];
  const ripple = r.range(50, 90);
  const phase = r.range(0, 6);
  const step = s.length / segments;
  const v = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const angle = s.rise + s.droop * smooth(0.15, 1.05, t) ** 1.2;
    const tangent = up.clone().multiplyScalar(Math.cos(angle)).addScaledVector(out, Math.sin(angle));
    // narrow at the collar, widest a third of the way out, then a long taper to the point
    const width = s.width * (0.35 + 0.65 * smooth(0, 0.3, t)) * (1 - smooth(0.45, 1, t) ** 1.6);
    const lateral = side.clone().applyAxisAngle(tangent, s.twist * t * t);
    // the blade's upper side: the V of the midrib fold opens this way
    const normal = new THREE.Vector3().crossVectors(tangent, lateral).normalize();
    const fold = (s.fold ?? 0.45) * (1 - t) ** 1.5;
    const row: number[] = [];
    for (let k = 0; k <= across; k++) {
      const a = (k / across) * 2 - 1;
      const edge = Math.abs(a) ** 4;
      const wave = (s.ripple ?? 0.003) * Math.sin(t * ripple + phase + a) * edge * smooth(0.05, 0.3, t);
      v.copy(p)
        .addScaledVector(lateral, (a * width) / 2)
        .addScaledVector(normal, Math.abs(a) * fold * width * 0.5 + wave);
      row.push(b.vertex(v, k / across, t, s.color));
    }
    rows.push(row);
    p.addScaledVector(tangent, step);
  }
  for (let i = 0; i < segments; i++) {
    const a = rows[i];
    const c = rows[i + 1];
    if (!a || !c) break;
    // wound so the front face is the blade's upper side: shadow normal bias (applied in the
    // vertex shader, before double-sided flipping) then pushes away from the surface
    for (let k = 0; k < across; k++) b.quad(a[k] ?? 0, c[k] ?? 0, c[k + 1] ?? 0, a[k + 1] ?? 0);
  }
  return b.geometry();
}
