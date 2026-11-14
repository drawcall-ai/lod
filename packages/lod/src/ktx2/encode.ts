import { KHR_SUPERCOMPRESSION_ZSTD, read, write } from "ktx-parse";
import { inNode, nodeOnly } from "../node-process.js";
import { basisEncoder, encoderSources, type Encode } from "./uastc.js";

/** One map's RGBA8 mip levels, `size >> level` square. */
export interface Layer {
  levels: Uint8Array[];
  size: number;
  /** Whether the texels are sRGB-encoded colour; otherwise linear data. */
  srgb: boolean;
}

/** What the worker encodes: RGBA8 rows of a mip level, `width` wide and `height` high. */
export interface Job {
  data: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  srgb: boolean;
  /** Whether the encoder compresses the rows with Zstandard. */
  supercompress: boolean;
}

/** What the worker answers a job with. */
export type Reply = { file: Uint8Array<ArrayBuffer> } | { error: string };

interface Task {
  job: Job;
  resolve(file: Uint8Array): void;
  reject(error: unknown): void;
}

// Read when the module loads, which also happens in Node, as the vitecache plugin builds levels; Node before 21 has no navigator.
const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
/**
 * A worker per core but one, since a cold ladder's encodes take far longer than its bakes; at most 8, since each holds
 * 100 to 250 MB of WebAssembly memory.
 */
const LIMIT = Math.max(1, Math.min(8, cores - 1));
/** Largest job first, so that the smaller ones fill the other workers meanwhile. */
const queue: Task[] = [];
/** How many encoder workers run: a process-wide pool, as each holds its own WASM memory and LIMIT bounds them all. */
let workers = 0;

/**
 * One map as a KTX2 file of Basis UASTC with Zstandard supercompression. Each level encodes as `parts` strips of rows,
 * by default one per worker, so that a map's top level, which holds three quarters of its texels, takes all workers;
 * the strips' and levels' files are then joined. Takes about a second per million texels and worker.
 */
export async function encodeLayer({ levels, size, srgb }: Layer, parts = LIMIT): Promise<Uint8Array> {
  // Node compresses each joined level as one Zstandard stream, about a tenth smaller than a stream per strip; browsers
  // have no Zstandard compressor, so there the encoder compresses each strip.
  const zlib = inNode ? await nodeOnly<typeof import("node:zlib")>("node:zlib") : undefined;
  const files = await Promise.all(levels.map((data, m) => Promise.all(strips(data, size >> m, srgb, !zlib, parts).map((job) => encodeJob(job).then(read)))));
  const first = files[0]?.[0];
  if (!first) throw new Error("encodeLayer: a map has no mip levels");
  // UASTC encodes each 4x4 block on its own, and a level's Zstandard data may be several frames, which decode as one:
  // a level's strips, each a multiple of four rows high but the last, concatenate to data that decodes as the whole
  // level's.
  first.levels = files.map((parts) => {
    const levels = parts.map((file) => {
      const [level] = file.levels;
      if (!level) throw new Error("encodeLayer: the encoder wrote a file without levels");
      return level;
    });
    const joined = concat(levels.map((level) => level.levelData));
    const uncompressedByteLength = levels.reduce((sum, level) => sum + level.uncompressedByteLength, 0);
    if (!zlib) return { levelData: joined, uncompressedByteLength };
    const levelData = Uint8Array.from(zlib.zstdCompressSync(joined, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }));
    return { levelData, uncompressedByteLength };
  });
  first.supercompressionScheme = KHR_SUPERCOMPRESSION_ZSTD;
  first.pixelHeight = size;
  first.levelCount = files.length;
  return write(first);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * A `size`² level's strips: at most `parts`, each a multiple of four rows high but perhaps the last, each Zstandard
 * compressed if `supercompress`.
 */
function strips(data: Uint8Array, size: number, srgb: boolean, supercompress: boolean, parts: number): Job[] {
  const rows = 4 * Math.ceil(size / parts / 4);
  const jobs: Job[] = [];
  // Sliced: each job owns its buffer, which moves to its worker.
  for (let y = 0; y < size; y += rows) {
    const height = Math.min(rows, size - y);
    jobs.push({ data: data.slice(4 * size * y, 4 * size * (y + height)), width: size, height, srgb, supercompress });
  }
  return jobs;
}

function encodeJob(job: Job): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    queue.sort((a, b) => b.job.width * b.job.height - a.job.width * a.job.height);
    if (workers < LIMIT) void work();
  });
}

/** An encoder worker: a module worker from source text in browsers, a worker thread in Node (see `inNode`). */
interface Encoder {
  run(job: Job): Promise<Reply>;
  terminate(): void;
}

/** One worker, with its own encoder instance, that takes queued jobs until none is left and then ends. */
async function work(): Promise<void> {
  workers++;
  let encoder: Encoder | undefined;
  try {
    for (let task = queue.shift(); task; task = queue.shift()) {
      try {
        encoder ??= await start();
        const reply = await encoder.run(task.job);
        if ("file" in reply) task.resolve(reply.file);
        else task.reject(new Error(`encodeLayer: ${reply.error}`));
      } catch (error) {
        // The worker failed to load or crashed; the next job gets a fresh one.
        task.reject(error);
        encoder?.terminate();
        encoder = undefined;
      }
    }
  } finally {
    encoder?.terminate();
    workers--;
  }
}

async function start(): Promise<Encoder> {
  if (inNode) {
    const { url } = await import("./worker.js");
    const [{ Worker }, { once }] = await Promise.all([
      nodeOnly<typeof import("node:worker_threads")>("node:worker_threads"),
      nodeOnly<typeof import("node:events")>("node:events"),
    ]);
    const thread = new Worker(new URL(url), { workerData: url });
    return {
      // the thread's next message, or its error
      async run(job) {
        thread.postMessage(job, [job.data.buffer]);
        const reply: Reply = (await once(thread, "message"))[0];
        return reply;
      },
      terminate: () => void thread.terminate(),
    };
  }
  const { url, wasm } = await (program ??= workerProgram());
  const worker = new Worker(url, { type: "module" });
  worker.postMessage(wasm);
  return { run: (job) => run(worker, job), terminate: () => worker.terminate() };
}

/** The browser workers' program and the encoder's binary, made once for every worker. */
let program: Promise<{ url: string; wasm: Uint8Array }> | undefined;

/**
 * The program at a blob: URL, so that its workers are of the page's own origin: browsers start none from another
 * origin, such as a CDN's that serves this module, and a CDN or bundler may merge this module with others that a
 * worker cannot load.
 */
async function workerProgram(): Promise<{ url: string; wasm: Uint8Array }> {
  const { js, wasm } = await encoderSources();
  return { url: blobURL(`import factory from ${JSON.stringify(blobURL(js))};\n(${serve})(${basisEncoder}, factory);`), wasm };
}

function blobURL(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

/**
 * A browser encoder worker's program, run from its source text, and so as self-contained as `basisEncoder`, which it
 * is given as `start`: it takes the encoder's binary first, then jobs.
 */
function serve(start: typeof basisEncoder, factory: unknown): void {
  let encoder: Promise<Encode> | undefined;
  addEventListener("message", async (event: MessageEvent<Job | Uint8Array>) => {
    if (event.data instanceof Uint8Array) {
      encoder = start(factory, event.data);
      return;
    }
    try {
      if (!encoder) throw new Error("the encoder worker got a job before its binary");
      const file = (await encoder)(event.data);
      const reply: Reply = { file };
      postMessage(reply, { transfer: [file.buffer] });
    } catch (error) {
      const reply: Reply = { error: error instanceof Error ? error.message : String(error) };
      postMessage(reply);
    }
  });
}

/** `job` on `worker`; rejects when the worker fails rather than answers, as one that does not load does. */
function run(worker: Worker, job: Job): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const settle = () => {
      worker.removeEventListener("message", message);
      worker.removeEventListener("error", error);
      worker.removeEventListener("messageerror", error);
    };
    const message = (event: MessageEvent<Reply>) => {
      settle();
      resolve(event.data);
    };
    const error = (event: Event) => {
      settle();
      const why = event instanceof ErrorEvent ? event.message : `${event.type} event`;
      reject(new Error(`encodeLayer: the encoder worker failed (${why})`));
    };
    worker.addEventListener("message", message);
    worker.addEventListener("error", error);
    worker.addEventListener("messageerror", error);
    worker.postMessage(job, [job.data.buffer]);
  });
}
