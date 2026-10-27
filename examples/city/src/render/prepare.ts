import * as THREE from "three/webgpu";

import type { Pipeline } from "./pipeline.ts";

function updates(object: THREE.Object3D): object is THREE.Object3D & { autoUpdate: boolean } {
  return "isLOD" in object && object.isLOD === true && "autoUpdate" in object && typeof object.autoUpdate === "boolean";
}

/**
 * Prepare the city's main and shadow materials before its first frame, while the
 * canvas is hidden. LOD selection and patch streaming stay stopped. Each batch
 * goes through the real render passes with empty draws, keeping the same mesh,
 * material and indirect-draw specialization that later frames use.
 *
 * Scene transforms must already be current. The Sun has not been fitted yet, so
 * its zero texel sizes include every registered caster. After restoration, draw
 * one normal frame and await pipeline.wait() before revealing the canvas.
 */
export async function prepare(
  scene: THREE.Scene,
  pipeline: Pipeline,
  shadows: readonly THREE.LightShadow[],
  progress: (done: number, total: number) => void,
): Promise<void> {
  const meshes: THREE.Mesh[] = [];
  const objects: Array<{ object: THREE.Object3D; visible: boolean; frustumCulled: boolean; castShadow: boolean; autoUpdate: boolean | null }> = [];
  const geometries = new Map<
    THREE.BufferGeometry,
    { indirect: THREE.IndirectStorageBufferAttribute | null; offset: number | number[]; start: number; count: number }
  >();
  scene.traverse((object) => {
    objects.push({
      object,
      visible: object.visible,
      frustumCulled: object.frustumCulled,
      castShadow: object.castShadow,
      autoUpdate: updates(object) ? object.autoUpdate : null,
    });
    if (!(object instanceof THREE.Mesh)) return;
    meshes.push(object);
    const geometry = object.geometry;
    if (!geometries.has(geometry))
      geometries.set(geometry, {
        indirect: geometry.getIndirect(),
        offset: geometry.indirectOffset,
        start: geometry.drawRange.start,
        count: geometry.drawRange.count,
      });
  });
  // Keep one existing receiver in each batch so the real Sun renders its maps.
  const receiver = meshes.find(
    (mesh) =>
      mesh.receiveShadow &&
      [mesh.material].flat().some((material) => material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshStandardNodeMaterial),
  );
  if (!receiver) throw new Error("City preparation needs a lit shadow receiver");
  // A non-null indirect attribute preserves single-instance impostor specialization.
  const empty = new THREE.IndirectStorageBufferAttribute(new Uint32Array(5), 1);
  try {
    for (const { object } of objects) {
      object.visible = !(object instanceof THREE.Mesh);
      object.frustumCulled = false;
      if (updates(object)) object.autoUpdate = false;
    }
    for (const [geometry, before] of geometries) {
      geometry.setDrawRange(0, 0);
      if (before.indirect) geometry.setIndirect(empty, 0);
    }
    for (let offset = 0; offset < meshes.length; offset += 32) {
      const end = Math.min(offset + 32, meshes.length);
      const shown = new Set<THREE.Object3D>();
      for (const mesh of [receiver, ...meshes.slice(offset, end)]) {
        for (let object: THREE.Object3D | null = mesh; object; object = object.parent) {
          if (!object.visible) {
            object.visible = true;
            shown.add(object);
          }
        }
      }
      for (const shadow of shadows) shadow.needsUpdate = true;
      await new Promise<void>((resolve, reject) =>
        pipeline.renderer.setAnimationLoop(() => {
          pipeline.renderer.setAnimationLoop(null);
          try {
            pipeline.render();
            resolve();
          } catch (error) {
            reject(error);
          }
        }),
      );
      await pipeline.wait();
      for (const object of shown) object.visible = false;
      progress(end, meshes.length);
    }
  } finally {
    pipeline.renderer.setAnimationLoop(null);
    for (const [geometry, before] of geometries) {
      geometry.setIndirect(before.indirect, before.offset);
      geometry.setDrawRange(before.start, before.count);
    }
    for (const { object, visible, frustumCulled, castShadow, autoUpdate } of objects) {
      object.visible = visible;
      object.frustumCulled = frustumCulled;
      object.castShadow = castShadow;
      if (autoUpdate !== null && updates(object)) object.autoUpdate = autoUpdate;
    }
    for (const shadow of shadows) shadow.needsUpdate = true;
    empty.dispose();
  }
}
