import type { Mesh, Object3D, Renderer, Texture } from "three/webgpu";
import { isMesh, isNode, isTexture } from "../../three.js";
import type { RenderContext, ShadowMap, Target } from "./contexts.js";
import { compileMesh, frame, sharePipelines, type CompileTarget } from "./pipelines.js";

/** What a compile is for besides its context: shadow maps, and which targets were disposed. */
export interface CompileFor {
  /** The shadow maps the scene's level meshes draw into: each mesh that casts compiles for them too. */
  shadows: readonly ShadowMap[];
  /** Whether `target` was disposed: no draw compiles for it, as that would make its textures again. */
  isDisposed(target: Target): boolean;
}

const compilers = new WeakMap<Renderer, Compiler>();

/** What `renderer` prepares levels with: one Compiler per renderer, made the first time a level compiles for it. */
export function compilerOf(renderer: Renderer): Compiler {
  let compiler = compilers.get(renderer);
  if (!compiler) compilers.set(renderer, (compiler = new Compiler(renderer)));
  return compiler;
}

/**
 * What a renderer prepares for the levels arriving: the levels share its queue's budget and its pipeline cache, which
 * it shares the readiness of (see `sharePipelines`).
 */
export class Compiler {
  /** Uploaded since the last frame. */
  private uploaded = 0;
  /** The last upload: uploads run in turn. */
  private uploads = Promise.resolve();
  /**
   * The last draw compiled for each shader build: material, attributes, target, shadow map and nesting. three starts a
   * build for each draw that misses its cache, even one another draw is building, so a draw that builds alike waits
   * for the last one and finds its build cached.
   */
  private readonly builds = new Map<string, Promise<void>>();

  constructor(private readonly renderer: Renderer) {
    sharePipelines(renderer);
  }

  /**
   * Prepare the same target and MRT as the camera's draw, even if normal rendering has since restored the canvas, and
   * the shadow maps of `compileFor`, for each mesh that casts. r186 uploads a texture synchronously inside initTexture,
   * and creates a pipeline it meets while rendering synchronously, so each texture and draw is prepared here first.
   * Textures upload paced across frames (see `paced`); every draw then compiles at once, but for those of one
   * multi-material mesh, as do the draws of every other level the renderer prepares, so their pipelines are created
   * side by side.
   */
  async compileAsync(object: Object3D, context: RenderContext, { shadows, isDisposed }: CompileFor): Promise<void> {
    const { renderer } = this;
    const { memory } = renderer.info;
    for (const texture of textures(object))
      await this.paced(() => {
        const known = memory.textures;
        renderer.initTexture(texture);
        return memory.textures === known ? 0 : bytesOf(texture);
      });
    const meshes: Mesh[] = [];
    object.traverse((node) => {
      if (isMesh(node)) meshes.push(node);
    });
    const draws: Promise<void>[] = [];
    for (const mesh of meshes) {
      const targets: CompileTarget[] = [{ context, overrideMaterial: null }];
      if (mesh.castShadow)
        for (const { camera, target, overrideMaterial, depth } of shadows.filter((map) => map.scene === context.scene))
          targets.push({ context: { ...context, camera, target, mrt: null, cubeFace: 0, mipLevel: 0, depth }, overrideMaterial });
      if (!Array.isArray(mesh.material)) {
        for (const target of targets) draws.push(this.compileDraw(mesh, target, mesh.geometry.groups, isDisposed));
        continue;
      }
      // r186 starts only the first material before yielding; isolate one draw so setup sees its captured target/MRT.
      // The draws of one mesh compile in turn: with their compiles overlapping, r186 creates some of their pipelines
      // with another draw's bind group layout, which WebGPU rejects.
      let turn = Promise.resolve();
      for (const target of targets)
        for (const group of mesh.geometry.groups) draws.push((turn = turn.then(() => this.compileDraw(mesh, target, [group], isDisposed))));
    }
    await Promise.all(draws);
  }

  /** Run `upload`, which answers the bytes it uploaded, after the next frame if those since the last one reached `FRAME_UPLOAD`. */
  private paced(upload: () => number): Promise<void> {
    const run = this.uploads.then(async () => {
      if (this.uploaded >= FRAME_UPLOAD) await frame();
      const bytes = upload();
      // The next frame empties the budget, whether or not an upload waits for it.
      if (bytes > 0 && this.uploaded === 0) void frame().then(() => void (this.uploaded = 0));
      this.uploaded += bytes;
    });
    this.uploads = run.catch(() => {});
    return run;
  }

  /** Compile the draw of `mesh`'s groups `part` for `target`. */
  private compileDraw(mesh: Mesh, target: CompileTarget, part: Group[], isDisposed: CompileFor["isDisposed"]): Promise<void> {
    const { builds } = this;
    const material = Array.isArray(mesh.material) ? mesh.material[part[0]?.materialIndex ?? 0] : mesh.material;
    const key = [
      material ? material.uuid : "none",
      Object.keys(mesh.geometry.attributes).sort().join(),
      target.context.target ? target.context.target.texture.id : "canvas",
      target.overrideMaterial ? target.overrideMaterial.uuid : "camera",
      target.context.depth,
    ].join(" ");
    const start = () => {
      // Uploads and alike builds may have taken frames: a target disposed meanwhile stays disposed.
      const drawn = target.context.target;
      if (drawn && isDisposed(drawn)) return Promise.resolve();
      const groups = mesh.geometry.groups;
      try {
        mesh.geometry.groups = part;
        return compileMesh(this.renderer, mesh, target);
      } finally {
        mesh.geometry.groups = groups;
      }
    };
    const alike = builds.get(key);
    const own = alike ? alike.then(start) : start();
    const settled = own.then(
      () => {},
      () => {},
    );
    builds.set(key, settled);
    void settled.then(() => {
      if (builds.get(key) === settled) builds.delete(key);
    });
    return own;
  }
}

/**
 * What texture uploads may add in one frame, in bytes: a 2048² RGBA texture. Uploads run on the GPU's queue before the
 * frame that follows them, which waits for them all. A draw's geometry is not paced: its buffers copy in far less
 * time than a texture of the same size and its mipmaps.
 */
const FRAME_UPLOAD = 16 * 2 ** 20;

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
