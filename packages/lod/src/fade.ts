import { Color, Material, Matrix4, Vector3, Vector4, type Mesh, type Sphere, type WebGLProgramParametersWithUniforms } from "three";
import { FADE, type Level } from "./levels.js";
import { applyEdits, type Edit } from "./patch.js";
import { isImpostorMesh } from "./three.js";
import type { View } from "./view.js";

// The dithered fade between neighbouring levels of one object.
//
// Both sides measure the same subtense: the diameter of the object's bounding sphere
// over its distance to the eye, the sphere scaled by the largest axis scale of the
// object's root. `subtense` (CPU) and `lodFadeSubtense` (GLSL) are the same formula on
// the same matrices: a mesh finds its object's root as model (× instance) × fromRoot.
//
// Each level's fade is a Vector4 in subtense: (x, y) is the fade at the top of its
// range, where it is the coarser side, gone at y and drawn below x; (z, w) is the fade at
// the bottom of its range to the next, coarser level, where it is the finer side, gone at
// z and drawn above w. An empty range (x == y) is no fade. Both sides of a fade discard
// complementary dither cells, so every pixel is drawn by exactly one. Outside its ranges
// a level draws whole; which levels draw at all is the CPU's choice (visibility, or
// instance lists).

const scratch = new Vector3();

/** The CPU twin of `lodFadeSubtense`. */
export function subtense(root: Matrix4, sphere: Sphere, eye: Vector3): number {
  const centre = scratch.copy(sphere.center).applyMatrix4(root);
  return (2 * sphere.radius * root.getMaxScaleOnAxis()) / Math.max(eye.distanceTo(centre), 1e-6);
}

/** Vertex-stage declarations of a faded shader. */
export const FADE_VERTEX_PARS = /* glsl */ `
uniform vec4 lodFadeSphere;
uniform mat4 lodFadeFromRoot;
varying float vLodFadeSubtense;

float lodFadeSubtense(mat4 root, vec4 sphere, vec3 eye) {
  float scale = max(length(root[0].xyz), max(length(root[1].xyz), length(root[2].xyz)));
  return 2.0 * sphere.w * scale / max(distance(eye, (root * vec4(sphere.xyz, 1.0)).xyz), 1e-6);
}
`;

/** Measure this vertex's object from `eye`; `model` is its model (× instance) matrix. */
export const fadeVertex = (model: string, eye: string) => /* glsl */ `
  vLodFadeSubtense = lodFadeSubtense(${model} * lodFadeFromRoot, lodFadeSphere, ${eye});
`;

/** Fragment-stage declarations of a faded shader. */
export const FADE_FRAGMENT_PARS = /* glsl */ `
uniform vec4 lodFade;
uniform vec3 lodTint;
varying float vLodFadeSubtense;

float lodFadeDither(vec2 p) {
  // Interleaved gradient noise.
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

bool lodFadeDiscard(vec4 fade, float subtense) {
  float d = lodFadeDither(gl_FragCoord.xy);
  if (fade.x < fade.y && d < smoothstep(fade.x, fade.y, subtense)) return true;
  if (fade.z < fade.w && d >= smoothstep(fade.z, fade.w, subtense)) return true;
  return false;
}
`;

/** Leave this pixel to the other side of a fade. */
export const FADE_DISCARD = /* glsl */ `
  if (lodFadeDiscard(lodFade, vLodFadeSubtense)) discard;
`;

/**
 * `FADE_DISCARD` for an ImpostorMesh's shadow maps: fading in, it casts nothing until the
 * finer level is gone. A mesh level casts whole while it draws (three's depth materials
 * know no fade), and a dithered impostor shadow on top of it would cast double. Fading
 * out, toward a coarser level or none, it dithers as in the view.
 */
export const FADE_SHADOW_DISCARD = /* glsl */ `
  if (lodFade.x < lodFade.y && vLodFadeSubtense > lodFade.x) discard;
  if (lodFadeDiscard(vec4(0.0, 0.0, lodFade.zw), vLodFadeSubtense)) discard;
`;

/** The debug tint (see `Lod.debug`), white when off. */
export const FADE_TINT = /* glsl */ `
  diffuseColor.rgb *= lodTint;
`;

/** What a faded shader reads. `lodFade` and `lodTint` are a level's, shared by its meshes. */
interface FadeUniforms {
  lodFade: { value: Vector4 };
  lodFadeSphere: { value: Vector4 };
  lodFadeFromRoot: { value: Matrix4 };
  lodTint: { value: Color };
}

export const fadeUniforms = (): FadeUniforms => ({
  lodFade: { value: new Vector4(0, 0, 0, 0) },
  lodFadeSphere: { value: new Vector4() },
  lodFadeFromRoot: { value: new Matrix4() },
  lodTint: { value: new Color(1, 1, 1) },
});

/**
 * Fade `mesh` by `level`, measuring `sphere` (in the root's space) from the mesh's space,
 * which `placement` maps into the root's: an ImpostorMesh through its own uniforms, any
 * other mesh by drawing with its own faded copies of its materials.
 */
export function fadeMesh(mesh: Mesh, level: Level, sphere: Sphere, placement: Matrix4): void {
  const own = isImpostorMesh(mesh) ? faded.get(mesh.material) : undefined;
  const uniforms = own ?? fadeUniforms();
  uniforms.lodFade.value = level.fade;
  uniforms.lodTint.value = level.tint;
  uniforms.lodFadeSphere.value.set(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius);
  uniforms.lodFadeFromRoot.value.copy(placement).invert();
  if (own) return;
  const fade = (material: Material) => fadedCopy(material, uniforms);
  mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fade) : fade(mesh.material);
}

/** Debug tints by level index, see `Lod.debug`. */
const TINTS = [0xff6060, 0x60ff60, 0x6080ff, 0xffd040, 0xff60ff, 0x60ffff].map((hex) => new Color(hex));
const WHITE = new Color(1, 1, 1);

/** Write each level's fade and tint for `view` (see the top of this file). */
export function writeFades(levels: readonly Level[], view: View, quality: number, debug: boolean): void {
  for (const level of levels) {
    const upper = view.fades ? top(levels, level, quality, view.scale) : 0;
    const lower = view.fades ? top(levels, levels[level.index + 1], quality, view.scale) : 0;
    level.fade.set(upper * (1 - FADE), upper, lower * (1 - FADE), lower);
    level.tint.copy(debug ? (TINTS[level.index % TINTS.length] ?? WHITE) : WHITE);
  }
}

/** maxPixels of the fade at the top of `level`'s range, in subtense; 0 for none. */
function top(levels: readonly Level[], level: Level | undefined, quality: number, scale: number): number {
  const finer = level && levels[level.index - 1];
  if (!level || !finer || level.nested || finer.nested) return 0;
  return level.maxPixels / quality / scale;
}

/** Faded material → its uniforms; ImpostorMesh registers its own materials here. */
const faded = new WeakMap<Material, FadeUniforms>();
/** Faded copy → the material it copies. */
const originals = new WeakMap<Material, Material>();

export const registerFade = (material: Material, uniforms: FadeUniforms): void => void faded.set(material, uniforms);
export const fadeUniformsOf = (material: Material): FadeUniforms | undefined => faded.get(material);

/** A runtime material copy keeps its fade state, while rebuilt LODs start from the original. */
export function inheritFade(source: Material, target: Material): void {
  const uniforms = faded.get(source);
  if (!uniforms) return;
  faded.set(target, uniforms);
  originals.set(target, originalOf(source));
}

const EDITS: Edit[] = [
  ["vertex", "#include <common>", `#include <common>\n${FADE_VERTEX_PARS}`],
  [
    "vertex",
    "#include <project_vertex>",
    `#include <project_vertex>\n  {\n    mat4 lodModel = modelMatrix;\n    #ifdef USE_INSTANCING\n      lodModel = modelMatrix * instanceMatrix;\n    #endif\n    ${fadeVertex("lodModel", "cameraPosition")}\n  }`,
  ],
  ["fragment", "#include <common>", `#include <common>\n${FADE_FRAGMENT_PARS}`],
  ["fragment", "#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>\n${FADE_DISCARD}`],
  ["fragment", "#include <color_fragment>", `#include <color_fragment>\n${FADE_TINT}`],
];

/**
 * A faded copy of `material` reading `uniforms`, copied from the original when
 * `material` is itself a faded copy. Copies of one material share a program: three
 * keys programs by shader source, not by material. Needs three's built-in chunks.
 */
export function fadedCopy(material: Material, uniforms: FadeUniforms): Material {
  const original = originals.get(material) ?? material;
  const copy = original.clone();
  // Material.copy drops the original's patch; the copy chains it.
  const previous = original.onBeforeCompile;
  const previousKey = original.customProgramCacheKey;
  // three's default key is the source of onBeforeCompile, which is about to be ours.
  const key = previousKey === Material.prototype.customProgramCacheKey ? () => previous.toString() : () => previousKey.call(copy);
  copy.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    previous.call(copy, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    applyEdits(shader, EDITS);
  };
  copy.customProgramCacheKey = () => `${key()}|lod-fade`;
  faded.set(copy, uniforms);
  originals.set(copy, original);
  return copy;
}

/** The material a faded copy was made from, or `material` itself. */
export const originalOf = (material: Material): Material => originals.get(material) ?? material;
