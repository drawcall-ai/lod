import { read, write } from "ktx-parse";

/** One map's RGBA8 mip levels, `size >> level` square. */
export interface Layer {
  levels: Uint8Array[];
  size: number;
  /** Whether the texels are sRGB-encoded colour; otherwise linear data. */
  srgb: boolean;
}

/** What the worker encodes: RGBA8 rows of a mip level, `width` wide and `height` high. */
export interface Job {
  data: Uint8Array;
  width: number;
  height: number;
  srgb: boolean;
}

/** What the worker answers a job with. */
export type Reply = { file: Uint8Array } | { error: string };

interface Task {
  job: Job;
  resolve(file: Uint8Array): void;
  reject(error: unknown): void;
}

// Read when the module loads, which also happens in Node, as for a .glts warmup; Node before 21 has no navigator.
const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
/** A few workers, since each holds tens of MB of WebAssembly memory and a ladder of cold impostors queues jobs for every map level. */
const LIMIT = Math.max(1, Math.min(4, cores - 1));
/** Largest job first, so that the smaller ones fill the other workers meanwhile. */
const queue: Task[] = [];
let workers = 0;

/**
 * One map as a KTX2 file of Basis UASTC. Each level encodes as `parts` strips of rows, by default one per worker, so
 * that a map's top level, which holds three quarters of its texels, takes all workers; the strips' and levels' files
 * are then joined. Takes about a second per million texels and worker.
 */
export async function encodeLayer({ levels, size, srgb }: Layer, parts = LIMIT): Promise<Uint8Array> {
  const files = await Promise.all(levels.map((data, m) => Promise.all(strips(data, size >> m, srgb, parts).map((job) => encodeJob(job).then(read)))));
  const first = files[0]?.[0];
  if (!first) throw new Error("encodeImpostorAsync: a map has no mip levels");
  // UASTC encodes each 4x4 block on its own, and a level's Zstandard data may be several frames, which decode as one:
  // a level's strips, each a multiple of four rows high but the last, concatenate to data that decodes as the whole level's.
  first.levels = files.map((parts) => {
    const levels = parts.map((file) => {
      const [level] = file.levels;
      if (!level) throw new Error("encodeImpostorAsync: the encoder wrote a file without levels");
      return level;
    });
    const levelData = new Uint8Array(levels.reduce((sum, level) => sum + level.levelData.length, 0));
    let offset = 0;
    for (const level of levels) {
      levelData.set(level.levelData, offset);
      offset += level.levelData.length;
    }
    return { levelData, uncompressedByteLength: levels.reduce((sum, level) => sum + level.uncompressedByteLength, 0) };
  });
  first.pixelHeight = size;
  first.levelCount = files.length;
  return write(first);
}

/** A `size`² level's strips: at most `parts`, each a multiple of four rows high but perhaps the last. */
function strips(data: Uint8Array, size: number, srgb: boolean, parts: number): Job[] {
  const rows = 4 * Math.ceil(size / parts / 4);
  const jobs: Job[] = [];
  // Sliced: each job owns its buffer, which moves to its worker.
  for (let y = 0; y < size; y += rows) {
    const height = Math.min(rows, size - y);
    jobs.push({ data: data.slice(4 * size * y, 4 * size * (y + height)), width: size, height, srgb });
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

/** One worker, with its own encoder instance, that takes queued jobs until none is left and then ends. */
async function work(): Promise<void> {
  workers++;
  let worker: Worker | undefined;
  try {
    for (let task = queue.shift(); task; task = queue.shift()) {
      try {
        worker ??= await start();
        const reply = await run(worker, task.job);
        if ("file" in reply) task.resolve(reply.file);
        else task.reject(new Error(`encodeImpostorAsync: ${reply.error}`));
      } catch (error) {
        // The worker failed to load or crashed; the next job gets a fresh one.
        task.reject(error);
        worker?.terminate();
        worker = undefined;
      }
    }
  } finally {
    worker?.terminate();
    workers--;
  }
}

async function start(): Promise<Worker> {
  const { url } = await import("./worker.js");
  return new Worker(url, { type: "module" });
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
      reject(new Error(`encodeImpostorAsync: the encoder worker failed (${why})`));
    };
    worker.addEventListener("message", message);
    worker.addEventListener("error", error);
    worker.addEventListener("messageerror", error);
    worker.postMessage(job, [job.data.buffer]);
  });
}
