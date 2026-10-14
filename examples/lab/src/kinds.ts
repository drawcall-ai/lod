import * as THREE from "three";
import { boxCentre, frameBasis, frameDirection, type Impostor } from "@drawcall/impostor";

// Lab-only prototypes of the other proxy kinds, built from views of an existing hemi
// bake so every kind shares the same baked pixels and lit, normal-mapped shading; only
// how many views they keep and how they show them differs.

/** The horizon frame of a hemi bake whose direction is closest to azimuth `degrees`. */
function horizonFrame(impostor: Impostor, degrees: number): [number, number] {
  const a = THREE.MathUtils.degToRad(degrees);
  const want = [Math.sin(a), 0, Math.cos(a)];
  let best: [number, number] = [0, 0];
  let bestDot = -2;
  for (let row = 0; row < impostor.frames; row++)
    for (let col = 0; col < impostor.frames; col++) {
      const d = frameDirection(impostor.layout, impostor.frames, col, row);
      if (Math.abs(d[1]) > 1e-3) continue;
      const dot = d[0] * want[0]! + d[2] * want[2]!;
      if (dot > bestDot) [best, bestDot] = [[col, row], dot];
    }
  return best;
}

/** One frame's layers as textures, and the plane that shows it (facing its direction). */
function framePlane(impostor: Impostor, col: number, row: number): THREE.Mesh {
  const cell = impostor.size / impostor.frames;
  const slice = (map: string, srgb: boolean) => {
    const layer = impostor.layers[impostor.maps.indexOf(map as never)]!;
    const data = new Uint8Array(cell * cell * 4);
    for (let y = 0; y < cell; y++)
      data.set(layer.subarray(((row * cell + y) * impostor.size + col * cell) * 4, ((row * cell + y) * impostor.size + (col + 1) * cell) * 4), y * cell * 4);
    const texture = new THREE.DataTexture(data, cell, cell, THREE.RGBAFormat);
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  };
  const orm = slice("orm", false);
  const material = new THREE.MeshStandardMaterial({
    map: slice("base", true),
    normalMap: slice("normalDepth", false),
    normalMapType: THREE.ObjectSpaceNormalMap,
    roughnessMap: orm,
    metalnessMap: orm,
    roughness: 1,
    metalness: 1,
    alphaTest: 0.5,
    alphaToCoverage: true,
  });
  // Same two-sided normal handling as ImpostorMesh: orm.a is the share of the surface
  // whose front faced the camera; pick the side per texel with that probability.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <normal_fragment_maps>",
      `#include <normal_fragment_maps>
      {
        float front = texture2D(metalnessMap, vMetalnessMapUv).a;
        float random = fract(sin(dot(floor(vMetalnessMapUv * ${cell}.0), vec2(12.9898, 78.233))) * 43758.5453);
        normal *= random < front ? 1.0 : -1.0;
      }`,
    );
  };
  const n = frameDirection(impostor.layout, impostor.frames, col, row);
  const { tangent: t, bitangent: b } = frameBasis(n);
  const c = boxCentre(impostor.box);
  const r = impostor.halfSize;
  // The orientation goes into the geometry: object-space normal maps are read in the
  // mesh's own space, which must stay the baked object's space.
  const geometry = new THREE.PlaneGeometry(2 * r, 2 * r);
  geometry.applyMatrix4(new THREE.Matrix4().set(t[0], b[0], n[0], c[0], t[1], b[1], n[1], c[1], t[2], b[2], n[2], c[2], 0, 0, 0, 1));
  return new THREE.Mesh(geometry, material);
}

/**
 * Cross-quads: `planes` vertical planes through the centre, evenly rotated; each side is
 * its own single-sided quad showing the horizon view it faces.
 */
export function crossQuads(impostor: Impostor, planes: number): THREE.Group {
  const group = new THREE.Group();
  for (let i = 0; i < planes * 2; i++) group.add(framePlane(impostor, ...horizonFrame(impostor, (i * 180) / planes)));
  return group;
}

/** Sprite: one view on a card that turns about the vertical axis to face the camera. */
export function sprite(impostor: Impostor): THREE.Group {
  const group = new THREE.Group();
  const pivot = new THREE.Group();
  const plane = framePlane(impostor, ...horizonFrame(impostor, 0));
  pivot.add(plane);
  group.add(pivot);
  const local = new THREE.Vector3();
  plane.onBeforeRender = (_r, _s, camera) => {
    local.setFromMatrixPosition(camera.matrixWorld);
    group.worldToLocal(local);
    const c = boxCentre(impostor.box);
    pivot.rotation.y = Math.atan2(local.x - c[0], local.z - c[2]);
    // Rotate about the bounding centre, then refresh the world matrices for this draw.
    pivot.position.set(c[0], 0, c[2]).sub(new THREE.Vector3(c[0], 0, c[2]).applyAxisAngle(new THREE.Vector3(0, 1, 0), pivot.rotation.y));
    pivot.updateMatrixWorld(true);
    plane.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, plane.matrixWorld);
    plane.normalMatrix.getNormalMatrix(plane.modelViewMatrix);
  };
  return group;
}

/** Vertex-shader rewrite that turns the octahedral impostor into a ring: frames on the horizon only. */
export const RING_ABLATION: [string, string] = [
  "vec2 grid = clamp(impostorEncode(impostorView) * last, vec2(0.0), vec2(last));",
  "vec2 grid = clamp(impostorEncode(normalize(vec3(impostorView.x, 0.0, impostorView.z))) * last, vec2(0.0), vec2(last));",
];
