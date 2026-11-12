// The worker an impostor map encodes in. The page imports this module only for its URL, at which it then starts it as
// a worker: unlike `new URL("./file", import.meta.url)`, a module's own URL holds wherever a bundler moves it. Node
// starts it as a worker thread, given `threadData`.
import type { Job, Reply } from "./encode.js";
import { encode } from "./uastc.js";
import { inNode, nodeOnly } from "../../node-process.js";

export const url = import.meta.url;
/** What marks a worker thread as the encoder's, apart from any other thread that imports this module. */
export const threadData = "@drawcall/lod impostor encoder";

const scope: unknown = Reflect.get(globalThis, "WorkerGlobalScope");
if (typeof scope === "function" && globalThis instanceof scope) {
  addEventListener("message", (event: MessageEvent<Job>) => {
    encode(event.data).then(
      (file) => reply({ file }, [file.buffer]),
      (error: unknown) => reply({ error: error instanceof Error ? error.message : String(error) }),
    );
  });
}

const reply = (message: Reply, transfer: Transferable[] = []) => postMessage(message, { transfer });

if (inNode) {
  const { parentPort: port, workerData } = await nodeOnly<typeof import("node:worker_threads")>("node:worker_threads");
  if (port && workerData === threadData)
    port.on("message", (job: Job) => {
      encode(job).then(
        (file) => port.postMessage({ file } satisfies Reply, [file.buffer]),
        (error: unknown) => port.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies Reply),
      );
    });
}
