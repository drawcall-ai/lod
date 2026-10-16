import { MeshStandardMaterial, NoBlending, type Material, type Object3D, type WebGLProgramParametersWithUniforms } from "three";
import { applyEdits, type Edit } from "../../patch.js";
import { isMesh, isPhysical, isStandard } from "../../three.js";

/** What every bake material reads, shared by all of them and set once per bake. */
export interface BakeSettings {
  uniforms: {
    impostorDistance: { value: number };
    impostorRadius: { value: number };
    /** mip bias of every texture read: log2 of the supersampling, so textures are read at the texel's size */
    impostorTextureBias: { value: number };
  };
  /** whether the atlas has an emissive layer, which every material then writes */
  emissive: boolean;
  /** whether every material also writes its dielectric specular, after the turned normals */
  specular: boolean;
}

/**
 * Replace the materials of every visible mesh under `root` with bake materials, which
 * render the surface values unlit into the atlas maps. Returns the bake materials (to
 * dispose), whether any of them emits light and whether any changes three's default specular.
 */
export function swapMaterials(root: Object3D, settings: BakeSettings): { materials: Material[]; emits: boolean; specular: boolean } {
  const baked = new Map<Material, { material: MeshStandardMaterial; emits: boolean; specular: boolean }>();
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
  return { materials: entries.map((e) => e.material), emits: entries.some((e) => e.emits), specular: entries.some((e) => e.specular) };
}

/**
 * The fragment tail that replaces lighting: every MRT output is written straight from
 * the material's own surface values, after any user `onBeforeCompile` has run. Every
 * texture2D read (all of three's material maps) is mip-biased, see `impostorTextureBias`.
 */
const BAKE_OUTPUTS = /* glsl */ `
#undef texture2D
#define texture2D(map, uv) texture(map, uv, impostorTextureBias)
layout(location = 1) out highp vec4 impostorNormalDepth;
layout(location = 2) out highp vec4 impostorOrm;
#ifdef IMPOSTOR_EMISSIVE
layout(location = 3) out highp vec4 impostorEmissive;
#endif
// after the maps: the other way to store the normals (see BAKE_WRITE)
layout(location = IMPOSTOR_TURNED) out highp vec4 impostorTurned;
#ifdef IMPOSTOR_SPECULAR
layout(location = IMPOSTOR_SPECULAR) out highp vec4 impostorSpecular;
#endif
uniform float impostorDistance;
uniform float impostorRadius;
uniform float impostorTextureBias;
`;

const BAKE_WRITE = /* glsl */ `
#ifdef USE_AOMAP
  float impostorAo = ambientOcclusion;
#else
  float impostorAo = 1.0;
#endif
  // Two ways to store the normals three shades with, each a normal and the share of the
  // surface that shades with it rather than its opposite; the bake keeps the one whose
  // normals agree more once averaged (see Atlas):
  // - the surface's own normal and the share whose front faced the camera (on two-sided
  //   surfaces three turns the normal toward the camera; this undoes it). Painted canopy
  //   normals of cut-out foliage agree this way, which three turns inward on every leaf
  //   seen from behind.
  // - the shading normal turned toward the camera and the share that faced it already.
  //   Real leaf normals agree this way, which three turns toward the camera on every leaf.
  // This camera is orthographic, looking along -z.
  #if defined( DOUBLE_SIDED ) && !defined( FLAT_SHADED )
    vec3 impostorOwn = normal * faceDirection;
    float impostorFront = faceDirection * 0.5 + 0.5;
  #else
    vec3 impostorOwn = normal;
    float impostorFront = 1.0;
  #endif
  float impostorFacing = step(0.0, normal.z);
  vec3 impostorNormal = normalize((vec4(impostorOwn, 0.0) * viewMatrix).xyz);
  vec3 impostorTurnedNormal = normalize((vec4(normal * (impostorFacing * 2.0 - 1.0), 0.0) * viewMatrix).xyz);
  float impostorDepth = 0.5 + 0.5 * (impostorDistance - vViewPosition.z) / impostorRadius;
  gl_FragColor = vec4(clamp(diffuseColor.rgb * IMPOSTOR_OPACITY, 0.0, 1.0), clamp(IMPOSTOR_COVERAGE, 0.0, 1.0));
  impostorNormalDepth = vec4(impostorNormal * 0.5 + 0.5, clamp(impostorDepth, 0.0, 1.0));
  impostorOrm = vec4(impostorAo, roughnessFactor, metalnessFactor, impostorFront);
  impostorTurned = vec4(impostorTurnedNormal * 0.5 + 0.5, impostorFacing);
#ifdef IMPOSTOR_EMISSIVE
  impostorEmissive = vec4(clamp(totalEmissiveRadiance, 0.0, 1.0), 1.0);
#endif
#ifdef IMPOSTOR_SPECULAR
  impostorSpecular = vec4(material.specularColor, material.specularF90);
#endif
`;

/** Settings that carry a non-standard material's look over to MeshStandardMaterial. */
const EDITS: Edit[] = [
  ["fragment", "#include <common>", `#include <common>\n${BAKE_OUTPUTS}`],
  ["fragment", "#include <dithering_fragment>", `#include <dithering_fragment>\n${BAKE_WRITE}`],
];

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

function bakeMaterial(source: Material, settings: BakeSettings): { material: MeshStandardMaterial; emits: boolean; specular: boolean } {
  // Read before any wrapping: three's default key is onBeforeCompile.toString(), the
  // same for every wrapper below, so a later call would let materials share programs.
  const key = source.customProgramCacheKey();
  const material = toStandard(source);
  // A material that draws no colour has no surface to bake.
  material.visible = source.visible && source.colorWrite;
  const { emissive: e, emissiveIntensity, emissiveMap } = material;
  const emits = material.visible && ((e.r + e.g + e.b) * emissiveIntensity > 0 || emissiveMap !== null);
  const specular = material.visible && changesSpecular(material);
  // Coverage is the material's alpha where it cuts the surface out: alpha-to-coverage (no
  // multisampling here, so it would cover the card), or a blended material's texture
  // alpha. A blended material's uniform opacity (glass) is no hole: it folds into the
  // colour, as if the pane were dark and opaque, which keeps its reflection.
  const blended = material.transparent;
  const coverage = blended ? "diffuseColor.a / max(opacity, 1e-4)" : material.alphaToCoverage ? "diffuseColor.a" : "1.0";
  const opacity = blended ? "opacity" : "1.0";
  // Blending would mix MRT outputs with the cleared background; coverage carries alpha instead.
  material.transparent = false;
  material.blending = NoBlending;
  material.depthWrite = true;

  const userCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    userCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, settings.uniforms);
    shader.defines = {
      ...shader.defines,
      IMPOSTOR_COVERAGE: coverage,
      IMPOSTOR_OPACITY: opacity,
      IMPOSTOR_TURNED: settings.emissive ? "4" : "3",
      ...(settings.emissive ? { IMPOSTOR_EMISSIVE: "" } : {}),
      ...(settings.specular ? { IMPOSTOR_SPECULAR: settings.emissive ? "5" : "4" } : {}),
    };
    applyEdits(shader, EDITS);
  };
  material.customProgramCacheKey = () => `impostor-bake|${coverage}|${opacity}|${settings.emissive}|${settings.specular}|${key}`;
  return { material, emits, specular };
}

/** Whether `material` lights with other than three's dielectric F0 0.04 and F90 1 (KHR_materials_specular). */
function changesSpecular(material: MeshStandardMaterial): boolean {
  if (!isPhysical(material)) return false;
  const { ior, specularIntensity, specularColor: c, specularIntensityMap, specularColorMap } = material;
  return ior !== 1.5 || specularIntensity !== 1 || c.r !== 1 || c.g !== 1 || c.b !== 1 || specularIntensityMap !== null || specularColorMap !== null;
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
