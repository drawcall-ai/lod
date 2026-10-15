import { inflateSync } from "fflate";
import { XATLAS_WASM } from "./xatlas.js";
import type { Surface } from "../source/surface.js";

// xatlas, instantiated from the inlined binary with the few imports its Emscripten build
// needs. No worker and no wasm URL: either would need bundler-specific syntax, and .glts
// scripts admit neither dynamic imports nor cross-origin workers. It runs on the calling
// thread, one atlas at a time.

type Call = (...args: number[]) => number;

interface XAtlas {
  memory: WebAssembly.Memory;
  call: (name: string, ...args: number[]) => number;
}

let module: Promise<XAtlas> | undefined;

/**
 * `surface` with a fresh UV atlas for a `size`² texture: xatlas cuts it into charts and
 * packs them with a bilinear-safe padding. Vertices on chart seams are split; the result's
 * attributes follow its new vertices.
 */
export async function unwrap(surface: Surface, size: number): Promise<Surface & { uvs: Float32Array }> {
  const xatlas = await (module ??= instantiate());
  const { call } = xatlas;
  const atlas = call("xatlasCreate");
  if (!atlas) throw new Error("bakeMesh: xatlas could not create an atlas");
  const freed: number[] = [];
  const copy = (array: Float32Array | Uint32Array) => {
    const pointer = call("malloc", array.byteLength);
    if (!pointer) throw new Error("bakeMesh: xatlas ran out of memory");
    freed.push(pointer);
    new Uint8Array(xatlas.memory.buffer, pointer, array.byteLength).set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    return pointer;
  };
  try {
    // xatlas::MeshDecl (see xatlas.h), 4 bytes per field.
    const positions = copy(surface.positions);
    const normals = copy(surface.normals);
    const index = copy(surface.index);
    const decl = call("malloc", call("xatlasMeshDecl_size"));
    freed.push(decl);
    call("xatlasMeshDeclInit", decl);
    // Allocations can grow the memory, which detaches earlier views of it. Fields: positions,
    // normals, uvs, indices, faceIgnore, faceMaterial, faceVertexCount, vertexCount, three
    // strides (bytes), indexCount, indexOffset, faceCount, indexFormat (1: 32-bit).
    new Int32Array(xatlas.memory.buffer, decl, 15).set([
      positions,
      normals,
      0,
      index,
      0,
      0,
      0,
      surface.positions.length / 3,
      12,
      12,
      0,
      surface.index.length,
      0,
      0,
      1,
    ]);
    const error = call("xatlasAddMesh", atlas, decl, 1);
    if (error !== 0) throw new Error(`bakeMesh: xatlas rejected the low mesh (error ${error})`);

    call("xatlasComputeCharts", atlas, 0);
    // xatlas::PackOptions. Given only a resolution, xatlas picks a texel density that
    // roughly fills it, and the atlas can come out larger; given a density as well, it
    // packs exactly size² atlases, as many as it needs. So: lower the density it picked
    // until one atlas holds every chart.
    const pack = call("malloc", call("xatlasPackOptions_size"));
    freed.push(pack);
    call("xatlasPackOptionsInit", pack);
    const packCharts = (density: number) => {
      const options = new DataView(xatlas.memory.buffer, pack);
      options.setInt32(4, 2, true); // padding, in texels
      options.setFloat32(8, density, true); // texelsPerUnit
      options.setInt32(12, size, true); // resolution
      call("xatlasPackCharts", atlas, pack);
    };
    packCharts(0);
    let density =
      call("xatlasAtlas_getTexelsPerUnit", atlas) * Math.min(1, size / Math.max(call("xatlasAtlas_getWidth", atlas), call("xatlasAtlas_getHeight", atlas)));
    for (let attempt = 0; ; attempt++) {
      packCharts(density);
      if (call("xatlasAtlas_getAtlasCount", atlas) === 1) break;
      if (attempt === 16) throw new Error(`bakeMesh: xatlas could not pack the low mesh into one ${size}² atlas`);
      density *= 0.9;
    }
    return output(xatlas, atlas, surface, size);
  } finally {
    for (const pointer of freed) call("free", pointer);
    call("xatlasDestroy", atlas);
  }
}

function output({ memory, call }: XAtlas, atlas: number, surface: Surface, size: number): Surface & { uvs: Float32Array } {
  const mesh = call("xatlasAtlas_getMesh", atlas, 0);
  const count = call("xatlasMesh_getVertexCount", mesh);
  const vertices = call("xatlasMesh_getVertexArray", mesh);
  const indexCount = call("xatlasMesh_getIndexCount", mesh);
  const index = new Uint32Array(memory.buffer, call("xatlasMesh_getIndexArray", mesh), indexCount).slice();
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const from = call("xatlasVertex_getXref", vertices, i);
    positions.set(surface.positions.subarray(from * 3, from * 3 + 3), i * 3);
    normals.set(surface.normals.subarray(from * 3, from * 3 + 3), i * 3);
    // In texels of the atlas, which is the texture.
    uvs[i * 2] = call("xatlasVertex_getUV0", vertices, i) / size;
    uvs[i * 2 + 1] = call("xatlasVertex_getUV1", vertices, i) / size;
  }
  return { positions, normals, uvs, index };
}

async function instantiate(): Promise<XAtlas> {
  let memory: WebAssembly.Memory | undefined;
  const heap = () => {
    if (!memory) throw new Error("bakeMesh: xatlas is not instantiated");
    return memory;
  };
  const imports = {
    env: {
      _abort_js: () => {
        throw new Error("bakeMesh: xatlas aborted");
      },
      _emscripten_runtime_keepalive_clear: () => {},
      _setitimer_js: () => 0,
      emscripten_resize_heap: (requested: number) => {
        const current = heap().buffer.byteLength;
        heap().grow(Math.ceil(((requested >>> 0) - current) / 65536));
        return 1;
      },
    },
    wasi_snapshot_preview1: {
      // xatlas prints nothing unless asked; report everything as written.
      fd_write: (_fd: number, iovs: number, count: number, written: number) => {
        const view = new DataView(heap().buffer);
        let bytes = 0;
        for (let i = 0; i < count; i++) bytes += view.getUint32(iovs + i * 8 + 4, true);
        view.setUint32(written, bytes, true);
        return 0;
      },
      proc_exit: (code: number) => {
        throw new Error(`bakeMesh: xatlas exited (${code})`);
      },
    },
  };
  const bytes = inflateSync(Uint8Array.from(atob(XATLAS_WASM), (c) => c.charCodeAt(0)));
  const { exports } = (await WebAssembly.instantiate(bytes, imports)).instance;
  const exported = exports.memory;
  if (!(exported instanceof WebAssembly.Memory)) throw new Error("bakeMesh: xatlas exports no memory");
  memory = exported;
  const functions = new Map<string, Call>();
  const call = (name: string, ...args: number[]) => {
    let f = functions.get(name);
    if (!f) {
      const value = exports[name];
      if (typeof value !== "function") throw new Error(`bakeMesh: xatlas exports no ${name}`);
      f = (...a: number[]) => {
        const result: unknown = Reflect.apply(value, undefined, a);
        // Functions returning void give undefined.
        return typeof result === "number" ? result : 0;
      };
      functions.set(name, f);
    }
    return f(...args);
  };
  call("__wasm_call_ctors");
  return { memory: exported, call };
}
