import {
  Color,
  ConvertNode,
  MeshStandardNodeMaterial,
  PhysicalLightingModel,
  TSL,
  type ColorRepresentation,
  type Material,
  type Node,
  type NodeBuilder,
  type Object3D,
  type Texture,
} from "three/webgpu";
import {
  Fn,
  color,
  dFdx,
  dFdy,
  dot,
  log2,
  materialColor,
  materialOpacity,
  max,
  normalView,
  positionViewDirection,
  pow,
  saturate,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { cosine } from "./impostor/mesh/surface.js";
import { isImpostorMesh, isMesh, isShadowPass, isStandard } from "./three.js";
import { isNodeOf } from "./tsl.js";

export interface FoliageOptions {
  /** Share of sunlight a leaf passes on to its shaded side (0–1). */
  translucency: number;
  /** Colour of the transmitted light relative to the leaf's own: thin leaves glow yellow-green. Default #e4ff8a. */
  tint?: ColorRepresentation;
}

const TINT = "#e4ff8a";

/**
 * A leaf material, lit with translucency: sunlight hitting the far side of a thin leaf shows on the near side, so
 * back-lit leaves glow instead of turning black. It rides on the direct-light term, so it is shadowed exactly like front
 * light. Set up by `foliage`. Its own class so that the copies levels draw with (clones) keep it.
 */
export class Foliage extends MeshStandardNodeMaterial {
  translucency = 0;
  readonly tint = new Color(1, 1, 1);

  override copy(source: Material): this {
    super.copy(source);
    // NodeMaterial.copy skips Material accessors, including the cutout threshold.
    this.alphaTest = source.alphaTest;
    if (source instanceof Foliage) {
      this.translucency = source.translucency;
      this.tint.copy(source.tint);
    }
    return this;
  }

  override setupLightingModel(): PhysicalLightingModel {
    return new Translucent(transmitted(leafBehind, this.translucency, this.tint));
  }

  // The lighting model is no node: materials alike in their nodes would share a shader.
  override customProgramCacheKey(): string {
    return `${super.customProgramCacheKey()}|foliage-${this.translucency}-${this.tint.getHexString()}`;
  }
}

/**
 * Makes `material` foliage with `options`. Cut-out leaves also get alpha to coverage and a mip-dependent alpha boost, in
 * the view and in shadow maps alike: plain alpha testing loses coverage in smaller mips, which makes distant needles and
 * leaves vanish.
 */
export function foliage(material: Foliage, { translucency, tint = TINT }: FoliageOptions): Foliage {
  material.translucency = translucency;
  material.tint.set(tint);
  if (!(material.alphaTest > 0 && material.map)) return material;
  material.alphaToCoverage = true;
  const boost = boostOf(material.map);
  material.opacityNode = materialOpacity.mul(boost);
  // A shadow pass multiplies the map's alpha by the colour's: there the colour is the boost alone.
  material.colorNode = Fn((builder: NodeBuilder) => (isShadowPass(builder.material) ? vec4(vec3(1), boost) : baseColor))();
  return material;
}

/** Turns every alpha-tested standard material under `root`, such as a loaded plant model's leaves, into foliage. */
export function foliageModel(root: Object3D, options: FoliageOptions): void {
  const made = new Map<Material, Foliage>();
  const swap = (material: Material): Material => {
    if (!isStandard(material) || material.alphaTest === 0) return material;
    let leaf = made.get(material);
    if (!leaf) made.set(material, (leaf = foliage(new Foliage().copy(material), options)));
    return leaf;
  };
  root.traverse((node) => {
    if (isMesh(node)) node.material = Array.isArray(node.material) ? node.material.map(swap) : swap(node.material);
  });
}

/**
 * Adds leaf translucency to the lighting of the impostors under `root`, such as an `onLevel` level: the bake holds no
 * light passing through a leaf.
 */
export function foliageLevels(root: Object3D, { translucency, tint = TINT }: FoliageOptions): void {
  const shade = new Color(tint);
  root.traverse((node) => {
    if (!isImpostorMesh(node)) return;
    const { material } = node;
    // The mean over the leaves a texel averages: its one unit normal would light them all one way.
    material.directTerm = transmitted((direction) => cosine(material.spread, direction.negate()), translucency, shade);
  });
}

/**
 * A material's colour times its map, its alpha included: three's `materialColor`, which builds to a vec4 where the
 * material has a map, and to a vec3 (typed so) where not.
 */
const baseColor = Fn(() => {
  const base = vec4(1).toVar();
  base.assign(materialColor);
  return base;
})();

/** Boosts alpha by the mip `map` is read at. */
function boostOf(map: Texture) {
  const image: unknown = map.image;
  if (
    typeof image !== "object" ||
    image === null ||
    !("width" in image) ||
    !("height" in image) ||
    typeof image.width !== "number" ||
    typeof image.height !== "number"
  )
    throw new Error(`@drawcall/lod: the leaves' map "${map.name}" has no image to measure`);
  const texel = uv().mul(vec2(image.width, image.height));
  const mip = max(log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel)))).mul(0.5), 0);
  return mip.mul(0.25).add(1);
}

/** The share of a leaf's sunlight arriving on its far side, by its normal. */
const leafBehind = (direction: Node<"vec3">) => saturate(dot(normalView, direction).negate());

/**
 * The light passing through a leaf from a direct light in `direction`, of that light × the leaf's colour: `behind` the
 * share arriving on its far side.
 */
function transmitted(behind: (direction: Node<"vec3">) => Node<"float">, share: number, tint: Color) {
  return (direction: Node<"vec3">): Node<"vec3"> => {
    // light scatters forward through the leaf: strongest when looking toward the sun
    const forward = pow(saturate(dot(positionViewDirection, direction.negate())), 3)
      .mul(0.65)
      .add(0.35);
    return behind(direction).mul(forward).mul(share).mul(color(tint));
  };
}

/** Three's lighting with `term` of each direct light's direction added, of that light × the surface's colour. */
class Translucent extends PhysicalLightingModel {
  constructor(private readonly term: (direction: Node<"vec3">) => Node<"vec3">) {
    super();
  }

  override direct(input: Parameters<PhysicalLightingModel["direct"]>[0], builder: NodeBuilder): void {
    super.direct(input, builder);
    const { lightDirection, lightColor, reflectedLight } = input;
    const { directDiffuse } = reflectedLight;
    if (!isNodeOf(lightDirection, "vec3", builder) || !isNodeOf(directDiffuse, "vec3", builder))
      throw new Error("@drawcall/lod: three's direct light is not a direction and a sum");
    // Converted, not asked its type: asked here, before its shadow is set up, three (0.186) answers a colour, keeps
    // that, and writes invalid WGSL for the shadow's vec4.
    const light = vec3(new ConvertNode<"vec3">(lightColor, "vec3"));
    directDiffuse.addAssign(this.term(lightDirection).mul(light).mul(TSL.diffuseContribution));
  }
}
