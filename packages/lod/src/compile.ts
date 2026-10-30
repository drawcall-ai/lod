import type { Mesh, Node, Object3D, Texture } from "three/webgpu";
import { gpuQueue, isMesh, isNode, isTexture } from "./three.js";
import type { RenderContext } from "./view.js";
import { pause } from "./pause.js";

/** Prepare the same target and MRT as the viewing draw, even if normal rendering has since restored the canvas. */
export async function compileLevel(object: Object3D, context: RenderContext): Promise<void> {
  // Throttle new uploads behind submitted work instead of blocking inside writeTexture.
  const queue = gpuQueue(context.renderer);
  for (const texture of textures(object)) {
    await queue.onSubmittedWorkDone();
    context.renderer.initTexture(texture);
    await pause();
  }
  const meshes: Mesh[] = [];
  const collect = (node: Object3D) => {
    if (isMesh(node)) meshes.push(node);
  };
  object.traverse(collect);
  for (const mesh of meshes) {
    const groups = mesh.geometry.groups;
    if (!Array.isArray(mesh.material)) {
      await queue.onSubmittedWorkDone();
      await compileMesh(mesh, context);
      continue;
    }
    for (const group of groups) {
      await queue.onSubmittedWorkDone();
      let pending: Promise<void>;
      try {
        mesh.geometry.groups = [group];
        pending = compileMesh(mesh, context);
      } finally {
        mesh.geometry.groups = groups;
      }
      await pending;
    }
  }
}

function compileMesh(mesh: Mesh, context: RenderContext): Promise<void> {
  const { renderer, camera, scene } = context;
  const target = renderer.getRenderTarget();
  const mrt = renderer.getMRT();
  const cubeFace = renderer.getActiveCubeFace();
  const mipLevel = renderer.getActiveMipmapLevel();
  const culled = mesh.frustumCulled;
  const visible = mesh.visible;
  const children = mesh.children;
  const background = scene.background;
  const backgroundNode = scene.backgroundNode;
  try {
    renderer.setRenderTarget(context.target, context.cubeFace, context.mipLevel);
    renderer.setMRT(context.mrt);
    // Demanded levels can still be hidden or outside the last view.
    mesh.frustumCulled = false;
    mesh.visible = true;
    mesh.children = [];
    // r185 compiles backgrounds first, which would postpone this mesh until after renderer state is restored.
    scene.background = null;
    scene.backgroundNode = null;
    // r185 starts only the first material before yielding; isolate one draw so setup sees its captured target/MRT.
    return renderer.compileAsync(mesh, camera, scene);
  } finally {
    scene.background = background;
    scene.backgroundNode = backgroundNode;
    mesh.children = children;
    mesh.frustumCulled = culled;
    mesh.visible = visible;
    renderer.setRenderTarget(target, cubeFace, mipLevel);
    renderer.setMRT(mrt);
  }
}

function textures(object: Object3D): Set<Texture> {
  const found = new Set<Texture>();
  const visited = new Set<Node>();
  const visit = (node: Node) => {
    if (visited.has(node)) return;
    visited.add(node);
    const value: unknown = Reflect.get(node, "value");
    if (isTexture(value)) found.add(value);
    for (const child of node.getChildren()) visit(child);
  };
  object.traverse((node) => {
    if (!isMesh(node)) return;
    for (const material of [node.material].flat()) {
      for (const value of Object.values(material)) {
        if (isTexture(value)) found.add(value);
        else if (isNode(value)) visit(value);
      }
    }
  });
  return found;
}
