import { Matrix4, Vector2, Vector3, type Material, type Object3D, type WebGLProgramParametersWithUniforms } from "three";
import { boundingRadius, boxCentre, type Impostor } from "./impostor.js";
import { isMesh } from "./three.js";
import { applyEdits, type Edit } from "./patch.js";

// The hand-off between an ImpostorMesh and the real object, shared by both sides so
// they agree to the pixel. Subtense is the bounding diameter over the distance to the
// bounding centre; an orthographic projection has no distance and never hands off.
// In the band, the impostor discards where the dither is <= the fade amount and the
// real object where it is >, so every pixel is drawn by exactly one of the two.

/** Interleaved gradient noise. */
export const DITHER_GLSL = /* glsl */ `
float impostorDither(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
`;

/**
 * Vertex-stage helpers. Orthographic is read off the projection: three only sets its
 * isOrthographic uniform for some materials (not the depth materials of shadow passes).
 */
export const SUBTENSE_GLSL = /* glsl */ `
bool impostorOrtho() {
  return projectionMatrix[3][3] == 1.0;
}

float impostorSubtense(mat4 model, vec3 centre, float radius, vec3 eye) {
  float scale = max(length(model[0].xyz), max(length(model[1].xyz), length(model[2].xyz)));
  return 2.0 * radius * scale / max(distance(eye, (model * vec4(centre, 1.0)).xyz), 1e-6);
}
`;

const discard = (op: "<=" | ">") => /* glsl */ `
  if (impostorFade.y > 0.0 && impostorDither(gl_FragCoord.xy) ${op} smoothstep(impostorFade.x, impostorFade.y, vImpostorSubtense)) discard;
`;

/** The impostor's discard: fully drawn below the band, gone above it. */
export const IMPOSTOR_DISCARD = discard("<=");

/** The real object's discard: the complement of the impostor's. */
const REAL_DISCARD = discard(">");

export function boundsUniforms(impostor: Impostor) {
  return {
    impostorCentre: { value: new Vector3(...boxCentre(impostor.box)) },
    impostorRadius: { value: boundingRadius(impostor.box) },
  };
}

/** A hand-off band as a Vector2; throws unless 0 <= lo < hi. */
export function toFadeBand(band: Vector2 | [number, number]): Vector2 {
  const v = band instanceof Vector2 ? band : new Vector2(...band);
  if (!(v.x >= 0 && v.x < v.y)) throw new Error(`@drawcall/impostor: fade band must satisfy 0 <= lo < hi, got [${v.x}, ${v.y}]`);
  return v;
}

const VERTEX_PARS = /* glsl */ `
uniform vec3 impostorCentre;
uniform float impostorRadius;
uniform mat4 impostorFromRoot;
varying float vImpostorSubtense;
${SUBTENSE_GLSL}
`;

const VERTEX = /* glsl */ `
  #include <project_vertex>
  {
    mat4 fadeModel = modelMatrix;
    #ifdef USE_INSTANCING
      fadeModel = modelMatrix * instanceMatrix;
    #endif
    // The baked object's own space to world, whatever part of it this mesh is.
    mat4 fadeRoot = fadeModel * impostorFromRoot;
    vImpostorSubtense = impostorOrtho() ? 0.0 : impostorSubtense(fadeRoot, impostorCentre, impostorRadius, cameraPosition);
  }
`;

const FRAGMENT_PARS = /* glsl */ `
uniform vec2 impostorFade;
varying float vImpostorSubtense;
${DITHER_GLSL}
`;

const EDITS: Edit[] = [
  ["vertex", "#include <common>", `#include <common>\n${VERTEX_PARS}`],
  ["vertex", "#include <project_vertex>", VERTEX],
  ["fragment", "#include <common>", `#include <common>\n${FRAGMENT_PARS}`],
  ["fragment", "#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>\n${REAL_DISCARD}`],
];

/**
 * Patch one material of the real object so it dithers in where an `ImpostorMesh` of
 * `impostor` dithers out. Pass the mesh's `fadeBand` so both follow later changes.
 * `toRoot` maps the mesh's own space into the space the impostor was baked in (the
 * object given to `bakeImpostor`); identity when the mesh is that object. Chains any
 * existing `onBeforeCompile`; patching a material twice throws. Returns the band.
 */
export function fadeMaterial(material: Material, impostor: Impostor, fadeBand: Vector2 | [number, number], toRoot = new Matrix4()): Vector2 {
  if (material.userData.impostorFade) throw new Error("fadeMaterial: material is already faded");
  const band = toFadeBand(fadeBand);
  const uniforms = {
    ...boundsUniforms(impostor),
    impostorFade: { value: band },
    impostorFromRoot: { value: toRoot.clone().invert() },
  };
  const previous = material.onBeforeCompile;
  // Read now: three's default key is onBeforeCompile's source, which is about to change.
  const previousKey = material.customProgramCacheKey();
  material.userData.impostorFade = true;
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    applyEdits(shader, EDITS);
  };
  material.customProgramCacheKey = () => `${previousKey}|impostor-fade`;
  material.needsUpdate = true;
  return band;
}

/**
 * Fade every mesh under `root`: the object that was baked, or a copy of it placed
 * anywhere. Each mesh gets faded copies of its materials, since parts at different
 * offsets from the root need different `toRoot` matrices. Returns the band.
 *
 * Only the colour is faded: past the band, hide the real object (a distance check or
 * THREE.LOD), which also stops its shadow and its cost.
 */
export function fadeObject(root: Object3D, impostor: Impostor, fadeBand: Vector2 | [number, number]): Vector2 {
  const band = toFadeBand(fadeBand);
  root.updateWorldMatrix(true, true);
  const rootInverse = root.matrixWorld.clone().invert();
  root.traverse((mesh) => {
    if (!isMesh(mesh)) return;
    const toRoot = rootInverse.clone().multiply(mesh.matrixWorld);
    const swap = (material: Material): Material => {
      const copy = material.clone();
      // Material.copy drops these; the copy must render like the original.
      copy.onBeforeCompile = material.onBeforeCompile;
      copy.customProgramCacheKey = material.customProgramCacheKey;
      fadeMaterial(copy, impostor, band, toRoot);
      return copy;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  return band;
}
