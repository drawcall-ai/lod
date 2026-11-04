import { WorkerPool } from "three/addons/utils/WorkerPool.js";

/** What the worker encodes: one map's RGBA8 mip levels, `size >> level` square. */
export interface Job {
  levels: Uint8Array[];
  size: number;
  /** Whether the texels are sRGB-encoded colour; otherwise linear data. */
  srgb: boolean;
}

/**
 * Workers that encode, each with its own encoder instance: a few, since each holds tens of MB of WebAssembly memory
 * and a ladder of cold impostors would otherwise start one per map at once. They end when no job is left.
 */
// Read when the module loads, which also happens in Node, as for a .glts warmup.
const cores = typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency;
const pool = new WorkerPool(Math.max(1, Math.min(4, cores - 1)));
let jobs = 0;

/**
 * One map as a KTX2 file of Basis UASTC, encoded in a pooled worker so that maps encode in parallel and the page keeps
 * drawing. Takes about a second per million texels.
 */
export async function encodeLayer(job: Job): Promise<Uint8Array> {
  const { url } = await import("./worker.js");
  pool.setWorkerCreator(() => {
    const worker = new Worker(url, { type: "module" });
    // three's pool settles jobs by message only; a worker that fails to start reports here.
    worker.addEventListener("error", (event) => console.error(`encodeImpostorAsync: an encoder worker failed (${event.message})`));
    return worker;
  });
  jobs++;
  try {
    // Copied: the impostor keeps its levels.
    const { data }: MessageEvent<unknown> = await pool.postMessage(job);
    const file: unknown = typeof data === "object" && data !== null ? Reflect.get(data, "file") : undefined;
    if (file instanceof Uint8Array) return file;
    throw new Error(`encodeImpostorAsync: ${String(typeof data === "object" && data !== null ? Reflect.get(data, "error") : data)}`);
  } finally {
    if (--jobs === 0) pool.dispose();
  }
}
