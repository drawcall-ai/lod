import {
  DoubleSide,
  Matrix4,
  MeshStandardNodeMaterial,
  PhysicalLightingModel,
  TSL,
  Vector3,
  Vector4,
  type Node,
  type NodeBuilder,
  type Object3D,
} from "three/webgpu";
import { Fn, diffuseColor, float, materialColor, metalness, mix, specularColor, specularF90, uniform, varyingProperty, vec3, vec4 } from "three/tsl";
import { castPosition, instanceColor, instanceMatrixOf, tint } from "../../fade.js";
import { isImpostorMesh, isShadowPass } from "../../three.js";
import { buildKey, isNodeOf } from "../../tsl.js";
import { boundingRadius, boxCentre, boxExtent, type Impostor } from "../impostor.js";
import { buildCard, card, type CardInputs } from "./card.js";
import { buildSurface, cosine, type Lighting, type Surface, type SurfaceInputs } from "./surface.js";
import { acquireTextures, releaseTextures } from "./textures.js";

const placement = uniform(new Matrix4()).onObjectUpdate(({ object }, self) =>
  object && isImpostorMesh(object) ? self.value.copy(object.placement) : self.value.identity(),
);

/** How `object`, an ImpostorMesh, places and colours its instances. */
function instancesOf(object: Object3D): { matrix: Node<"mat4">; color: Node<"vec3"> } {
  const matrix = instanceMatrixOf(object);
  if (!matrix || !isImpostorMesh(object)) throw new Error(`ImpostorMesh: "${object.name}" is drawn with an impostor's material but is no ImpostorMesh`);
  return { matrix, color: instanceColor };
}

/** How an ImpostorMesh draws: see `ImpostorMeshOptions`. */
interface ImpostorShading {
  cutoff: number;
  parallax: number;
  tolerance: number;
  mipBias: number;
}

/**
 * Draws an impostor: the card (see card.ts) in the vertex stage and the surface (see
 * surface.ts) in the fragment stage, lit as a MeshStandardMaterial lights a mesh, with
 * the baked normal, occlusion, roughness, metalness and emission. Every pass builds its
 * own card and surface: the view with parallax and, on a multisampled target, coverage
 * to alpha-to-coverage; shadow maps without either, at the resolved surface's depth.
 */
export class ImpostorMaterial extends MeshStandardNodeMaterial {
  readonly isImpostorMaterial = true;
  /** An object-space deformation of every instance (wind), applied before `placement`; null for none. */
  deformNode: Node<"mat4"> | null = null;
  /** Mip bias of every atlas read: see `ImpostorMeshOptions.mipBias`, which it starts at. */
  readonly mipBias: Node<"float"> & { value: number };

  private readonly inputs: CardInputs & SurfaceInputs;
  private readonly specular: Node<"vec4">;
  /**
   * Per build, one surface for every slot that reads it, made when the fragment stage
   * first reads it: TSL adds a node's variables to the stage being built when the node
   * is made. Keyed by what the build keeps for `anchor`: each slot gets its own proxy of
   * the builder.
   */
  private readonly surfaces = new WeakMap<object, Surface>();
  private readonly multisampled = new WeakMap<object, boolean>();
  private readonly anchor = float(0);
  private users = 0;
  private disposed = false;

  constructor(
    readonly impostor: Impostor,
    readonly shading: ImpostorShading,
  ) {
    super({ roughness: 1, metalness: 1, alphaToCoverage: true, side: DoubleSide });
    this.name = "impostor";
    const textures = acquireTextures(impostor);
    this.mipBias = uniform(shading.mipBias);
    this.specular = uniform(new Vector4().fromArray(impostor.specular ?? [0.04, 0.04, 0.04, 1]));
    const layer = (map: Impostor["maps"][number]) => textures[impostor.maps.indexOf(map)] ?? null;
    const base = layer("base");
    const normalDepth = layer("normalDepth");
    const orm = layer("orm");
    if (!base || !normalDepth || !orm) throw new Error("ImpostorMesh: the impostor lacks a base, normalDepth or orm layer");
    this.inputs = {
      layout: impostor.layout,
      centre: uniform(new Vector3(...boxCentre(impostor.box))),
      extent: uniform(new Vector3(...boxExtent(impostor.box))),
      radius: uniform(boundingRadius(impostor.box)),
      halfSize: uniform(impostor.halfSize),
      frames: uniform(impostor.frames),
      placement,
      cell: impostor.size / impostor.frames,
      maps: { base, normalDepth, orm, emissive: layer("emissive") },
      cutoff: shading.cutoff,
      tolerance: shading.tolerance,
      mipBias: this.mipBias,
    };

    this.positionNode = Fn((builder) => this.card(builder))();
    this.castShadowPositionNode = Fn((builder) => castPosition(this.card(builder)))();
    this.colorNode = Fn((builder) => {
      const { color } = this.surface(builder);
      // A shadow pass reads only the coverage, and its material has no colour.
      if (isShadowPass(builder.material)) return color;
      const rgb = color.rgb.mul(materialColor.rgb).mul(tint);
      const instance = instancesOf(builder.object).color;
      return vec4(rgb.mul(instance), color.a);
    })();
    this.maskNode = Fn((builder) => this.surface(builder).drawn)();
    this.maskShadowNode = this.maskNode;
    // Shadow passes only (see setupDepth): maps hold the resolved surface, not the card.
    this.depthNode = Fn((builder) => this.surface(builder).resolve().depth)();
    this.receivedShadowPositionNode = Fn((builder) => this.surface(builder).resolve().shadowPosition)();
    this.normalNode = Fn((builder) => this.lit(builder).normal)();
    this.roughnessNode = Fn((builder) => this.lit(builder).roughness)();
    this.metalnessNode = Fn((builder) => this.lit(builder).metalness)();
    this.aoNode = Fn((builder) => this.lit(builder).occlusion)();
    if (layer("emissive")) this.emissiveNode = Fn((builder) => this.lit(builder).emissive ?? vec3(0))();
  }

  override setup(builder: NodeBuilder): void {
    // Async shader builds yield between stages; snapshot this pass before the
    // renderer returns to a different target while the fragment stage is pending.
    this.multisampled.set(buildKey(builder, this.anchor), builder.renderer.currentSamples > 1);
    super.setup(builder);
  }

  /** One mesh starts or stops sharing this material, including when `copy` replaces it. */
  acquire(): this {
    this.users++;
    return this;
  }

  release(): void {
    if (--this.users === 0) this.dispose();
  }

  /** Explicit disposal, including by a caller: release its texture acquisition only once. */
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    super.dispose();
    releaseTextures(this.impostor);
  }

  /** The card's vertex as `builder` draws it, in the vertex stage. */
  private card(builder: NodeBuilder): Node<"vec3"> {
    // three multiplies the colour of any object with instance colours by its varying
    // vInstanceColor, which only its InstancedMesh writes: white here, as the colour node
    // applies them (the same way for every clone sharing this material).
    if (isImpostorMesh(builder.object) && builder.object.instanceColor) varyingProperty("vec3", "vInstanceColor").assign(vec3(1, 1, 1));
    return buildCard(this.inputs, instancesOf(builder.object).matrix, this.deformNode);
  }

  /**
   * The surface `builder` draws, as its pass needs it. No parallax walk in shadow passes:
   * shadow maps cover far more impostor pixels than the view, and shadows are too soft to
   * show it.
   */
  private surface(builder: NodeBuilder): Surface {
    const build = buildKey(builder, this.anchor);
    let surface = this.surfaces.get(build);
    if (!surface) {
      const shadow = isShadowPass(builder.material);
      const multisampled = shadow ? false : this.multisampled.get(build);
      if (multisampled === undefined) throw new Error("ImpostorMaterial: surface built before pass setup");
      surface = buildSurface(this.inputs, card, {
        parallax: shadow ? 0 : this.shading.parallax,
        multisampled,
        lit: !shadow,
      });
      this.surfaces.set(build, surface);
    }
    return surface;
  }

  private lit(builder: NodeBuilder): Lighting {
    const light = this.surface(builder).light;
    if (!light) throw new Error("ImpostorMesh: lighting read in a shadow pass");
    return light();
  }

  override setupLightingModel(): PhysicalLightingModel {
    return new SpreadLighting(Fn((builder) => this.lit(builder).spread)());
  }

  /** Baked F0 (RGB) and F90 (A) are uniforms so different asset averages share a shader. */
  override setupSpecular(): void {
    const f0 = this.specular.rgb;
    specularColor.assign(f0);
    TSL.specularColorBlended.assign(mix(f0, diffuseColor.rgb, metalness));
    specularF90.assign(this.specular.a);
  }

  /**
   * The view keeps the card's depth, so early depth testing keeps rejecting hidden pixels
   * (several times faster in crowds); shadow maps get the surface's (`depthNode`).
   */
  override setupDepth(builder: NodeBuilder): void {
    const surface = this.depthNode;
    this.depthNode = null;
    super.setupDepth(builder);
    this.depthNode = surface;
  }
}

/**
 * Direct diffuse light by `cosine` instead of the clamped cosine of the mean normal. That
 * one leaves a canopy unlit wherever its mean normal is side-on to the sun, where the real
 * leaves, tilted every which way, catch a good part of it; renormalised, the mean lights
 * the canopy as one smooth surface. Specular keeps three's terms: its roughness widens
 * with the spread instead.
 */
class SpreadLighting extends PhysicalLightingModel {
  constructor(private readonly spread: Node<"vec3">) {
    super();
  }

  override direct(input: Parameters<PhysicalLightingModel["direct"]>[0], builder: NodeBuilder): void {
    const { lightDirection, lightColor, reflectedLight } = input;
    const { directDiffuse } = reflectedLight;
    if (!isNodeOf(lightDirection, "vec3", builder) || !isNodeOf(lightColor, "color", builder) || !isNodeOf(directDiffuse, "vec3", builder))
      throw new Error("ImpostorMesh: three's direct light is not a direction, a colour and a sum");
    // three's terms, its diffuse into a throwaway.
    super.direct({ ...input, reflectedLight: { ...reflectedLight, directDiffuse: vec3(0).toVar() } }, builder);
    // Lambert: the diffuse colour over π.
    directDiffuse.addAssign(cosine(this.spread, lightDirection).mul(lightColor).mul(TSL.diffuseContribution).div(Math.PI));
  }
}
