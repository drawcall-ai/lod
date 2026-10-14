#!/usr/bin/env node
// Bakes .glb/.gltf models into <name>.impostor.glts files in plain Node: glTF-Transform
// reads the file, three's GLTFLoader builds the scene and webgl-node provides WebGL2 on
// the system's OpenGL ES driver (the GPU, or Mesa's llvmpipe on machines without one).
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { bakeImpostor, writeImpostorGlts, type ImpostorLayout } from "@drawcall/impostor";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { MeshoptDecoder } from "meshoptimizer";
import { Texture, WebGLRenderer, type Mesh, type Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const HELP = `Bake octahedral impostors into .glts files.

Usage: impostor <input...> [options]

Inputs: .glb or .gltf files. Each becomes <name>.impostor.glts next to it.

Options:
  --layout <full|hemi>   full (default): works from every side. hemi: views from the
                         horizon up only, for upright objects; about 45% less memory.
  --resolution <px>      pixels per view: 64, 128 (default), 256 or 512. The impostor
                         stays sharp up to about this size on screen.
  --out <file.glts>      output path (one input only)
  -h, --help
`;
const LAYOUTS: ImpostorLayout[] = ["full", "hemi"];
const RESOLUTIONS = ["64", "128", "256", "512"];

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

function fail(message: string): never {
  console.error(`impostor: ${message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      layout: { type: "string", default: "full" },
      resolution: { type: "string", default: "128" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (error) {
  fail(`${describe(error)}\n\n${HELP}`);
}
const { values, positionals } = parsed;
if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (!positionals.length) fail(`no input files\n\n${HELP}`);
const layout = LAYOUTS.find((l) => l === values.layout) ?? fail(`--layout must be "full" or "hemi", not "${values.layout}"`);
if (!RESOLUTIONS.includes(values.resolution)) fail(`--resolution must be 64, 128, 256 or 512, not "${values.resolution}"`);
const resolution = Number(values.resolution);
if (values.out && positionals.length > 1) fail("--out needs exactly one input");
if (values.out && extname(values.out) !== ".glts") fail(`--out must be a .glts file, not "${values.out}"`);
for (const input of positionals)
  if (![".glb", ".gltf"].includes(extname(input).toLowerCase()))
    fail(`${input}: only .glb and .gltf files can be baked in Node; bake other scenes in the browser with bakeImpostor`);

// The native modules load only once there is work, so a missing driver or binary gets a
// clear message.
async function native() {
  try {
    const { createWebGL2Context } = await import("webgl-node");
    const { canvas, gl } = createWebGL2Context(1, 1);
    const { default: sharp } = await import("sharp");
    return { renderer: new WebGLRenderer({ canvas, context: gl }), sharp };
  } catch (error) {
    fail(
      `cannot load the native modules (${describe(error)}).\n` +
        "WebGL2 needs OpenGL ES through EGL; on Linux: apt install libegl1 libgles2 libegl-mesa0 libgl1-mesa-dri.\n" +
        "With pnpm, allow the native builds: pnpm approve-builds (native-gles, sharp).",
    );
  }
}
const { renderer, sharp } = await native();

// three's GLTFLoader expects two browser globals: `self`, and `createImageBitmap` for
// textures. The decoded image is canvas-shaped because webgl-node 1.6 reads
// texSubImage2D sources only through getContext("2d").
Object.assign(globalThis, {
  self: globalThis,
  createImageBitmap: async (blob: Blob) => {
    const { data, info } = await sharp(Buffer.from(await blob.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
    return { width: info.width, height: info.height, getContext: () => ({ getImageData: () => ({ data: pixels }) }), close() {} };
  },
});

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule(), "meshopt.decoder": MeshoptDecoder });

/** A file that cannot be read: reported briefly, unlike unexpected failures. */
class Unreadable extends Error {}

/** Reads any glTF (separate files, Draco, meshopt) and hands three one plain GLB. */
async function load(path: string): Promise<Object3D> {
  const document = await io.read(path).catch((error: unknown) => {
    throw new Unreadable(`cannot read it: ${describe(error).split("\n")[0]}`);
  });
  // Geometry is decoded on read; drop the compression so the GLB is written uncompressed.
  for (const extension of document.getRoot().listExtensionsUsed())
    if (extension.extensionName === "KHR_draco_mesh_compression" || extension.extensionName === "EXT_meshopt_compression") extension.dispose();
  const glb = await io.writeBinary(document);
  return (await new GLTFLoader().parseAsync(glb.slice().buffer, "")).scene;
}

const isMesh = (node: Object3D): node is Mesh => "isMesh" in node && node.isMesh === true;

/** Frees what a baked scene uploaded to the GPU, so a long batch does not grow. */
function release(scene: Object3D): void {
  scene.traverse((node) => {
    if (!isMesh(node)) return;
    node.geometry.dispose();
    for (const material of [node.material].flat()) {
      for (const value of Object.values({ ...material })) if (value instanceof Texture) value.dispose();
      material.dispose();
    }
  });
}

let failed = 0;
for (const input of positionals) {
  const out = values.out ? resolve(values.out) : join(dirname(resolve(input)), `${basename(input, extname(input))}.impostor.glts`);
  try {
    const start = performance.now();
    const scene = await load(resolve(input));
    const impostor = await bakeImpostor(scene, { layout, resolution, renderer }).finally(() => release(scene));
    const source = writeImpostorGlts(impostor);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, source);
    const mb = (Buffer.byteLength(source) / 2 ** 20).toFixed(1);
    const seconds = ((performance.now() - start) / 1000).toFixed(1);
    console.log(`${input} → ${relative(process.cwd(), out)}   ${impostor.layout} ${impostor.frames}×${impostor.frames} · ${impostor.size}² · ${impostor.maps.length} maps · ${mb} MB · ${seconds} s`);
  } catch (error) {
    failed++;
    console.error(`${input}: ${error instanceof Unreadable ? error.message : error instanceof Error ? error.stack : String(error)}`);
  }
}
if (failed) process.exitCode = 1;
