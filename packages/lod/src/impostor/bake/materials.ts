import { DoubleSide, MeshStandardNodeMaterial, NoBlending, type Material, type Node, type NodeBuilder, type NodeMaterial, type Object3D } from "three/webgpu";
import {
  ambientOcclusion,
  cameraViewMatrix,
  Fn,
  clamp,
  diffuseColor,
  emissive,
  faceDirection,
  float,
  materialMetalness,
  materialOpacity,
  materialRoughness,
  max,
  mrt,
  normalView,
  normalize,
  positionView,
  positionLocal,
  specularColor,
  specularF90,
  step,
  vec4,
} from "three/tsl";
import { isMesh, isNodeMaterial, isPhysical, isStandard, isStandardNode, toNodeMaterial } from "../../three.js";
import { affine, biasedTextures, isNodeOf } from "../../tsl.js";
import { placeInstances } from "../../fade.js";
import { originalOf } from "../../material.js";

/** What every bake material reads, shared by all of them and set per bake. */
export interface BakeSettings {
  /** the cameras' distance from the bounding box centre, and the bounding radius: the depth encoding */
  distance: number;
  radius: number;
  /** mip bias of every texture read, per mip level: textures are read at the size of a texel (see `bakeImpostor`) */
  textureBias: Node<"float"> & { value: number };
}

/**
 * The outputs a bake material writes, by name: one per atlas map, then the second way to
 * store the normals (see Atlas) and the specular. A render target takes the ones it has
 * textures of that name for, so every material writes them all and the bake decides,
 * once it knows every material, which it keeps.
 */
export const OUTPUTS = ["base", "normalDepth", "orm", "emissive", "turned", "specular"] as const;
export type Output = (typeof OUTPUTS)[number];

/**
 * Replace the materials of every visible mesh under `root` with bake materials, which
 * write the surface values unlit into the atlas maps. Returns the bake materials (to
 * dispose), whether any of them emits light and whether any changes three's default specular.
 */
export function swapMaterials(root: Object3D, settings: BakeSettings): { materials: Material[]; emits: boolean; specular: boolean } {
  const baked = new Map<Material, { material: NodeMaterial; emits: boolean; specular: boolean }>();
  const plain = new Set<string>();
  root.traverseVisible((node) => {
    // Lines, points and sprites would write their colour into the data targets. Layers
    // rather than `visible`, which would also hide any mesh children.
    if ("isLine" in node || "isPoints" in node || "isSprite" in node) return node.layers.disableAll();
    if (!isMesh(node)) return;
    const swap = (material: Material): Material => {
      // A deferred bake may see a source already hooked by Lod or Wind. Bake its
      // authored surface at rest, without the runtime fade/tint/sway wrappers.
      const source = originalOf(material);
      let entry = baked.get(source);
      if (!entry) {
        entry = bakeMaterial(source, settings);
        baked.set(source, entry);
        if (!isStandard(source) && !isNodeMaterial(source) && !MAPPED.has(source.type)) plain.add(source.type);
      }
      return entry.material;
    };
    node.material = Array.isArray(node.material) ? node.material.map(swap) : swap(node.material);
  });
  if (plain.size > 0) console.warn(`bakeImpostor: ${[...plain].join(", ")} bake as a plain rough MeshStandardMaterial with their color/map only`);
  const entries = [...baked.values()];
  return { materials: entries.map((e) => e.material), emits: entries.some((e) => e.emits), specular: entries.some((e) => e.specular) };
}

const STANDARD_KEYS = [
  "color",
  "map",
  "alphaMap",
  "alphaTest",
  "alphaHash",
  "alphaToCoverage",
  "side",
  "vertexColors",
  "opacity",
  "transparent",
  "normalMap",
  "normalMapType",
  "normalScale",
  "bumpMap",
  "bumpScale",
  "aoMap",
  "aoMapIntensity",
  "emissive",
  "emissiveMap",
  "emissiveIntensity",
  "flatShading",
  "displacementMap",
  "displacementScale",
  "displacementBias",
  "wireframe",
] as const;

/** Built-in materials whose look the standard keys carry over; others only keep their color/map. */
const MAPPED = new Set(["MeshBasicMaterial", "MeshLambertMaterial", "MeshPhongMaterial", "MeshToonMaterial", "MeshMatcapMaterial"]);

/** A node material that renders like `source`: a copy of a node or standard one, else the standard keys carried over. */
function toStandard(source: Material): NodeMaterial {
  if (isNodeMaterial(source) || isStandard(source)) return toNodeMaterial(source);
  // Unlit and Lambert/Phong materials bake as a fully rough dielectric. Their settings
  // are read by name: they are whatever subclass the app used.
  const values = Object.fromEntries(STANDARD_KEYS.flatMap((k) => (Reflect.get(source, k) === undefined ? [] : [[k, Reflect.get(source, k)]])));
  return new MeshStandardNodeMaterial({ roughness: 1, metalness: 0, ...values });
}

/** A material's float slot (or its default), as the float it builds to. */
const scalar = (node: Node, builder: NodeBuilder): Node<"float"> => {
  if (!isNodeOf(node, "float", builder)) throw new Error(`bakeImpostor: a material's float slot builds to ${node.getNodeType(builder)}`);
  return node;
};

function bakeMaterial(source: Material, settings: BakeSettings): { material: NodeMaterial; emits: boolean; specular: boolean } {
  const material = toStandard(source);
  const position = material.positionNode;
  material.positionNode = Fn((builder) => {
    placeInstances(builder);
    if (!position) return positionLocal;
    if (!isNodeOf(position, "vec3", builder)) throw new Error("bakeImpostor: position must build to vec3");
    return position;
  })();
  // A material that draws no colour has no surface to bake.
  material.visible = source.visible && source.colorWrite;
  const emits = material.visible && emitsLight(material);
  const specular = material.visible && changesSpecular(source);
  // Coverage is the material's alpha where it cuts the surface out: alpha-to-coverage (no
  // multisampling here, so it would cover the card), or a blended material's texture
  // alpha. A blended material's uniform opacity (glass) is no hole: it folds into the
  // colour, as if the pane were dark and opaque, which keeps its reflection.
  const blended = material.transparent;
  const coverage = blended ? diffuseColor.a.div(max(materialOpacity, 1e-4)) : material.alphaToCoverage ? diffuseColor.a : float(1);
  const opacity = blended ? materialOpacity : float(1);
  // Blending would mix the outputs with the cleared background; coverage carries alpha
  // instead. Without normal blending three also keeps the alpha (not opaque).
  material.transparent = false;
  material.blending = NoBlending;
  material.depthWrite = true;
  material.contextNode = biasedTextures(settings.textureBias);

  // Two ways to store the normals three shades with, each a normal and the share of the
  // surface that shades with it rather than its opposite; the bake keeps the one whose
  // normals agree more once averaged (see Atlas):
  // - the surface's own normal and the share whose front faced the camera (on two-sided
  //   surfaces three turns the normal toward the camera; this undoes it). Painted canopy
  //   normals of cut-out foliage agree this way, which three turns inward on every leaf
  //   seen from behind.
  // - the shading normal turned toward the camera and the share that faced it already.
  //   Real leaf normals agree this way, which three turns toward the camera on every leaf.
  // The camera is orthographic, looking along -z; the object sits at the origin, so world
  // space is its own.
  const twoSided = material.side === DoubleSide && !(isStandardNode(material) && material.flatShading);
  const own = twoSided ? normalView.mul(faceDirection) : normalView;
  const front = twoSided ? faceDirection.mul(0.5).add(0.5) : float(1);
  const facing = step(0, normalView.z);
  const toObject = (n: Node<"vec3">) => normalize(affine(cameraViewMatrix).solve(n)).mul(0.5).add(0.5);
  const depth = clamp(positionView.z.add(settings.distance).div(settings.radius).mul(0.5).add(0.5), 0, 1);
  // Unlit values: the material's own roughness and metalness, not three's lighting ones.
  const roughness = (isStandardNode(material) && material.roughnessNode) || materialRoughness;
  const metalness = (isStandardNode(material) && material.metalnessNode) || materialMetalness;
  const outputs: Record<Output, Node> = {
    base: vec4(clamp(diffuseColor.rgb.mul(opacity), 0, 1), clamp(coverage, 0, 1)),
    normalDepth: vec4(toObject(own), depth),
    orm: Fn((builder) => vec4(ambientOcclusion, scalar(roughness, builder), scalar(metalness, builder), front))(),
    emissive: vec4(clamp(emissive, 0, 1), 1),
    turned: vec4(toObject(normalView.mul(facing.mul(2).sub(1))), facing),
    specular: vec4(specularColor, specularF90),
  };
  material.mrtNode = mrt(outputs);
  return { material, emits, specular };
}

/** Whether `material` emits light: an emissive node, colour × intensity, or map. */
function emitsLight(material: NodeMaterial): boolean {
  if (!isStandardNode(material)) return false;
  const { emissive: e, emissiveIntensity, emissiveMap, emissiveNode } = material;
  return emissiveNode !== null || (e.r + e.g + e.b) * emissiveIntensity > 0 || emissiveMap !== null;
}

/** Whether `material` lights with other than three's dielectric F0 0.04 and F90 1 (KHR_materials_specular). */
function changesSpecular(material: Material): boolean {
  if (!isPhysical(material)) return false;
  const { ior, specularIntensity, specularColor: c, specularIntensityMap, specularColorMap } = material;
  return ior !== 1.5 || specularIntensity !== 1 || c.r !== 1 || c.g !== 1 || c.b !== 1 || specularIntensityMap !== null || specularColorMap !== null;
}
