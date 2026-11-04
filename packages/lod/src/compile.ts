import type { Material, Mesh, Node, Object3D, Texture } from "three/webgpu";
import { gpuQueue, isMesh, isNode, isTexture } from "./three.js";
import { shadowPassesOf, type RenderContext } from "./view.js";

/**
 * Prepare the same target and MRT as the viewing draw, even if normal rendering has since restored the canvas, and the
 * shadow maps the scene's level meshes draw into, for each mesh that casts. r185 uploads a texture or a draw's geometry
 * synchronously inside initTexture or compileAsync, and creates a pipeline it meets while rendering synchronously, so
 * each draw is prepared here, after submitted work and in a frame of its own: one upload or pipeline per frame, however
 * large the level. Callers run one level at a time (see queue.ts).
 */
export async function compileLevel(object: Object3D, context: RenderContext): Promise<void> {
  const queue = gpuQueue(context.renderer);
  const step = async () => {
    await queue.onSubmittedWorkDone();
    await frame();
  };
  for (const texture of textures(object)) {
    await step();
    context.renderer.initTexture(texture);
  }
  const meshes: Mesh[] = [];
  object.traverse((node) => {
    if (isMesh(node)) meshes.push(node);
  });
  const shadows = shadowPassesOf(context.scene).filter((pass) => pass.renderer === context.renderer);
  for (const mesh of meshes) {
    const passes: Pass[] = [{ context, material: null }];
    if (mesh.castShadow)
      for (const { camera, target, material } of shadows)
        passes.push({ context: { ...context, camera, target, mrt: null, cubeFace: 0, mipLevel: 0 }, material });
    const groups = mesh.geometry.groups;
    // r185 starts only the first material before yielding; isolate one draw so setup sees its captured target/MRT.
    const draws = Array.isArray(mesh.material) ? groups.map((group) => [group]) : [groups];
    for (const pass of passes)
      for (const draw of draws) {
        await step();
        let pending: Promise<void>;
        try {
          mesh.geometry.groups = draw;
          pending = compileMesh(mesh, pass);
        } finally {
          mesh.geometry.groups = groups;
        }
        await pending;
      }
  }
}

/** A pass a level's draws are prepared for: the viewing draw, or a shadow map with the material three overrides with. */
interface Pass {
  context: RenderContext;
  material: Material | null;
}

/** What r185's renderObject gives an override material for one draw, and puts back once it has handed the draw on. */
const DRAW_STATE = ["colorNode", "depthNode", "positionNode", "side", "displacementMap", "displacementScale", "displacementBias"];

/**
 * A copy of the shadow pass's override material for compiling one draw. r185's compileAsync builds the draw only after
 * renderObject has put back the per-draw state it gave the override (the caster's shadow nodes and side), so with the
 * shared material it would prepare a pipeline the shadow pass never draws with. The copy keeps the state of the draw.
 * It is not disposed: that would release the pipeline before the shadow pass draws with it.
 */
function keepingDrawState(material: Material): Material {
  // clone() skips the flag three marks its shadow material with.
  const copy = Object.assign(material.clone(), { isShadowPassMaterial: true });
  for (const key of DRAW_STATE) {
    let value: unknown = Reflect.get(copy, key);
    let given = false;
    Object.defineProperty(copy, key, {
      get: () => value,
      set: (next: unknown) => {
        if (given) return;
        given = true;
        value = next;
      },
    });
  }
  return copy;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function compileMesh(mesh: Mesh, { context, material }: Pass): Promise<void> {
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
  const override = scene.overrideMaterial;
  try {
    renderer.setRenderTarget(context.target, context.cubeFace, context.mipLevel);
    renderer.setMRT(context.mrt);
    scene.overrideMaterial = material && keepingDrawState(material);
    // Demanded levels can still be hidden or outside the last view.
    mesh.frustumCulled = false;
    mesh.visible = true;
    mesh.children = [];
    // r185 compiles backgrounds first, which would postpone this mesh until after renderer state is restored.
    scene.background = null;
    scene.backgroundNode = null;
    return renderer.compileAsync(mesh, camera, scene);
  } finally {
    scene.background = background;
    scene.backgroundNode = backgroundNode;
    scene.overrideMaterial = override;
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
