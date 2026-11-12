// The worker an impostor map encodes in. The page imports this module only for its URL, at which it then starts it as
// a worker: unlike `new URL("./file", import.meta.url)`, a module's own URL holds wherever a bundler moves it. Node
// starts it as a worker thread, given that URL as its workerData.
import type { Job, Reply } from "./encode.js";
import { encode } from "./uastc.js";
import { inNode, nodeOnly } from "../../node-process.js";

export const url = import.meta.url;

/** `job`'s reply, and the buffers it moves. */
async function answer(job: Job): Promise<[Reply, ArrayBuffer[]]> {
  try {
    const file = await encode(job);
    return [{ file }, [file.buffer]];
  } catch (error) {
    return [{ error: error instanceof Error ? error.message : String(error) }, []];
  }
}

const scope: unknown = Reflect.get(globalThis, "WorkerGlobalScope");
if (typeof scope === "function" && globalThis instanceof scope)
  addEventListener("message", (event: MessageEvent<Job>) => answer(event.data).then(([reply, transfer]) => postMessage(reply, { transfer })));

if (inNode) {
  const { parentPort, workerData } = await nodeOnly<typeof import("node:worker_threads")>("node:worker_threads");
  const port = workerData === url ? parentPort : null;
  port?.on("message", (job: Job) => answer(job).then(([reply, transfer]) => port.postMessage(reply, transfer)));
}
