import * as THREE from "three/webgpu";
import { InstancedLod, LazyImpostor, Lod } from "@drawcall/lod";

function updates(object: THREE.Object3D): object is THREE.Object3D & { autoUpdate: boolean; update(camera: THREE.Camera): void } {
  return (
    "isLOD" in object &&
    object.isLOD === true &&
    "autoUpdate" in object &&
    typeof object.autoUpdate === "boolean" &&
    "update" in object &&
    typeof object.update === "function"
  );
}

/** Resolve only impostors requested by the first view, before compiling its draws. */
export async function prefetch(scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
  const lods: (Lod | InstancedLod)[] = [];
  scene.traverse((object) => {
    if (object instanceof Lod || object instanceof InstancedLod) lods.push(object);
  });
  for (;;) {
    // Match the renderer's parent-first updates: Corn/Patches fill their slots
    // before the child InstancedLods decide which atlases this view needs.
    scene.traverseVisible((object) => {
      if (updates(object) && object.autoUpdate) object.update(camera);
    });
    const pending = new Set<LazyImpostor>();
    for (const lod of lods) {
      for (const { object } of lod.levels)
        object.traverse((node) => {
          if (node instanceof LazyImpostor && node.status === "loading") pending.add(node);
        });
    }
    if (pending.size === 0) return;
    await Promise.all([...pending].map((level) => level.load()));
  }
}

/** Load a requested family's bounded lazy tiers without changing live selection. */
export async function loadLevels(root: THREE.Object3D): Promise<void> {
  const pending = new Set<LazyImpostor>();
  const seen = new Set<THREE.Object3D>();
  const visit = (object: THREE.Object3D): void => {
    if (seen.has(object)) return;
    seen.add(object);
    if (object instanceof LazyImpostor) pending.add(object);
    if (object instanceof Lod || object instanceof InstancedLod) {
      for (const level of object.levels) visit(level.object);
    } else {
      for (const child of object.children) visit(child);
    }
  };
  visit(root);
  await Promise.all([...pending].map((level) => level.load()));
}
