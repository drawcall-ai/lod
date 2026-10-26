import { fadeVertex } from "../fade.js";
import { replaceOrThrow } from "../patch.js";

const PARS = /* glsl */ `
uniform float windTime;
uniform float windSpeed;
uniform float windStrength;
uniform vec2 windDirection;
// Slope at maximum displacement, and the fixed base's height.
uniform vec2 windShape;
uniform mat4 windPlacement;
uniform mat4 windFromRoot;

vec3 windSlopeAt(mat4 root) {
  vec3 direction = vec3(windDirection.x, 0.0, windDirection.y);
  // Express the world breeze in the root's horizontal plane, including instance scale.
  vec3 x = root[0].xyz;
  vec3 z = root[2].xyz;
  float crossAxis = dot(x, z);
  vec2 along = vec2(dot(x, direction), dot(z, direction));
  vec2 local = vec2(dot(z, z) * along.x - crossAxis * along.y, dot(x, x) * along.y - crossAxis * along.x);
  local /= max(length(local), 1e-12);
  float phase = dot(root[3].xz, vec2(0.73, 0.51));
  float sway = sin(windTime * windSpeed * 6.28318530718 + phase);
  return vec3(local.x, 0.0, local.y) * (windShape.x * windStrength * sway);
}
`;

const BEGIN = /* glsl */ `
  mat4 windRoot = modelMatrix;
  #ifdef USE_INSTANCING
    windRoot *= instanceMatrix;
  #endif
  #ifdef WIND_PLACED
    windRoot *= windFromRoot;
  #endif
  vec3 windSlope = windSlopeAt(windRoot);
  #ifdef WIND_PLACED
    // A local point moves by this slope times its root-space height above the base.
    windSlope = mat3(windFromRoot) * windSlope;
    vec3 windHeight = vec3(windPlacement[0].y, windPlacement[1].y, windPlacement[2].y);
    float windBase = windPlacement[3].y - windShape.y;
  #endif
`;

const SHEAR = /* glsl */ `
  mat4 windDeform = mat4(1.0);
  #ifdef WIND_PLACED
    windDeform[0].xyz += windSlope * windHeight.x;
    windDeform[1].xyz += windSlope * windHeight.y;
    windDeform[2].xyz += windSlope * windHeight.z;
    windDeform[3].xyz = windSlope * windBase;
  #else
    windDeform[1].xyz += windSlope;
    windDeform[3].xyz = -windSlope * windShape.y;
  #endif
`;

/** A shear is affine: the impostor's existing ray reconstruction works in its inverse. */
export function windVertex(vertex: string, impostor: boolean): string {
  let source = replaceOrThrow(vertex, "#include <common>", `#include <common>\n${PARS}`);
  source = replaceOrThrow(source, "void main() {", `void main() {\n${BEGIN}${impostor ? SHEAR : ""}`);
  if (impostor) {
    source = replaceOrThrow(
      source,
      "impostorModel = impostorModel * impostorPlacement;",
      "mat4 windRestModel = impostorModel * impostorPlacement;\n  impostorModel = impostorModel * windDeform * impostorPlacement;",
    );
    source = replaceOrThrow(
      source,
      "impostorModelView = impostorModelView * impostorPlacement;",
      "impostorModelView = impostorModelView * windDeform * impostorPlacement;",
    );
    source = replaceOrThrow(source, fadeVertex("impostorModel", "impostorViewer"), fadeVertex("windRestModel", "impostorViewer"));
    return replaceOrThrow(
      source,
      "transformed = (impostorPlacement * vec4(transformed, 1.0)).xyz;",
      "transformed = (windDeform * impostorPlacement * vec4(transformed, 1.0)).xyz;",
    );
  }
  // Morph normals are ready here. Displacement later still needs the resting normal:
  // deform its resulting position only after Three has applied that displacement.
  if (source.includes("#include <defaultnormal_vertex>")) {
    source = replaceOrThrow(
      source,
      "#include <defaultnormal_vertex>",
      /* glsl */ `
      vec3 windRestNormal = objectNormal;
      #ifdef WIND_PLACED
        objectNormal -= windHeight * dot(windSlope, objectNormal);
      #else
        objectNormal.y -= dot(windSlope, objectNormal);
      #endif
      #ifdef USE_TANGENT
        #ifdef WIND_PLACED
          objectTangent += windSlope * dot(windHeight, objectTangent);
        #else
          objectTangent += windSlope * objectTangent.y;
        #endif
      #endif
      #include <defaultnormal_vertex>
      objectNormal = windRestNormal;
    `,
    );
  }
  return replaceOrThrow(
    source,
    "#include <project_vertex>",
    /* glsl */ `
    #ifdef WIND_PLACED
      transformed += windSlope * (dot(windHeight, transformed) + windBase);
    #else
      transformed += windSlope * (transformed.y - windShape.y);
    #endif
    #include <project_vertex>
  `,
  );
}
