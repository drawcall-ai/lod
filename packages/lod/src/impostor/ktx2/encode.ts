/** What the worker encodes: one map's RGBA8 mip levels, `size >> level` square. */
export interface Job {
  levels: Uint8Array[];
  size: number;
  /** Whether the texels are sRGB-encoded colour; otherwise linear data. */
  srgb: boolean;
}

/** What the worker answers a job with. */
export type Reply = { file: Uint8Array } | { error: string };

interface Task {
  job: Job;
  resolve(file: Uint8Array): void;
  reject(error: unknown): void;
}

// Read when the module loads, which also happens in Node, as for a .glts warmup.
const cores = typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency;
/** A few workers, since each holds tens of MB of WebAssembly memory and a ladder of cold impostors queues one job per map. */
const LIMIT = Math.max(1, Math.min(4, cores - 1));
const queue: Task[] = [];
let workers = 0;

/**
 * One map as a KTX2 file of Basis UASTC, encoded in a worker so that maps encode in parallel and the page keeps
 * drawing. Takes about a second per million texels.
 */
export function encodeLayer(job: Job): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
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
    // Copied: the impostor keeps its levels.
    worker.postMessage(job);
  });
}
