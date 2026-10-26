import { Material, MeshDepthMaterial, MeshDistanceMaterial, RGBADepthPacking, type Mesh } from "three";
import { inheritFade, originalOf } from "../fade.js";
import { isImpostorMesh } from "../three.js";
import { windVertex } from "./shader.js";

const originals = new WeakMap<Material, Material>();

/** Remove our patch before reapplying it to a clone with its own placement. */
export const withoutWind = (material: Material): Material => originals.get(material) ?? material;

function patch<T extends Material>(material: T, uniforms: object, impostor: boolean, placed: boolean): T {
  if (placed) material.defines = { ...material.defines, WIND_PLACED: "" };
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  const key = previousKey === Material.prototype.customProgramCacheKey ? previous.toString() : previousKey.call(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = windVertex(shader.vertexShader, impostor);
  };
  material.customProgramCacheKey = () => `${key}|wind|${placed}`;
  material.needsUpdate = true;
  return material;
}

function copy(material: Material): Material {
  const original = withoutWind(material);
  const clone = original.clone();
  clone.onBeforeCompile = original.onBeforeCompile;
  clone.customProgramCacheKey = original.customProgramCacheKey;
  originals.set(clone, original);
  inheritFade(original, clone);
  // A Lod owns the faded proxy we replaced; it may already hold a compiled program.
  // Its shared source material still follows the Lod's normal disposal policy.
  if (originalOf(original) !== original) clone.addEventListener("dispose", () => original.dispose());
  return clone;
}

/** Impostors own their materials; ordinary meshes receive private patched copies. */
export function windMaterials(mesh: Mesh, uniforms: object, placed: boolean): void {
  if (isImpostorMesh(mesh)) {
    patch(mesh.material, uniforms, true, placed);
    if (mesh.customDepthMaterial) patch(mesh.customDepthMaterial, uniforms, true, placed);
    if (mesh.customDistanceMaterial) patch(mesh.customDistanceMaterial, uniforms, true, placed);
    return;
  }
  const material = (original: Material) => patch(copy(original), uniforms, false, placed);
  mesh.material = Array.isArray(mesh.material) ? mesh.material.map(material) : material(mesh.material);
  const depth = mesh.customDepthMaterial ? copy(mesh.customDepthMaterial) : new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  const distance = mesh.customDistanceMaterial ? copy(mesh.customDistanceMaterial) : new MeshDistanceMaterial();
  mesh.customDepthMaterial = patch(depth, uniforms, false, placed);
  mesh.customDistanceMaterial = patch(distance, uniforms, false, placed);
  // These private shadow materials have the same lifetime as the visible copies.
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    depth.dispose();
    distance.dispose();
  };
  for (const each of [mesh.material].flat()) each.addEventListener("dispose", dispose);
}
