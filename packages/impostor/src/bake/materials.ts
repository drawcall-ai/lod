import { MeshStandardMaterial, NoBlending, type Material, type Object3D, type WebGLProgramParametersWithUniforms } from "three";
import { applyEdits, type Edit } from "../patch.js";
import { isMesh, isStandard } from "../three.js";

/** What every bake material reads, shared by all of them and set once per bake. */
export interface BakeSettings {
  uniforms: { impostorDistance: { value: number }; impostorRadius: { value: number } };
  /** whether the atlas has an emissive layer, which every material then writes */
  emissive: boolean;
}

/**
 * Replace the materials of every visible mesh under `root` with bake materials, which
 * render the surface values unlit into the atlas maps. Returns the bake materials (to
 * dispose) and whether any of them emits light.
 */
export function swapMaterials(root: Object3D, settings: BakeSettings): { materials: Material[]; emits: boolean } {
  const baked = new Map<Material, { material: MeshStandardMaterial; emits: boolean }>();
  const plain = new Set<string>();
  root.traverseVisible((node) => {
    // Lines, points and sprites would write their colour into the data targets. Layers
    // rather than `visible`, which would also hide any mesh children.
    if ("isLine" in node || "isPoints" in node || "isSprite" in node) return node.layers.disableAll();
    if (!isMesh(node)) return;
    const swap = (source: Material): Material => {
      let entry = baked.get(source);
      if (!entry) {
        entry = bakeMaterial(source, settings);
        baked.set(source, entry);
        if (!isStandard(source) && !MAPPED.has(source.type)) plain.add(source.type);
      }
      return entry.material;
    };
    node.material = Array.isArray(node.material) ? node.material.map(swap) : swap(node.material);
  });
  if (plain.size > 0) console.warn(`bakeImpostor: ${[...plain].join(", ")} bake as a plain rough MeshStandardMaterial with their color/map only`);
  const entries = [...baked.values()];
  return { materials: entries.map((e) => e.material), emits: entries.some((e) => e.emits) };
}

/**
 * The fragment tail that replaces lighting: every MRT output is written straight from
 * the material's own surface values, after any user `onBeforeCompile` has run.
 */
const BAKE_OUTPUTS = /* glsl */ `
layout(location = 1) out highp vec4 impostorNormalDepth;
layout(location = 2) out highp vec4 impostorOrm;
#ifdef IMPOSTOR_EMISSIVE
layout(location = 3) out highp vec4 impostorEmissive;
#endif
uniform float impostorDistance;
uniform float impostorRadius;
`;

const BAKE_WRITE = /* glsl */ `
#ifdef USE_AOMAP
  float impostorAo = ambientOcclusion;
#else
  float impostorAo = 1.0;
#endif
  // Two-sided surfaces: three turns the normal toward whichever side faces the camera.
  // Store the surface's own normal and, in orm.a, whether its front faced the camera; the
  // runtime picks the side per pixel with that probability. Averaging the flipped normals
  // instead would keep only the majority side: on cut-out foliage with painted canopy
  // normals, that erases the sunlit leaves.
  #if defined( DOUBLE_SIDED ) && !defined( FLAT_SHADED )
    vec3 impostorSurface = normal * faceDirection;
    float impostorFront = faceDirection * 0.5 + 0.5;
  #else
    vec3 impostorSurface = normal;
    float impostorFront = 1.0;
  #endif
  vec3 impostorNormal = normalize((vec4(impostorSurface, 0.0) * viewMatrix).xyz);
  float impostorDepth = 0.5 + 0.5 * (impostorDistance - vViewPosition.z) / impostorRadius;
  gl_FragColor = vec4(clamp(diffuseColor.rgb, 0.0, 1.0), IMPOSTOR_COVERAGE);
  impostorNormalDepth = vec4(impostorNormal * 0.5 + 0.5, clamp(impostorDepth, 0.0, 1.0));
  impostorOrm = vec4(impostorAo, roughnessFactor, metalnessFactor, impostorFront);
#ifdef IMPOSTOR_EMISSIVE
  impostorEmissive = vec4(clamp(totalEmissiveRadiance, 0.0, 1.0), 1.0);
#endif
`;

/** Settings that carry a non-standard material's look over to MeshStandardMaterial. */
const EDITS: Edit[] = [
  ["fragment", "#include <common>", `#include <common>\n${BAKE_OUTPUTS}`],
  ["fragment", "#include <dithering_fragment>", `#include <dithering_fragment>\n${BAKE_WRITE}`],
];

const STANDARD_KEYS = [
  "color", "map", "alphaMap", "alphaTest", "alphaHash", "alphaToCoverage", "side", "vertexColors", "opacity",
  "transparent", "normalMap", "normalMapType", "normalScale", "bumpMap", "bumpScale", "aoMap", "aoMapIntensity",
  "emissive", "emissiveMap", "emissiveIntensity", "flatShading", "displacementMap", "displacementScale",
  "displacementBias", "wireframe",
] as const;

/** Built-in materials whose look the standard keys carry over; others only keep their color/map. */
const MAPPED = new Set(["MeshBasicMaterial", "MeshLambertMaterial", "MeshPhongMaterial", "MeshToonMaterial", "MeshMatcapMaterial"]);

function bakeMaterial(source: Material, settings: BakeSettings): { material: MeshStandardMaterial; emits: boolean } {
  // Read before any wrapping: three's default key is onBeforeCompile.toString(), the
  // same for every wrapper below, so a later call would let materials share programs.
  const key = source.customProgramCacheKey();
  const material = toStandard(source);
  // A material that draws no colour has no surface to bake.
  material.visible = source.visible && source.colorWrite;
  const { emissive: e, emissiveIntensity, emissiveMap } = material;
  const emits = material.visible && ((e.r + e.g + e.b) * emissiveIntensity > 0 || emissiveMap !== null);
  // Coverage is the material's alpha wherever the app would see partial alpha: blended,
  // or cut out by alpha-to-coverage (no multisampling here, so it would cover the card).
  const coverage = material.transparent || material.alphaToCoverage ? "diffuseColor.a" : "1.0";
  // Blending would mix MRT outputs with the cleared background; coverage carries alpha instead.
  material.transparent = false;
  material.blending = NoBlending;
  material.depthWrite = true;

  const userCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    userCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, settings.uniforms);
    shader.defines = { ...shader.defines, IMPOSTOR_COVERAGE: coverage, ...(settings.emissive ? { IMPOSTOR_EMISSIVE: "" } : {}) };
    applyEdits(shader, EDITS);
  };
  material.customProgramCacheKey = () => `impostor-bake|${coverage}|${settings.emissive}|${key}`;
  return { material, emits };
}

/** A standard material that renders like `source`: a clone, or the standard keys carried over. */
function toStandard(source: Material): MeshStandardMaterial {
  if (isStandard(source)) {
    const material = source.clone();
    // Material.copy drops this; keeping it keeps the user's colour grading and tweaks.
    material.onBeforeCompile = source.onBeforeCompile;
    return material;
  }
  // Unlit and Lambert/Phong materials bake as a fully rough dielectric. Their settings
  // are read by name: they are whatever subclass the app used.
  const values = Object.fromEntries(STANDARD_KEYS.flatMap((k) => (Reflect.get(source, k) === undefined ? [] : [[k, Reflect.get(source, k)]])));
  return new MeshStandardMaterial({ roughness: 1, metalness: 0, ...values });
}
