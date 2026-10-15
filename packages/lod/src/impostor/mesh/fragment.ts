import { ShaderChunk } from "three";
import { FADE_DISCARD, FADE_FRAGMENT_PARS, FADE_TINT } from "../../fade.js";
import { replaceOrThrow, type Edit } from "../../patch.js";
import { SHADOW_RAY_PARS, SHARED_PARS } from "./vertex.js";

const FRAGMENT_PARS = /* glsl */ `
#ifndef USE_TRANSMISSION
uniform mat4 projectionMatrix; // transmission declares it already
#endif
uniform sampler2D impostorBase;
uniform sampler2D impostorNormalDepth;
uniform sampler2D impostorOrm;
#ifdef IMPOSTOR_EMISSIVE
uniform sampler2D impostorEmissive;
#endif
uniform float impostorSize;
uniform float impostorMultisample;
${SHARED_PARS}
${FADE_FRAGMENT_PARS}

// Atlas texels per screen pixel and the gradients every atlas read uses. They come from
// the flat (pre-parallax) projection: parallax makes uv jump at depth edges, and the
// hardware gradients there would pick a far too coarse mip.
float impostorTexels = 1.0;
vec2 impostorDx = vec2(0.0);
vec2 impostorDy = vec2(0.0);
// Half a texel of the mip being read, in frame uv: reads stay that far inside their
// frame so filtering never reaches the neighbouring frame.
float impostorInset = 0.0;

vec4 impostorTexture(sampler2D map, vec2 uv) {
  return textureGrad(map, uv, impostorDx, impostorDy);
}

// Atlas coordinate of frame-local uv; "inside" is 0 when uv left the frame.
vec2 impostorAtlas(vec2 frame, vec2 uv, out float inside) {
  inside = step(0.0, uv.x) * step(0.0, uv.y) * step(uv.x, 1.0) * step(uv.y, 1.0);
  return (frame + clamp(uv, impostorInset, 1.0 - impostorInset)) / impostorFrames;
}

// Where the view ray meets frame (col, row)'s plane: uv there, the uv shift per unit of
// height above the plane, the distance along the ray to the plane and the ray's slope.
void impostorFrame(vec2 frame, out vec2 uv, out vec2 slope, out float t, out float along) {
  vec3 n = impostorDecode(frame / (impostorFrames - 1.0));
  vec3 tangent;
  vec3 bitangent;
  impostorBasis(n, tangent, bitangent);
  vec3 ray = normalize(vImpostorRay);
  along = min(dot(ray, n), -1e-3);
  t = dot(impostorCentre - vImpostorPoint, n) / along;
  vec3 hit = vImpostorPoint + ray * t - impostorCentre;
  uv = vec2(dot(hit, tangent), dot(hit, bitangent)) / (2.0 * impostorHalfSize) + 0.5;
  slope = vec2(dot(ray, tangent), dot(ray, bitangent)) / along / (2.0 * impostorHalfSize);
}

// Frame-local uv where the view ray meets the baked surface of frame (col, row), and
// "run", the distance along the ray to that surface. "trust" falls toward 0 when the
// depth walk did not settle: the frame's surface there is not on this ray (the frame
// sees something the view does not), and blending it in would ghost.
vec2 impostorFrameUv(vec2 frame, out float trust, out float run) {
  vec2 uv;
  vec2 slope;
  float t;
  float along;
  impostorFrame(frame, uv, slope, t, along);
  trust = 1.0;
  float inside;
  float depth = impostorTexture(impostorNormalDepth, impostorAtlas(frame, uv, inside)).a;
  #ifdef IMPOSTOR_PARALLAX
    vec2 start = uv;
    float previous;
    for (int i = 0; i < IMPOSTOR_PARALLAX; i++) {
      previous = depth;
      uv = start + slope * (depth - 0.5) * 2.0 * impostorRadius;
      depth = impostorTexture(impostorNormalDepth, impostorAtlas(frame, uv, inside)).a;
    }
    float miss = abs(depth - previous) / IMPOSTOR_TOLERANCE;
    trust = 1.0 / (1.0 + miss * miss);
  #endif
  // Height above the frame plane, walked back along the ray.
  run = t + (depth - 0.5) * 2.0 * impostorRadius / along;
  return uv;
}

// The three frames' values of an atlas map, weighted by the blend.
vec4 impostorBlend(sampler2D map, vec2 a0, vec2 a1, vec2 a2, vec3 w) {
  return impostorTexture(map, a0) * w.x + impostorTexture(map, a1) * w.y + impostorTexture(map, a2) * w.z;
}
`;

// Replaces <map_fragment>: the three-frame blend. Every layer is weighted by
// barycentric weight x trust x that frame's coverage, so a frame that does not cover
// this pixel cannot bleed its colour, normal or depth into it.
const MAP_FRAGMENT = /* glsl */ `
  {
    vec2 uv;
    vec2 slope;
    float t;
    float along;
    impostorFrame(vImpostorFrame0, uv, slope, t, along);
    float cell = impostorSize / impostorFrames;
    vec2 dx = dFdx(uv);
    vec2 dy = dFdy(uv);
    impostorTexels = max(length(dx), length(dy)) * cell;
    impostorDx = dx / impostorFrames * exp2(IMPOSTOR_MIP_BIAS);
    impostorDy = dy / impostorFrames * exp2(IMPOSTOR_MIP_BIAS);
    impostorInset = 0.5 * exp2(ceil(log2(max(impostorTexels * exp2(IMPOSTOR_MIP_BIAS), 1.0)))) / cell;
  }
  vec3 impostorTrust;
  vec3 impostorRun;
  vec2 impostorUv0 = impostorFrameUv(vImpostorFrame0, impostorTrust.x, impostorRun.x);
  vec2 impostorUv1 = impostorFrameUv(vImpostorFrame1, impostorTrust.y, impostorRun.y);
  vec2 impostorUv2 = impostorFrameUv(vImpostorFrame2, impostorTrust.z, impostorRun.z);
  vec3 impostorIn;
  vec2 impostorA0 = impostorAtlas(vImpostorFrame0, impostorUv0, impostorIn.x);
  vec2 impostorA1 = impostorAtlas(vImpostorFrame1, impostorUv1, impostorIn.y);
  vec2 impostorA2 = impostorAtlas(vImpostorFrame2, impostorUv2, impostorIn.z);
  vec4 impostorC0 = impostorTexture(impostorBase, impostorA0);
  vec4 impostorC1 = impostorTexture(impostorBase, impostorA1);
  vec4 impostorC2 = impostorTexture(impostorBase, impostorA2);
  vec3 impostorW = vImpostorWeights * impostorTrust;
  impostorW *= impostorIn * vec3(impostorC0.a, impostorC1.a, impostorC2.a) / max(impostorW.x + impostorW.y + impostorW.z, 1e-4);
  float impostorCover = impostorW.x + impostorW.y + impostorW.z;
  impostorW /= max(impostorCover, 1e-4);
  diffuseColor *= vec4(impostorC0.rgb * impostorW.x + impostorC1.rgb * impostorW.y + impostorC2.rgb * impostorW.z, impostorCover);

  // The resolved surface's distance along the ray, for depth and shadows.
  float impostorS = dot(impostorRun, impostorW) / length(vImpostorRay);
  #ifdef IMPOSTOR_PIXEL_DEPTH
    // The depth three would give the surface: its window depth (z/w with a reversed
    // buffer's [0, 1] clip range) or, with a logarithmic buffer, logdepthbuf_fragment's.
    vec4 impostorClip = projectionMatrix * vec4(vImpostorViewPoint + vImpostorViewRay * impostorS, 1.0);
    #ifdef USE_REVERSED_DEPTH_BUFFER
      gl_FragDepth = impostorClip.z / impostorClip.w;
    #else
      gl_FragDepth = 0.5 * impostorClip.z / impostorClip.w + 0.5;
    #endif
    // The distance material of point-light shadows has no logarithmic depth.
    #if defined( USE_LOGARITHMIC_DEPTH_BUFFER ) && !defined( DISTANCE )
      if (isPerspectiveMatrix(projectionMatrix)) gl_FragDepth = log2(1.0 + impostorClip.w) * logDepthBufFC * 0.5;
    #endif
  #endif
`;

// Replaces <alphatest_fragment>: baked coverage to screen coverage, then the fade.
// Magnified (a texel spans pixels), the edge is sharpened around the cutoff, centred on it,
// unlike three's ramp, which erodes the silhouette by half a pixel. Minified, a texel
// already holds a pixel's worth of supersampled coverage, so it is kept and dithered:
// both hardware alpha-to-coverage and a plain cutoff round fractional coverage away,
// erasing branches, wires and sparse foliage in the distance. Without multisampling,
// alpha-to-coverage does nothing, so the dithered cutoff takes over. Not three's alpha
// test either way: the shadow renderer overwrites a depth material's alphaTest.
const ALPHATEST_FRAGMENT = /* glsl */ `
  float impostorMinified = clamp(impostorTexels - 1.0, 0.0, 1.0);
  float impostorNoise = lodFadeDither(gl_FragCoord.xy + 17.0);
  #ifdef ALPHA_TO_COVERAGE
  if (impostorMultisample > 0.5) {
    float sharp = clamp((diffuseColor.a - IMPOSTOR_CUTOFF) / max(fwidth(diffuseColor.a), 1e-4) + 0.5, 0.0, 1.0);
    // Dither by one sample step (4x MSAA), faded out toward 0 and 1 so empty stays
    // empty and solid stays solid (no pinholes inside opaque surfaces). Hardware
    // alpha-to-coverage rounds to a sample count, some GPUs down, some to nearest;
    // offsetting the noise by a quarter step keeps either within 1/8 sample, where
    // centred noise loses coverage.
    float dithered = clamp(diffuseColor.a + (impostorNoise - 0.25) * 0.25 * min(min(diffuseColor.a, 1.0 - diffuseColor.a) * 4.0, 1.0), 0.0, 1.0);
    diffuseColor.a = mix(sharp, dithered, impostorMinified);
    if (diffuseColor.a == 0.0) discard;
  } else
  #endif
  {
    if (diffuseColor.a < mix(IMPOSTOR_CUTOFF, impostorNoise, impostorMinified)) discard;
    diffuseColor.a = 1.0;
  }
  // The fade comes last, after every derivative above.
  ${FADE_DISCARD}
  ${FADE_TINT}
`;

// Before <roughnessmap_fragment>: the blended normal and ORM the lit edits below read.
// Here, after the alpha test, so discarded pixels skip the texture reads.
const LIT_INPUTS = /* glsl */ `
  vec3 impostorN =
    (impostorTexture(impostorNormalDepth, impostorA0).rgb * 2.0 - 1.0) * impostorW.x +
    (impostorTexture(impostorNormalDepth, impostorA1).rgb * 2.0 - 1.0) * impostorW.y +
    (impostorTexture(impostorNormalDepth, impostorA2).rgb * 2.0 - 1.0) * impostorW.z;
  vec4 impostorOrmValue = impostorBlend(impostorOrm, impostorA0, impostorA1, impostorA2, impostorW);
`;

// Toksvig: the spread of the averaged normal widens the specular lobe, so distant
// foliage and bumpy rock stop sparkling.
const ROUGHNESS = /* glsl */ `
  #include <roughnessmap_fragment>
  roughnessFactor *= impostorOrmValue.g;
  {
    float len = clamp(length(impostorN), 1e-3, 1.0);
    roughnessFactor = sqrt(min(roughnessFactor * roughnessFactor + (1.0 - len) / len, 1.0));
  }
`;

// Replaces <normal_fragment_begin>.
const NORMAL = /* glsl */ `
  float faceDirection = 1.0;
  // orm.a is the share of the surface here whose front faced the camera: pick the side
  // with that probability, as the real two-sided surface shows it. The choice is fixed
  // per texel of the mip being read (of the strongest frame), so it sits on the object
  // like leaves do instead of crawling across the screen.
  vec2 impostorStrong = impostorW.x >= max(impostorW.y, impostorW.z) ? impostorA0 : impostorW.y >= impostorW.z ? impostorA1 : impostorA2;
  float impostorLevel = exp2(ceil(max(log2(max(impostorTexels, 1e-4)), 0.0)));
  vec2 impostorTexel = floor(impostorStrong * impostorSize / impostorLevel);
  float impostorRandom = fract(sin(dot(impostorTexel, vec2(12.9898, 78.233))) * 43758.5453);
  float impostorSide = impostorRandom < impostorOrmValue.a ? 1.0 : -1.0;
  vec3 normal = impostorSide * normalize(mat3(vImpostorNormalX, vImpostorNormalY, vImpostorNormalZ) * impostorN);
  // Averaged normals come out short where they disagree (mip levels, blended frames,
  // foliage). Renormalised, the average lights as one smooth surface facing the mean
  // direction: too bright for a canopy. Keeping the length as the spread lights
  // shorter normals toward their average irradiance (Toksvig, for diffuse).
  normal *= clamp(length(impostorN), 0.0, 1.0);
  vec3 nonPerturbedNormal = normal;
`;

const EMISSIVE = /* glsl */ `
  #include <emissivemap_fragment>
  #ifdef IMPOSTOR_EMISSIVE
    totalEmissiveRadiance *= impostorBlend(impostorEmissive, impostorA0, impostorA1, impostorA2, impostorW).rgb;
  #endif
`;

// After <aomap_fragment>: the baked occlusion, applied the way three applies an aoMap.
const AO = /* glsl */ `
  #include <aomap_fragment>
  reflectedLight.indirectDiffuse *= impostorOrmValue.r;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    reflectedLight.indirectSpecular *= computeSpecularOcclusion(saturate(dot(geometryNormal, geometryViewDir)), impostorOrmValue.r, material.roughness);
  #endif
`;

// three's lights_fragment_begin as it is when the material compiles, so changes to three's
// chunks made after this package loaded (cascaded shadows, custom shadow lookups) reach
// impostors too. The lit point, geometryPosition, is the resolved surface rather than the
// card, and so is every shadow lookup three makes from its varyings; a patched chunk that
// derives its own lookups from geometryPosition gets the surface without knowing about
// impostors. The shadow map holds the impostor as resolved from the light's frames, the
// receiver is resolved from the camera's; they disagree by about a texel and a depth step,
// so the point stops that much short of the surface (toward the camera) to not shade itself.
function lights(): string {
  const lit = replaceOrThrow(
    ShaderChunk.lights_fragment_begin,
    "vec3 geometryPosition = - vViewPosition;",
    /* glsl */ `float impostorShadowS = impostorS - (2.0 * impostorHalfSize / (impostorSize / impostorFrames) + 2.0 * impostorRadius / 255.0) / length(vImpostorRay);
vec3 geometryPosition = vImpostorViewPoint + vImpostorViewRay * impostorShadowS;`,
  );
  // Only where the chunk still reads three's varyings: a patch may have replaced them.
  const coords = [
    ["vDirectionalShadowCoord[ i ]", "vImpostorDirectionalRay[ i ]"],
    ["vPointShadowCoord[ i ]", "vImpostorPointRay[ i ]"],
    ["vSpotLightCoord[ i ]", "vImpostorSpotRay[ i ]"],
  ] as const;
  return coords.reduce((chunk, [coord, ray]) => chunk.split(coord).join(`( ${coord} + ${ray} * impostorShadowS )`), lit);
}

/** The resolved surface in every pass: blend, coverage, fade and (if asked) its depth. */
export const FRAGMENT: Edit[] = [
  ["fragment", "#include <common>", `#include <common>\n${FRAGMENT_PARS}`],
  ["fragment", "#include <map_fragment>", MAP_FRAGMENT],
  ["fragment", "#include <alphatest_fragment>", ALPHATEST_FRAGMENT],
];

/** Main pass only: the baked normal, ORM and emission feed three's lighting. Built when a material compiles (see `lights`). */
export const fragmentLit = (): Edit[] => [
  ["fragment", "#include <common>", `#include <common>\n${SHADOW_RAY_PARS}`],
  ["fragment", "#include <roughnessmap_fragment>", LIT_INPUTS + ROUGHNESS],
  ["fragment", "#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\n  metalnessFactor *= impostorOrmValue.b;"],
  ["fragment", "#include <normal_fragment_begin>", NORMAL],
  ["fragment", "#include <emissivemap_fragment>", EMISSIVE],
  ["fragment", "#include <aomap_fragment>", AO],
  ["fragment", "#include <lights_fragment_begin>", lights()],
];
