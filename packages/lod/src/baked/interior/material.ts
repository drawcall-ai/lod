import { Matrix4, type Box3, type DataTexture, type Material, type MeshStandardMaterial, type WebGLProgramParametersWithUniforms } from "three";
import { originalOf } from "../../fade.js";
import { applyEdits, type Edit } from "../../patch.js";
import { FACES, type Faces } from "./faces.js";

// Interior mapping (Andrew Willmott's interior cubemaps): a window texel looks into the
// box of the room behind it. The view ray, in the source's space, leaves that box at a
// wall point; the room's cube, rendered from the box's centre, holds what the room shows
// there. Furniture flattens onto the walls; the walls themselves are exact.

/** What a baked material needs to look into its rooms. */
export interface Rooms extends Faces {
  boxes: readonly Box3[];
  /**
   * per baked texel: R the room of the nearest window + 1, read texel by texel; G the share
   * of the room that shows, filtered
   */
  windows: DataTexture;
}

const vec3 = ({ x, y, z }: { x: number; y: number; z: number }) => `vec3(${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`;

const VERTEX_PARS = /* glsl */ `
uniform mat4 interiorSpace;
varying vec3 vInteriorPosition;
varying vec3 vInteriorRay;
varying mat3 vInteriorToWorld;
`;

// The ray in the source's space: interiorSpace maps the mesh's space there, which differs
// only where an InstancedLod moved the geometry (see `placeInterior`).
const VERTEX = /* glsl */ `
  {
    mat4 interiorModel = modelMatrix;
    #ifdef USE_INSTANCING
      interiorModel = modelMatrix * instanceMatrix;
    #endif
    vec3 interiorView = isOrthographic ? (vec4(0.0, 0.0, -1.0, 0.0) * viewMatrix).xyz : (interiorModel * vec4(transformed, 1.0)).xyz - cameraPosition;
    vInteriorPosition = (interiorSpace * vec4(transformed, 1.0)).xyz;
    vInteriorRay = mat3(interiorSpace) * (mat3(inverse(interiorModel)) * interiorView);
    vInteriorToWorld = mat3(interiorModel) * mat3(inverse(interiorSpace));
  }
`;

const FRAGMENT_PARS = /* glsl */ `
uniform sampler2D interiorWindows;
uniform highp sampler2DArray interiorResponse;
#ifdef INTERIOR_GLOW
  uniform highp sampler2DArray interiorGlow;
#endif
uniform vec3 interiorMin[INTERIOR_ROOMS];
uniform vec3 interiorMax[INTERIOR_ROOMS];
uniform float interiorFaceSize;
uniform float interiorSpan;
varying vec3 vInteriorPosition;
varying vec3 vInteriorRay;
varying mat3 vInteriorToWorld;
const vec3 INTERIOR_FORWARD[6] = vec3[6](${FACES.map(([forward]) => vec3(forward)).join(", ")});
const vec3 INTERIOR_UP[6] = vec3[6](${FACES.map(([, up]) => vec3(up)).join(", ")});
`;

// The room is lit by indirect light only: the sun's direct light, which walls and roof
// would block, is left out. Ambient light, light probes and hemisphere lights are taken
// at the window; the environment, as three lights the real room's walls, at the wall the
// view ray meets (its normal turned to world space by the model's linear part: exact for
// rotation and uniform scale). Its glow adds on top.
//
// Glass shows the room by its share, under its own reflection: three's specular term
// carries the Fresnel. The source's blended glass (opacity) instead mixes its whole lit
// colour, reflection included, over the room; this is the physically right one.
//
// The box is intersected for every texel, so the derivatives that pick the cube's mip
// level are defined across window edges.
const FRAGMENT = /* glsl */ `
  {
    float interiorShare = texture(interiorWindows, vMapUv).g;
    ivec2 interiorSize = textureSize(interiorWindows, 0);
    ivec2 interiorTexel = clamp(ivec2(vMapUv * vec2(interiorSize)), ivec2(0), interiorSize - 1);
    int interiorRoom = int(texelFetch(interiorWindows, interiorTexel, 0).r * 255.0 + 0.5) - 1;
    int interiorBox = clamp(interiorRoom, 0, INTERIOR_ROOMS - 1);
    vec3 interiorLow = interiorMin[interiorBox];
    vec3 interiorHigh = interiorMax[interiorBox];
    vec3 interiorDir = normalize(vInteriorRay);
    interiorDir += vec3(equal(interiorDir, vec3(0.0))) * 1e-6;
    vec3 interiorFar = max((interiorLow - vInteriorPosition) / interiorDir, (interiorHigh - vInteriorPosition) / interiorDir);
    vec3 interiorExit = vInteriorPosition + interiorDir * max(min(interiorFar.x, min(interiorFar.y, interiorFar.z)), 0.0);
    float interiorFootprint = max(length(dFdx(interiorExit)), length(dFdy(interiorExit)));
    if (interiorRoom >= 0 && interiorShare > 0.0) {
      vec3 wall = interiorExit - 0.5 * (interiorLow + interiorHigh);
      vec3 a = abs(wall);
      int face = a.x >= a.y && a.x >= a.z ? (wall.x >= 0.0 ? 0 : 1) : a.y >= a.z ? (wall.y >= 0.0 ? 2 : 3) : (wall.z >= 0.0 ? 4 : 5);
      vec3 forward = INTERIOR_FORWARD[face];
      vec3 up = INTERIOR_UP[face];
      float depth = max(dot(wall, forward), 1e-6) * interiorSpan;
      vec3 at = vec3(0.5 + 0.5 * vec2(dot(wall, cross(forward, up)), dot(wall, up)) / depth, float(interiorRoom * 6 + face));
      float level = log2(max(interiorFootprint * 0.5 * interiorFaceSize / depth, 1e-6));
      #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
        vec3 inward = interiorFar.x <= min(interiorFar.y, interiorFar.z) ? vec3(-sign(interiorDir.x), 0.0, 0.0)
          : interiorFar.y <= interiorFar.z ? vec3(0.0, -sign(interiorDir.y), 0.0) : vec3(0.0, 0.0, -sign(interiorDir.z));
        vec3 light = irradiance + getIBLIrradiance(normalize((viewMatrix * vec4(vInteriorToWorld * inward, 0.0)).xyz));
      #else
        vec3 light = irradiance + iblIrradiance;
      #endif
      vec3 room = textureLod(interiorResponse, at, level).rgb * light * RECIPROCAL_PI;
      #ifdef INTERIOR_GLOW
        room += textureLod(interiorGlow, at, level).rgb;
      #endif
      outgoingLight = mix(totalDiffuse, room, interiorShare) + totalSpecular + totalEmissiveRadiance;
    }
  }
`;

const EDITS: Edit[] = [
  ["vertex", "#include <common>", `#include <common>\n${VERTEX_PARS}`],
  ["vertex", "#include <project_vertex>", `#include <project_vertex>\n${VERTEX}`],
  ["fragment", "#include <common>", `#include <common>\n${FRAGMENT_PARS}`],
  ["fragment", "#include <opaque_fragment>", `${FRAGMENT}\n#include <opaque_fragment>`],
];

/** Materials `furnish` patched. */
const interiors = new WeakSet<Material>();

/** Per material (a faded copy included): where its mesh's space sits in the source's, see `placeInterior`. */
const spaces = new WeakMap<Material, { value: Matrix4 }>();

function spaceOf(material: Material): { value: Matrix4 } {
  let space = spaces.get(material);
  if (!space) spaces.set(material, (space = { value: new Matrix4() }));
  return space;
}

/** Let `material`, a baked level's, show `rooms` through its windows. Its textures go with it. */
export function furnish(material: MeshStandardMaterial, rooms: Rooms): void {
  const uniforms = {
    interiorWindows: { value: rooms.windows },
    interiorResponse: { value: rooms.response },
    interiorGlow: { value: rooms.glow },
    interiorMin: { value: rooms.boxes.map((box) => box.min.clone()) },
    interiorMax: { value: rooms.boxes.map((box) => box.max.clone()) },
    interiorFaceSize: { value: rooms.response.image.width },
    interiorSpan: { value: rooms.span },
  };
  const count = rooms.boxes.length;
  const glows = rooms.glow !== null;
  // `this` is the material compiling: a faded copy calls this with itself.
  material.onBeforeCompile = function (this: Material, shader: WebGLProgramParametersWithUniforms) {
    Object.assign(shader.uniforms, uniforms, { interiorSpace: spaceOf(this) });
    shader.defines = { ...shader.defines, INTERIOR_ROOMS: count, ...(glows ? { INTERIOR_GLOW: "" } : {}) };
    applyEdits(shader, EDITS);
  };
  material.customProgramCacheKey = () => `lod-interior|${count}|${glows}`;
  material.addEventListener("dispose", () => {
    rooms.response.dispose();
    rooms.glow?.dispose();
    rooms.windows.dispose();
  });
  interiors.add(material);
}

/**
 * Tell `material` (or a faded copy of it), if it shows rooms, that its mesh's geometry
 * was moved by `placement` out of the source's space: InstancedLod draws copies of its
 * templates' geometry placed in the instance's space.
 */
export function placeInterior(material: Material, placement: Matrix4): void {
  if (interiors.has(originalOf(material))) spaceOf(material).value.copy(placement).invert();
}
