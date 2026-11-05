import type { Material, Mesh, Node, Object3D, Texture } from "three/webgpu";
import { idOf } from "./id.js";
import { atDepth, isCompressedTexture, isMesh, isNode, isTexture } from "./three.js";
import { shadowPassesOf, type RenderContext } from "./view.js";

/**
 * Prepare the same target and MRT as the viewing draw, even if normal rendering has since restored the canvas, and the
 * shadow maps the scene's level meshes draw into, for each mesh that casts. r186 uploads a texture synchronously inside
 * initTexture, and creates a pipeline it meets while rendering synchronously, so each texture and draw is prepared
 * here first. Textures upload paced across frames (see `paced`); every draw then compiles at once, as do the draws of
 * every other level being prepared, so their pipelines are created side by side.
 */
export async function compileLevel(object: Object3D, context: RenderContext): Promise<void> {
  const { renderer } = context;
  const { memory } = renderer.info;
  for (const texture of textures(object))
    await paced(() => {
      const known = memory.textures;
      const before = memory.total;
      renderer.initTexture(texture);
      if (memory.textures === known) return 0;
      // three counts a compressed texture as one byte.
      return isCompressedTexture(texture) ? sum(texture.mipmaps.map(({ data }) => data.byteLength)) : memory.total - before;
    });
  const meshes: Mesh[] = [];
  object.traverse((node) => {
    if (isMesh(node)) meshes.push(node);
  });
  const shadows = shadowPassesOf(context.scene).filter((pass) => pass.renderer === context.renderer);
  const draws: Promise<void>[] = [];
  for (const mesh of meshes) {
    const passes: Pass[] = [{ context, material: null }];
    if (mesh.castShadow)
      for (const { camera, target, material, depth } of shadows)
        passes.push({ context: { ...context, camera, target, mrt: null, cubeFace: 0, mipLevel: 0, depth }, material });
    // r186 starts only the first material before yielding; isolate one draw so setup sees its captured target/MRT.
    const parts = Array.isArray(mesh.material) ? mesh.geometry.groups.map((group) => [group]) : [mesh.geometry.groups];
    for (const pass of passes) for (const part of parts) draws.push(compileDraw(mesh, pass, part));
  }
  await Promise.all(draws);
}

/**
 * What texture uploads may add in one frame, in bytes: a 2048² RGBA texture. Uploads run on the GPU's queue before the
 * frame that follows them, which waits for them all. A draw's geometry is not paced: its buffers copy in far less
 * time than a texture of the same size and its mipmaps.
 */
const FRAME_UPLOAD = 16 * 2 ** 20;
/** Uploaded since the last frame. */
let uploaded = 0;
/** The last upload: every level's uploads run in turn, sharing one budget per frame. */
let uploads = Promise.resolve();

/** Run `upload`, which answers the bytes it uploaded, after the next frame if those since the last one reached `FRAME_UPLOAD`. */
function paced(upload: () => number): Promise<void> {
  const run = uploads.then(async () => {
    if (uploaded >= FRAME_UPLOAD) await frame();
    const bytes = Math.max(upload(), 0);
    // The next frame empties the budget, whether or not an upload waits for it.
    if (bytes > 0 && uploaded === 0) void frame().then(() => void (uploaded = 0));
    uploaded += bytes;
  });
  uploads = run.catch(() => {});
  return run;
}

/**
 * Draws being compiled. A draw whose pipeline another of them already started creating finds it in three's cache and
 * resolves at once, though three skips it until the pipeline is ready: a draw is done once those started before it are.
 */
const compiling = new Set<Promise<void>>();
/**
 * The last draw compiled for each shader build: material, attributes, target, pass and nesting. three starts a build for each
 * draw that misses its cache, even one another draw is building, so a draw that builds alike waits for the last one
 * and finds its build cached.
 */
const builds = new Map<string, Promise<void>>();

/** Compile the draw of `mesh`'s groups `part` in `pass`. */
async function compileDraw(mesh: Mesh, pass: Pass, part: Group[]): Promise<void> {
  const material = Array.isArray(mesh.material) ? mesh.material[part[0]?.materialIndex ?? 0] : mesh.material;
  const key = [
    material ? idOf(material) : "none",
    Object.keys(mesh.geometry.attributes).sort().join(),
    idOf(pass.context.renderer),
    pass.context.target ? idOf(pass.context.target) : "canvas",
    pass.material ? idOf(pass.material) : "view",
    pass.context.depth,
  ].join(" ");
  const start = () => {
    const groups = mesh.geometry.groups;
    try {
      mesh.geometry.groups = part;
      return compileMesh(mesh, pass);
    } finally {
      mesh.geometry.groups = groups;
    }
  };
  const alike = builds.get(key);
  const earlier = [...compiling];
  const own = alike ? alike.then(start) : start();
  const settled = own.then(
    () => {},
    () => {},
  );
  builds.set(key, settled);
  compiling.add(own);
  void settled.then(() => {
    compiling.delete(own);
    if (builds.get(key) === settled) builds.delete(key);
  });
  await own;
  await Promise.allSettled(earlier);
}

/** A draw's range of a geometry, as three's groups hold it. */
type Group = Mesh["geometry"]["groups"][number];

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** A pass a level's draws are prepared for: the viewing draw, or a shadow map with the material three overrides with. */
interface Pass {
  context: RenderContext;
  material: Material | null;
}

/**
 * What r186's renderObject gives an override material for one draw, and puts back once it has handed the draw on.
 * This and `DRAWN` mirror three 0.186.1's Renderer.renderObject; a three that sets other keys builds shadow shaders
 * in the frame again.
 */
const DRAW_STATE = ["colorNode", "depthNode", "positionNode", "side", "displacementMap", "displacementScale", "displacementBias"];
/** The keys a draw adds to an override material that lacks them, in the order it adds them. */
const DRAWN = ["alphaMap", "displacementMap", "displacementScale", "displacementBias"];

/**
 * A copy of the shadow pass's override material for compiling one draw. r186's compileAsync builds the draw only after
 * renderObject has put back the per-draw state it gave the override (the caster's shadow nodes and side), so with the
 * shared material it would prepare a pipeline the shadow pass never draws with. The copy keeps the state of the draw.
 * It is not disposed: that would release the pipeline before the shadow pass draws with it.
 */
function keepingDrawState(material: Material): Material {
  const copy = material.clone();
  // The build's cache key lists a material's keys in order. clone() leaves out those three adds to its shadow material,
  // its flag and those its draws set, which the copy gets in the order the shared material has them once it drew.
  for (const key of [...Object.keys(material), ...DRAWN])
    if (!key.startsWith("_") && !Object.hasOwn(copy, key)) Reflect.set(copy, key, Reflect.get(material, key) ?? null);
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
    // r186 compiles backgrounds first, which would postpone this mesh until after renderer state is restored.
    scene.background = null;
    scene.backgroundNode = null;
    return atDepth(renderer, context.depth, () => renderer.compileAsync(mesh, camera, scene));
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
