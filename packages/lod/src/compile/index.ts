import type { Mesh, Object3D, Renderer, Texture } from "three/webgpu";
import { isMesh, isNode, isTexture } from "../three.js";
import { compileMesh, frame, type Pass } from "./pipelines.js";
import { shadowPassesOf, type RenderContext } from "../view.js";

/**
 * Prepare the same target and MRT as the viewing draw, even if normal rendering has since restored the canvas, and the
 * shadow maps the scene's level meshes draw into, for each mesh that casts. r186 uploads a texture synchronously inside
 * initTexture, and creates a pipeline it meets while rendering synchronously, so each texture and draw is prepared
 * here first. Textures upload paced across frames (see `paced`); every draw then compiles at once, as do the draws of
 * every other level the renderer prepares, so their pipelines are created side by side.
 */
export async function compileLevel(object: Object3D, context: RenderContext): Promise<void> {
  const { renderer } = context;
  let work = renderers.get(renderer);
  if (!work) renderers.set(renderer, (work = { uploaded: 0, uploads: Promise.resolve(), builds: new Map() }));
  const { memory } = renderer.info;
  for (const texture of textures(object))
    await paced(work, () => {
      const known = memory.textures;
      renderer.initTexture(texture);
      return memory.textures === known ? 0 : bytesOf(texture);
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
    for (const pass of passes) for (const part of parts) draws.push(compileDraw(work, mesh, pass, part));
  }
  await Promise.all(draws);
}

/**
 * What texture uploads may add in one frame, in bytes: a 2048² RGBA texture. Uploads run on the GPU's queue before the
 * frame that follows them, which waits for them all. A draw's geometry is not paced: its buffers copy in far less
 * time than a texture of the same size and its mipmaps.
 */
const FRAME_UPLOAD = 16 * 2 ** 20;

/** What one renderer is preparing: the levels it prepares share its queue's budget and its pipeline cache. */
interface Preparing {
  /** Uploaded since the last frame. */
  uploaded: number;
  /** The last upload: uploads run in turn. */
  uploads: Promise<void>;
  /**
   * The last draw compiled for each shader build: material, attributes, target, pass and nesting. three starts a
   * build for each draw that misses its cache, even one another draw is building, so a draw that builds alike waits
   * for the last one and finds its build cached.
   */
  builds: Map<string, Promise<void>>;
}

const renderers = new WeakMap<Renderer, Preparing>();

/** Run `upload`, which answers the bytes it uploaded, after the next frame if those since the last one reached `FRAME_UPLOAD`. */
function paced(work: Preparing, upload: () => number): Promise<void> {
  const run = work.uploads.then(async () => {
    if (work.uploaded >= FRAME_UPLOAD) await frame();
    const bytes = upload();
    // The next frame empties the budget, whether or not an upload waits for it.
    if (bytes > 0 && work.uploaded === 0) void frame().then(() => void (work.uploaded = 0));
    work.uploaded += bytes;
  });
  work.uploads = run.catch(() => {});
  return run;
}

/** Compile the draw of `mesh`'s groups `part` in `pass`. */
function compileDraw(work: Preparing, mesh: Mesh, pass: Pass, part: Group[]): Promise<void> {
  const material = Array.isArray(mesh.material) ? mesh.material[part[0]?.materialIndex ?? 0] : mesh.material;
  const key = [
    material ? idOf(material) : "none",
    Object.keys(mesh.geometry.attributes).sort().join(),
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
  const alike = work.builds.get(key);
  const own = alike ? alike.then(start) : start();
  const settled = own.then(
    () => {},
    () => {},
  );
  work.builds.set(key, settled);
  void settled.then(() => {
    if (work.builds.get(key) === settled) work.builds.delete(key);
  });
  return own;
}

const ids = new WeakMap<object, number>();
let next = 0;

/** A number for `value`, the same for the same object only: for keys built of several objects. */
function idOf(value: object): number {
  let id = ids.get(value);
  if (id === undefined) ids.set(value, (id = next++));
  return id;
}

/** A draw's range of a geometry, as three's groups hold it. */
type Group = Mesh["geometry"]["groups"][number];

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/**
 * The bytes `texture` uploads, as three 0.186.1 uploads it: its mip levels', or its image's and the mipmaps three
 * generates from it. An uncompressed cube's image is its six faces, and its mip levels are those after the first, with
 * six images each; a compressed cube's faces carry their own mip levels, unless it has some.
 */
function bytesOf(texture: Texture): number {
  const levels: unknown[] = texture.mipmaps ?? [];
  const cube = Array.isArray(texture.image);
  if (levels.length > 0 && (!cube || Reflect.get(texture, "isCompressedTexture") === true)) return bytesIn(levels);
  const bytes = bytesIn(texture.image) + bytesIn(levels);
  return texture.generateMipmaps && levels.length === 0 ? Math.ceil((bytes * 4) / 3) : bytes;
}

/** The bytes of an image, a mip level, a cube's face or a list of them: its data's, or four per texel. */
function bytesIn(image: unknown): number {
  if (Array.isArray(image)) return sum(image.map(bytesIn));
  if (typeof image !== "object" || image === null) return 0;
  if (isTexture(image)) return bytesIn(image.mipmaps?.length ? image.mipmaps : image.image);
  const images: unknown = Reflect.get(image, "images");
  if (Array.isArray(images)) return bytesIn(images);
  const data: unknown = Reflect.get(image, "data");
  if (ArrayBuffer.isView(data)) return data.byteLength;
  const dimension = (name: string) => {
    const value: unknown = Reflect.get(image, name);
    return typeof value === "number" ? value : 1;
  };
  return dimension("width") * dimension("height") * dimension("depth") * 4;
}

/**
 * The textures `object`'s meshes draw: their materials', those their nodes sample, and those a material keeps in plain
 * objects and arrays for nodes it makes while it builds (an impostor's atlases, a baked mesh's rooms).
 */
function textures(object: Object3D): Set<Texture> {
  const found = new Set<Texture>();
  const visited = new Set<unknown>();
  const visit = (value: unknown) => {
    if (typeof value !== "object" || value === null || visited.has(value)) return;
    visited.add(value);
    if (isTexture(value)) found.add(value);
    else if (isNode(value)) {
      visit(Reflect.get(value, "value"));
      for (const child of value.getChildren()) visit(child);
    } else if (Array.isArray(value)) for (const entry of value) visit(entry);
    else if ([Object.prototype, null].includes(Object.getPrototypeOf(value)))
      for (const [key, entry] of Object.entries(value)) if (key !== "userData") visit(entry);
  };
  object.traverse((node) => {
    if (!isMesh(node)) return;
    // userData is the application's, not what a material binds.
    for (const material of [node.material].flat()) for (const [key, value] of Object.entries(material)) if (key !== "userData") visit(value);
  });
  return found;
}
