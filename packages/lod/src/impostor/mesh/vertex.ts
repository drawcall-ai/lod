import { FADE_VERTEX_PARS, fadeVertex } from "../../fade.js";
import { ShaderChunk } from "three";
import { OCTAHEDRAL_GLSL } from "../octahedral.js";
import { replaceOrThrow, type Edit } from "../../patch.js";

/** Uniforms and varyings both stages declare. */
export const SHARED_PARS = /* glsl */ `
uniform float impostorFrames;
uniform vec3 impostorCentre;
uniform float impostorHalfSize;
uniform float impostorRadius;
flat varying vec2 vImpostorFrame0;
flat varying vec2 vImpostorFrame1;
flat varying vec2 vImpostorFrame2;
flat varying vec3 vImpostorWeights;
varying vec3 vImpostorPoint;
varying vec3 vImpostorRay;
varying vec3 vImpostorViewPoint;
varying vec3 vImpostorViewRay;
#ifdef IMPOSTOR_LIT
flat varying vec3 vImpostorNormalX;
flat varying vec3 vImpostorNormalY;
flat varying vec3 vImpostorNormalZ;
#endif
${OCTAHEDRAL_GLSL}
`;

// Received shadows: three computes each light's shadow coordinate per vertex, at the
// card. Shadow coordinates are linear in world position, so the view ray in each
// light's shadow space lets the fragment slide the lookup to the resolved surface.
// Looked up at the card instead, which runs through the crown's centre, an impostor
// sits behind its own sunlit outside and shades itself dark.
export const SHADOW_RAY_PARS = /* glsl */ `
#ifdef USE_SHADOWMAP
  #if NUM_DIR_LIGHT_SHADOWS > 0
    varying vec4 vImpostorDirectionalRay[ NUM_DIR_LIGHT_SHADOWS ];
  #endif
  #if NUM_POINT_LIGHT_SHADOWS > 0
    varying vec4 vImpostorPointRay[ NUM_POINT_LIGHT_SHADOWS ];
  #endif
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
  varying vec4 vImpostorSpotRay[ NUM_SPOT_LIGHT_COORDS ];
#endif
`;

// three's shadowmap_vertex as it is when the material compiles (see fragment.ts `lights`),
// with the normal offset (against acne) along the card's facing, since the plane
// geometry's own normal points anywhere.
const shadowRayVertex = () =>
  replaceOrThrow(
    ShaderChunk.shadowmap_vertex,
    "transformNormalByInverseViewMatrix( transformedNormal, viewMatrix )",
    "normalize( mat3( impostorModel ) * impostorView )",
  ) +
  /* glsl */ `
#ifdef USE_SHADOWMAP
  #if NUM_DIR_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      vImpostorDirectionalRay[ i ] = directionalShadowMatrix[ i ] * vec4( impostorWorldRay, 0.0 );
    }
    #pragma unroll_loop_end
  #endif
  #if NUM_POINT_LIGHT_SHADOWS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ ) {
      vImpostorPointRay[ i ] = pointShadowMatrix[ i ] * vec4( impostorWorldRay, 0.0 );
    }
    #pragma unroll_loop_end
  #endif
#endif
#if NUM_SPOT_LIGHT_COORDS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_SPOT_LIGHT_COORDS; i ++ ) {
    vImpostorSpotRay[ i ] = spotLightMatrix[ i ] * vec4( impostorWorldRay, 0.0 );
  }
  #pragma unroll_loop_end
#endif
`;

const VERTEX_PARS =
  SHARED_PARS +
  SHADOW_RAY_PARS +
  FADE_VERTEX_PARS +
  /* glsl */ `
// The viewing camera, also in shadow passes: the fade follows what the view sees.
uniform vec3 impostorViewer;
// Where the card sits within an instance's space; identity except under InstancedLod.
uniform mat4 impostorPlacement;

// Orthographic, read off the projection: three only sets its isOrthographic uniform for
// some materials (not the depth materials of shadow passes).
bool impostorOrtho() {
  return projectionMatrix[3][3] == 1.0;
}
`;

// Replaces <begin_vertex>. The card is built in the object's own space, then three's
// usual instancing, model, view and projection transforms apply untouched. That keeps
// fog, clipping and logarithmic depth working, and makes non-uniform scale exact: an
// affine map preserves a parallel projection.
const BEGIN_VERTEX = /* glsl */ `
  mat4 impostorModel = modelMatrix;
  // As three's project_vertex composes it: the CPU-made modelViewMatrix keeps the depth
  // the fragment writes as precise as three's own, far from the world origin too.
  mat4 impostorModelView = modelViewMatrix;
  #ifdef USE_INSTANCING
    impostorModel = modelMatrix * instanceMatrix;
    impostorModelView = modelViewMatrix * instanceMatrix;
  #endif
  impostorModel = impostorModel * impostorPlacement;
  impostorModelView = impostorModelView * impostorPlacement;
  mat4 impostorInverse = inverse(impostorModel);
  vec3 impostorEye = (impostorInverse * vec4(cameraPosition, 1.0)).xyz;
  vec3 impostorView;
  float impostorGrow = 1.0;
  if (impostorOrtho()) {
    // Shadow passes of directional lights land here too: the card faces the light.
    vec3 back = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    impostorView = normalize((impostorInverse * vec4(back, 0.0)).xyz);
  } else {
    impostorView = normalize(impostorEye - impostorCentre);
    // Up close, perspective spreads the near side of the object past the ortho frame.
    float d = length(impostorEye - impostorCentre);
    impostorGrow = min(d / max(d - impostorRadius, 1e-4), 4.0);
  }

  ${fadeVertex("impostorModel", "impostorViewer")}

  vec3 impostorT;
  vec3 impostorB;
  impostorBasis(impostorView, impostorT, impostorB);
  vec3 transformed = impostorCentre + (impostorT * position.x + impostorB * position.y) * (2.0 * impostorHalfSize * impostorGrow);

  // The three frames around the view direction and their barycentric weights.
  float last = impostorFrames - 1.0;
  // Clamped: rounding can put a horizon view a hair outside the grid.
  vec2 grid = clamp(impostorEncode(impostorView) * last, vec2(0.0), vec2(last));
  vec2 cell = min(floor(grid), vec2(last - 1.0));
  vec2 f = grid - cell;
  vImpostorFrame0 = cell;
  vImpostorFrame1 = cell + (f.x > f.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vImpostorFrame2 = cell + 1.0;
  vImpostorWeights = vec3(min(1.0 - f.x, 1.0 - f.y), abs(f.x - f.y), min(f.x, f.y));

  // The view ray through this vertex, in object and view space. The card is planar in
  // object space, so both interpolate exactly and each fragment re-derives its ray.
  vImpostorPoint = transformed;
  vImpostorRay = impostorOrtho() ? -impostorView : transformed - impostorEye;
  vImpostorViewPoint = (impostorModelView * vec4(transformed, 1.0)).xyz;
  vImpostorViewRay = mat3(impostorModelView) * vImpostorRay;
  vec3 impostorWorldRay = mat3(impostorModel) * vImpostorRay;

  #ifdef IMPOSTOR_LIT
    // Object-space normal to view space, as three's normalMatrix would for a mesh.
    mat3 impostorNormal = mat3(viewMatrix) * transpose(inverse(mat3(impostorModel)));
    vImpostorNormalX = impostorNormal[0];
    vImpostorNormalY = impostorNormal[1];
    vImpostorNormalZ = impostorNormal[2];
  #endif

  // three's transforms that follow start in the instance's space.
  transformed = (impostorPlacement * vec4(transformed, 1.0)).xyz;
`;

/** The card in every pass: built facing the camera (or light), with its three frames. */
export const VERTEX: Edit[] = [
  ["vertex", "#include <common>", `#include <common>\n${VERTEX_PARS}`],
  ["vertex", "#include <begin_vertex>", BEGIN_VERTEX],
];

/** Main pass only: shadow coordinates the fragment can slide to the surface. Built when a material compiles. */
export const vertexLit = (): Edit[] => [["vertex", "#include <shadowmap_vertex>", shadowRayVertex()]];
