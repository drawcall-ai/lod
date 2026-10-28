import * as THREE from "three/webgpu";
import { interleaveAttributes, mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { register } from "../../../render/sun/casters.ts";
import type { Surface } from "../../materials.ts";
import { ceiling, floorboards, plaster, wood } from "../furnishings.ts";
import { concrete, paint, plinth, wall } from "../materials.ts";
import type { HouseParams } from "../params.ts";
import type { HouseAtlas } from "./material.ts";

interface Part {
  mesh: THREE.Mesh;
  material: Surface;
}

function parts(source: THREE.Group, params: HouseParams): [Part[], Part[]] {
  // These surfaces meet on coincident faces. Keep their original mesh identities,
  // bounds and relative render order instead of changing which face wins depth ties.
  const separate = new Set([wall(params), concrete(), plinth()]);
  // Shutter slats and glossy furnishings also need their original draws to retain
  // the coverage of thin edges under multisampling.
  if (params.shutters) separate.add(paint(params.shutters));
  const indoors = new Set([plaster(), ceiling(), floorboards(), wood()]);
  const inside: Part[] = [];
  const outside: Part[] = [];
  source.traverse((mesh) => {
    if (!(mesh instanceof THREE.Mesh) || Array.isArray(mesh.material)) return;
    const material = mesh.material;
    if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshStandardNodeMaterial)) return;
    if (indoors.has(material)) inside.push({ mesh, material });
    else if (mesh.castShadow && !material.transparent && !separate.has(material)) outside.push({ mesh, material });
  });
  return [inside, outside];
}

/** Only the materials actually merged, so excluded wall textures need no atlas copy. */
export function surfaces(source: THREE.Group, params: HouseParams): Surface[] {
  return [
    ...new Set(
      parts(source, params)
        .filter((group) => group.length > 1)
        .flatMap((group) => group.map((part) => part.material)),
    ),
  ];
}

/** Consumes the replaced source geometries, after both distant levels have been baked. */
export function batch(source: THREE.Group, params: HouseParams, atlas: HouseAtlas): THREE.Group {
  source.updateMatrixWorld(true);
  const made: { parts: Part[]; mesh: THREE.Mesh; parent: THREE.Object3D }[] = [];
  try {
    for (const group of parts(source, params)) {
      if (group.length < 2) continue;
      const first = group[0];
      if (!first?.mesh.parent) throw new Error("House atlas parts need a parent");
      const parent = first.mesh.parent;
      const identity = new THREE.Matrix4();
      for (const { mesh, material } of group) {
        if (
          mesh.parent !== parent ||
          !mesh.matrixWorld.equals(identity) ||
          mesh.castShadow !== first.mesh.castShadow ||
          mesh.receiveShadow !== first.mesh.receiveShadow ||
          mesh.visible !== first.mesh.visible ||
          mesh.layers.mask !== first.mesh.layers.mask ||
          mesh.renderOrder !== first.mesh.renderOrder ||
          mesh.frustumCulled !== first.mesh.frustumCulled ||
          material.side !== THREE.FrontSide ||
          material.depthWrite !== true ||
          material.depthTest !== true
        ) {
          throw new Error("House atlas requires matching static, opaque parts with identity placements");
        }
      }
      const geometry = combine(group, atlas, first.mesh.castShadow);
      let material: THREE.MeshStandardNodeMaterial;
      try {
        material = first.mesh.castShadow
          ? register(
              geometry,
              atlas.outside,
              group.map(({ mesh }) => diameter(mesh.geometry)),
            )
          : atlas.inside;
      } catch (error) {
        geometry.dispose();
        throw error;
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = first.mesh.castShadow ? "house exterior atlas" : "house interior atlas";
      mesh.castShadow = first.mesh.castShadow;
      mesh.receiveShadow = first.mesh.receiveShadow;
      mesh.visible = first.mesh.visible;
      mesh.layers.mask = first.mesh.layers.mask;
      mesh.renderOrder = first.mesh.renderOrder;
      mesh.frustumCulled = first.mesh.frustumCulled;
      made.push({ parts: group, mesh, parent });
    }
  } catch (error) {
    for (const { mesh } of made) {
      mesh.geometry.dispose();
      if (mesh.material !== atlas.inside && !Array.isArray(mesh.material)) mesh.material.dispose();
    }
    throw error;
  }
  const consumed = new Set<THREE.BufferGeometry>();
  for (const { parts, mesh, parent } of made) {
    const index = parent.children.findIndex((child) => parts.some((part) => part.mesh === child));
    for (const part of parts) {
      parent.remove(part.mesh);
      consumed.add(part.mesh.geometry);
    }
    parent.add(mesh);
    parent.children.pop();
    parent.children.splice(index, 0, mesh);
  }
  source.traverse((mesh) => {
    if (mesh instanceof THREE.Mesh) consumed.delete(mesh.geometry);
  });
  for (const geometry of consumed) geometry.dispose();
  return source;
}

function diameter(geometry: THREE.BufferGeometry): number {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  if (!geometry.boundingSphere) throw new Error("House part has no bounding sphere");
  return geometry.boundingSphere.radius * 2;
}

function combine(parts: Part[], atlas: HouseAtlas, shadows: boolean): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  try {
    parts.forEach(({ mesh, material }, part) => {
      const source: THREE.BufferGeometry = mesh.geometry;
      if (!source.index || source.drawRange.start !== 0 || source.drawRange.count < source.index.count || source.groups.length)
        throw new Error("House atlas requires whole indexed geometries");
      const geometry = new THREE.BufferGeometry();
      pieces.push(geometry);
      for (const name of Object.keys(source.attributes)) {
        if (!["position", "normal", "uv", "color"].includes(name)) throw new Error(`Unexpected house attribute: ${name}`);
      }
      for (const name of ["position", "normal", "uv"]) {
        const attribute = source.getAttribute(name);
        if (!(attribute instanceof THREE.BufferAttribute) || !(attribute.array instanceof Float32Array) || attribute.normalized)
          throw new Error(`House atlas requires plain float ${name} attributes`);
        geometry.setAttribute(name, attribute);
      }
      const count = geometry.getAttribute("position").count;
      const color = source.getAttribute("color");
      if (material.vertexColors) {
        if (!(color instanceof THREE.BufferAttribute) || !(color.array instanceof Float32Array) || color.itemSize !== 3 || color.normalized)
          throw new Error("House atlas requires plain RGB vertex colors");
        geometry.setAttribute("color", color);
      } else geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
      geometry.setAttribute("houseMaterial", new THREE.Float32BufferAttribute(new Float32Array(count).fill(atlas.id(material)), 1));
      if (shadows) geometry.setAttribute("cityShadowPart", new THREE.Float32BufferAttribute(new Float32Array(count).fill(part), 1));
      geometry.setIndex(source.index);
    });
    const merged = mergeGeometries(pieces);
    if (!merged) throw new Error("House atlas geometries do not merge");
    try {
      const entries = Object.entries(merged.attributes);
      const attributes = entries.map(([, attribute]) => {
        if (!(attribute instanceof THREE.BufferAttribute)) throw new Error("House atlas cannot pack interleaved input");
        return attribute;
      });
      const packed = interleaveAttributes(attributes);
      if (!Array.isArray(packed) || packed.length !== entries.length) throw new Error("House atlas attributes do not interleave");
      entries.forEach(([name], index) => {
        const attribute = packed[index];
        if (!(attribute instanceof THREE.InterleavedBufferAttribute)) throw new Error("Invalid packed house attribute");
        merged.setAttribute(name, attribute);
      });
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      return merged;
    } catch (error) {
      merged.dispose();
      throw error;
    }
  } finally {
    for (const geometry of pieces) geometry.dispose();
  }
}
