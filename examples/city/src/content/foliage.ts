import * as THREE from "three/webgpu";
import { Fn, color, dFdx, dFdy, dot, log2, materialOpacity, max, normalView, positionViewDirection, pow, saturate, uv, vec2, vec3, vec4 } from "three/tsl";
import { ImpostorMesh } from "@drawcall/lod";
import { baseColor } from "./materials.ts";

export interface FoliageOptions {
  /** Share of sunlight a leaf passes on to its shaded side (0–1). */
  translucency: number;
  /** Colour of the transmitted light relative to the leaf's own: thin leaves glow yellow-green. */
  tint?: THREE.ColorRepresentation;
}

/**
 * A leaf material, lit with translucency: sunlight hitting the far side of a thin leaf
 * shows on the near side, so back-lit leaves glow instead of turning black. It rides on
 * the direct-light term, so it is shadowed exactly like front light. Set up by `foliage`.
 * Its own class so that the copies the package draws levels with (clones) keep it.
 */
export class Foliage extends THREE.MeshPhysicalNodeMaterial {
  translucency = 0;
  readonly tint = new THREE.Color(1, 1, 1);

  override copy(source: THREE.Material): this {
    super.copy(source);
    if (source instanceof Foliage) {
      this.translucency = source.translucency;
      this.tint.copy(source.tint);
    }
    return this;
  }

  override setupLightingModel(): THREE.PhysicalLightingModel {
    return new Translucent(super.setupLightingModel(), this.translucency, this.tint);
  }

  // The lighting model is no node: materials alike in their nodes would share a shader.
  override customProgramCacheKey(): string {
    return `${super.customProgramCacheKey()}|${foliageKey(this.translucency, this.tint)}`;
  }
}

const foliageKey = (translucency: number, tint: THREE.Color) => `foliage-${translucency}-${tint.getHexString()}`;

/**
 * Makes `m` foliage with `options`. Cut-out leaves also get alpha to coverage and a
 * mip-dependent alpha boost, in the view and in shadow maps alike: plain alpha testing
 * loses coverage in smaller mips, which makes distant needles and leaves vanish.
 */
export function foliage(m: Foliage, { translucency, tint = "#e4ff8a" }: FoliageOptions): Foliage {
  m.translucency = translucency;
  m.tint.set(tint);
  if (!(m.alphaTest > 0 && m.map)) return m;
  m.alphaToCoverage = true;
  const boost = boostOf(m.map);
  m.opacityNode = materialOpacity.mul(boost);
  // A shadow pass multiplies the map's alpha by the colour's: there the colour is the boost alone.
  m.colorNode = Fn((builder) => (isShadowPass(builder.material) ? vec4(vec3(1), boost) : baseColor))();
  return m;
}

/** A plant model's leaf material `m` (standard, as loaded) as foliage. */
export const leafOf = (m: THREE.MeshStandardMaterial, options: FoliageOptions): Foliage => foliage(new Foliage().copy(m), options);

/** Turns every alpha-tested material of a loaded plant model into foliage. */
export function foliageModel(root: THREE.Object3D, options: FoliageOptions): void {
  const made = new Map<THREE.Material, Foliage>();
  const swap = (m: THREE.Material): THREE.Material => {
    if (!(m instanceof THREE.MeshStandardMaterial) || m.alphaTest === 0) return m;
    let leaf = made.get(m);
    if (!leaf) made.set(m, (leaf = leafOf(m, options)));
    return leaf;
  };
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
  });
}

const shaded = new WeakSet<THREE.Material>();

/** Restores leaf translucency on a decoded impostor before its material is compiled. */
export function foliageLevels(root: THREE.Object3D, { translucency, tint = "#e4ff8a" }: FoliageOptions): void {
  const shade = new THREE.Color(tint);
  root.traverse((o) => {
    if (!(o instanceof ImpostorMesh)) return;
    const m = o.material;
    if (shaded.has(m)) return;
    shaded.add(m);
    const lighting = m.setupLightingModel.bind(m);
    const key = m.customProgramCacheKey.bind(m);
    m.setupLightingModel = () => new Translucent(lighting(), translucency, shade);
    m.customProgramCacheKey = () => `${key()}|${foliageKey(translucency, shade)}`;
  });
}

/** Boosts alpha by the mip `map` is read at. */
function boostOf(map: THREE.Texture) {
  const image: unknown = map.image;
  if (
    typeof image !== "object" ||
    image === null ||
    !("width" in image) ||
    !("height" in image) ||
    typeof image.width !== "number" ||
    typeof image.height !== "number"
  )
    throw new Error(`foliage: the leaves' map "${map.name}" has no image to measure`);
  const texel = uv().mul(vec2(image.width, image.height));
  const mip = max(log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel)))).mul(0.5), 0);
  return mip.mul(0.25).add(1);
}

/** `lighting` with the translucency added to its direct light. */
class Translucent extends THREE.PhysicalLightingModel {
  constructor(
    private readonly lighting: THREE.PhysicalLightingModel,
    private readonly share: number,
    private readonly tint: THREE.Color,
  ) {
    super();
  }

  override direct(input: Parameters<THREE.PhysicalLightingModel["direct"]>[0], builder: THREE.NodeBuilder): void {
    this.lighting.direct(input, builder);
    const { lightDirection, lightColor, reflectedLight } = input;
    const { directDiffuse } = reflectedLight;
    if (!isNodeOf(lightDirection, "vec3", builder) || !isNodeOf(lightColor, "color", builder) || !isNodeOf(directDiffuse, "vec3", builder))
      throw new Error("foliage: three's direct light is not a direction, a colour and a sum");
    const behind = saturate(dot(normalView, lightDirection).negate());
    // light scatters forward through the leaf: strongest when looking toward the sun
    const forward = pow(saturate(dot(positionViewDirection, lightDirection.negate())), 3)
      .mul(0.65)
      .add(0.35);
    directDiffuse.addAssign(behind.mul(forward).mul(this.share).mul(lightColor).mul(THREE.TSL.diffuseContribution).mul(color(this.tint)));
  }

  // Everything else is the wrapped model's.
  override start(builder: THREE.NodeBuilder): void {
    this.lighting.start(builder);
  }
  override finish(builder: THREE.NodeBuilder): void {
    this.lighting.finish(builder);
  }
  override directRectArea(input: Parameters<THREE.PhysicalLightingModel["directRectArea"]>[0], builder: THREE.NodeBuilder): void {
    this.lighting.directRectArea(input, builder);
  }
  override indirect(builder: THREE.NodeBuilder): void {
    this.lighting.indirect(builder);
  }
  override indirectDiffuse(builder: THREE.NodeBuilder): void {
    this.lighting.indirectDiffuse(builder);
  }
  override indirectSpecular(builder: THREE.NodeBuilder): void {
    this.lighting.indirectSpecular(builder);
  }
  override ambientOcclusion(builder: THREE.NodeBuilder): void {
    this.lighting.ambientOcclusion(builder);
  }
}

function isShadowPass(material: unknown): boolean {
  return typeof material === "object" && material !== null && Reflect.get(material, "isShadowPassMaterial") === true;
}

function isNodeOf<T extends "vec3" | "color">(node: THREE.Node, type: T, builder: THREE.NodeBuilder): node is THREE.Node<T> {
  return node.getNodeType(builder) === type;
}
