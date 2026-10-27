import { Color, DoubleSide, ObjectSpaceNormalMap, Vector2, Vector3, type Material, type Texture } from "three/webgpu";
import { isColor, isStandard, isTexture } from "../three.js";
import { tangentFrame } from "./frame.js";
import type { Source } from "./source.js";
import { Texels, readable } from "./texels.js";

/**
 * What the bake reads of a material, read as a MeshStandardMaterial: color, map, opacity,
 * alphaMap, alphaTest, vertexColors, roughness (+ map G), metalness (+ map B), normalMap
 * (tangent space, + normalScale) and aoMap R. Other materials bake as rough dielectrics
 * with their color and map. Emissive, clearcoat, transmission, sheen etc. are not baked.
 */
export interface MaterialInputs {
  color: Color;
  map: Texels | null;
  alphaMap: Texels | null;
  opacity: number;
  /**
   * Whether alpha cuts holes: an alphaTest, or alpha to coverage without blending.
   * Blended transparency (glass) bakes opaque, at its own colour.
   */
  cutout: boolean;
  alphaTest: number;
  vertexColors: boolean;
  roughness: number;
  roughnessMap: Texels | null;
  metalness: number;
  metalnessMap: Texels | null;
  normalMap: Texels | null;
  normalScale: Vector2;
  aoMap: Texels | null;
  aoMapIntensity: number;
  doubleSided: boolean;
  /**
   * Share of what is behind the surface that shows through it: blended opacity and
   * transmission, 0 for an opaque surface. A surface with any is glass. Texture alpha is
   * not read: it cuts out (leaves), where opacity and transmission make panes.
   */
  transmittance: number;
}

/** `material` as the CPU reads it, to `bake` or to `measure` (see `readSource`). */
export function readMaterial(material: Material, cache: Map<Texture, Texels>, purpose: "bake" | "measure"): MaterialInputs {
  const read = (texture: unknown) => {
    if (!isTexture(texture)) return null;
    let texels = cache.get(texture);
    if (!texels) cache.set(texture, (texels = new Texels(texture)));
    return texels;
  };
  const standard = isStandard(material) ? material : null;
  const alphas = ["map" in material ? material.map : null, "alphaMap" in material ? material.alphaMap : null].filter(isTexture);
  const opaque = purpose === "measure" && !alphas.every(readable);
  const cutout = !opaque && (material.alphaTest > 0 || (material.alphaToCoverage && !material.transparent));
  return {
    color: "color" in material && isColor(material.color) ? material.color.clone() : new Color(1, 1, 1),
    map: "map" in material ? read(material.map) : null,
    alphaMap: "alphaMap" in material ? read(material.alphaMap) : null,
    opacity: material.opacity,
    cutout,
    alphaTest: material.alphaTest > 0 ? material.alphaTest : 0.5,
    vertexColors: material.vertexColors,
    roughness: standard?.roughness ?? 1,
    roughnessMap: read(standard?.roughnessMap),
    metalness: standard?.metalness ?? 0,
    metalnessMap: read(standard?.metalnessMap),
    normalMap: standard && standard.normalMapType !== ObjectSpaceNormalMap ? read(standard.normalMap) : null,
    normalScale: standard?.normalScale.clone() ?? new Vector2(1, 1),
    aoMap: read(standard?.aoMap),
    aoMapIntensity: standard?.aoMapIntensity ?? 1,
    doubleSided: material.side === DoubleSide,
    transmittance:
      1 -
      (material.transparent ? material.opacity : 1) *
        (1 - ("transmission" in material && typeof material.transmission === "number" ? material.transmission : 0)),
  };
}

/**
 * What a ray met: the back of a single-sided surface (which three does not draw), a
 * surface cut out at that point, or an opaque one.
 */
export type Hit = "back" | "cutout" | "opaque";

/** The source's material values at surface points: `test` where a ray meets one, `shade` the one it keeps. */
export class Shading {
  /** linear base colour */
  r = 0;
  g = 0;
  b = 0;
  ao = 1;
  roughness = 1;
  metalness = 0;
  /** shading normal in the source's space */
  readonly normal = new Vector3();
  /** per source triangle: unit face normal */
  private readonly faces: Float32Array;
  /** per source triangle: UV area per unit of surface area */
  private readonly density: Float32Array;
  private readonly e1 = new Vector3();
  private readonly e2 = new Vector3();
  private readonly tangent = new Vector3();
  private readonly bitangent = new Vector3();
  private readonly texel = new Float32Array(4);
  private triangle = 0;
  private w0 = 0;
  private w1 = 0;
  private w2 = 0;

  constructor(
    private readonly source: Source,
    /** size of one baked texel in the source's units: mip levels are picked to match it */
    private readonly texelSize: number,
  ) {
    const { uvs, index } = source;
    const count = index.length / 3;
    this.faces = new Float32Array(count * 3);
    this.density = new Float32Array(count);
    for (let t = 0; t < count; t++) {
      this.corners(t);
      const face = this.tangent.crossVectors(this.e1, this.e2);
      const area = face.length();
      face.normalize().toArray(this.faces, t * 3);
      const a = this.corner(t, 0);
      const b = this.corner(t, 1);
      const c = this.corner(t, 2);
      const det =
        ((uvs[b * 2] ?? 0) - (uvs[a * 2] ?? 0)) * ((uvs[c * 2 + 1] ?? 0) - (uvs[a * 2 + 1] ?? 0)) -
        ((uvs[c * 2] ?? 0) - (uvs[a * 2] ?? 0)) * ((uvs[b * 2 + 1] ?? 0) - (uvs[a * 2 + 1] ?? 0));
      this.density[t] = area > 0 ? Math.abs(det) / area : 0;
    }
  }

  /**
   * What a ray along -`facing` meets at weights (`w1`, `w2`) of triangle `triangle`;
   * with `facing` null, either side of a surface counts as its front.
   */
  test(triangle: number, w1: number, w2: number, facing: Vector3 | null): Hit {
    const material = this.material(triangle);
    if (facing && !material.doubleSided && this.facesAway(triangle, facing)) return "back";
    if (!material.cutout) return "opaque";
    this.at(triangle, w1, w2);
    return this.alpha(material) < material.alphaTest ? "cutout" : "opaque";
  }

  /** Whether triangle `triangle` faces away from a viewer looking along -`facing`. */
  facesAway(triangle: number, facing: Vector3): boolean {
    const { faces } = this;
    return (faces[triangle * 3] ?? 0) * facing.x + (faces[triangle * 3 + 1] ?? 0) * facing.y + (faces[triangle * 3 + 2] ?? 0) * facing.z < 0;
  }

  /** Evaluate the material at weights (`w1`, `w2`) of triangle `triangle`, seen from its back if `back`. */
  shade(triangle: number, w1: number, w2: number, back: boolean): void {
    const material = this.material(triangle);
    this.at(triangle, w1, w2);
    const { colors, normals } = this.source;
    this.r = material.color.r;
    this.g = material.color.g;
    this.b = material.color.b;
    const texel = this.texel;
    if (material.map) {
      this.sample(material.map);
      this.r *= texel[0] ?? 0;
      this.g *= texel[1] ?? 0;
      this.b *= texel[2] ?? 0;
    }
    if (material.vertexColors) {
      this.r *= this.lerp(colors, 3, 0);
      this.g *= this.lerp(colors, 3, 1);
      this.b *= this.lerp(colors, 3, 2);
    }
    this.roughness = material.roughness * (material.roughnessMap ? (this.sample(material.roughnessMap)[1] ?? 1) : 1);
    this.metalness = material.metalness * (material.metalnessMap ? (this.sample(material.metalnessMap)[2] ?? 1) : 1);
    this.ao = material.aoMap ? 1 + ((this.sample(material.aoMap)[0] ?? 1) - 1) * material.aoMapIntensity : 1;

    // On a back face three negates the whole frame; computing it from the flipped normal does.
    const n = this.normal.set(this.lerp(normals, 3, 0), this.lerp(normals, 3, 1), this.lerp(normals, 3, 2)).normalize();
    if (back) n.negate();
    if (!material.normalMap) return;
    const a = this.corner(triangle, 0);
    const b = this.corner(triangle, 1);
    const c = this.corner(triangle, 2);
    const { uvs } = this.source;
    // three takes the UV gradients after the map's transform.
    const m = material.normalMap.matrix;
    const st = (corner: number, axis: number) => (m[axis] ?? 0) * (uvs[corner * 2] ?? 0) + (m[3 + axis] ?? 0) * (uvs[corner * 2 + 1] ?? 0);
    this.corners(triangle);
    const t = this.tangent;
    const bt = this.bitangent;
    tangentFrame(this.e1, this.e2, st(b, 0) - st(a, 0), st(b, 1) - st(a, 1), st(c, 0) - st(a, 0), st(c, 1) - st(a, 1), n, t, bt);
    this.sample(material.normalMap);
    const x = ((texel[0] ?? 0.5) * 2 - 1) * material.normalScale.x;
    const y = ((texel[1] ?? 0.5) * 2 - 1) * material.normalScale.y;
    const z = (texel[2] ?? 1) * 2 - 1;
    n.multiplyScalar(z).addScaledVector(t, x).addScaledVector(bt, y).normalize();
  }

  /** Barycentric weights (into `out`, x = w1, y = w2) of `point` on triangle `triangle`. */
  weights(triangle: number, point: Vector3, out: Vector3): Vector3 {
    this.corners(triangle);
    const a = this.corner(triangle, 0);
    const { e1, e2 } = this;
    const { positions } = this.source;
    const vx = point.x - (positions[a * 3] ?? 0);
    const vy = point.y - (positions[a * 3 + 1] ?? 0);
    const vz = point.z - (positions[a * 3 + 2] ?? 0);
    const d00 = e1.dot(e1);
    const d01 = e1.dot(e2);
    const d11 = e2.dot(e2);
    const d20 = vx * e1.x + vy * e1.y + vz * e1.z;
    const d21 = vx * e2.x + vy * e2.y + vz * e2.z;
    const denominator = d00 * d11 - d01 * d01;
    if (denominator === 0) return out.set(0, 0, 0);
    return out.set((d11 * d20 - d01 * d21) / denominator, (d00 * d21 - d01 * d20) / denominator, 0);
  }

  material(triangle: number): MaterialInputs {
    const slot = this.source.slots[triangle];
    const material = slot === undefined ? undefined : this.source.inputs[slot];
    if (!material) throw new Error(`@drawcall/lod: triangle ${triangle} has no material`);
    return material;
  }

  /** Vertex `k` of triangle `triangle`. */
  private corner(triangle: number, k: number): number {
    return this.source.index[triangle * 3 + k] ?? 0;
  }

  /** Edges e1, e2 of triangle `triangle` from its first corner. */
  private corners(triangle: number): void {
    const { positions } = this.source;
    const a = this.corner(triangle, 0);
    const b = this.corner(triangle, 1);
    const c = this.corner(triangle, 2);
    for (let k = 0; k < 3; k++) {
      const origin = positions[a * 3 + k] ?? 0;
      this.e1.setComponent(k, (positions[b * 3 + k] ?? 0) - origin);
      this.e2.setComponent(k, (positions[c * 3 + k] ?? 0) - origin);
    }
  }

  private at(triangle: number, w1: number, w2: number): void {
    this.triangle = triangle;
    this.w0 = 1 - w1 - w2;
    this.w1 = w1;
    this.w2 = w2;
  }

  private lerp(array: Float32Array, size: number, c: number): number {
    const { index } = this.source;
    const t = this.triangle * 3;
    return (
      (array[(index[t] ?? 0) * size + c] ?? 0) * this.w0 +
      (array[(index[t + 1] ?? 0) * size + c] ?? 0) * this.w1 +
      (array[(index[t + 2] ?? 0) * size + c] ?? 0) * this.w2
    );
  }

  private alpha(material: MaterialInputs): number {
    let alpha = material.opacity;
    if (material.map) alpha *= this.sample(material.map)[3] ?? 1;
    if (material.alphaMap) alpha *= this.sample(material.alphaMap)[1] ?? 1;
    return alpha;
  }

  /** `texels` at the current point, at the mip level where one of its texels covers one baked texel. */
  private sample(texels: Texels): Float32Array {
    const { uvs } = this.source;
    const footprint = (this.density[this.triangle] ?? 0) * texels.uvScale * texels.width * texels.height * this.texelSize * this.texelSize;
    texels.sample(this.lerp(uvs, 2, 0), this.lerp(uvs, 2, 1), 0.5 * Math.log2(Math.max(footprint, 1e-12)), this.texel);
    return this.texel;
  }
}
