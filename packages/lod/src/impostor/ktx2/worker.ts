// The worker thread an impostor map encodes in under Node, which starts it at this module's own URL, given that URL as
// its workerData. Browsers run their encoder workers from source text instead (see `encode.ts`).
import type { Job, Reply } from "./encode.js";
import { basisEncoder, encoderSources } from "./uastc.js";
import { inNode, nodeOnly } from "../../node-process.js";

export const url = import.meta.url;

if (inNode) {
  const { parentPort, workerData } = await nodeOnly<typeof import("node:worker_threads")>("node:worker_threads");
  const port = workerData === url ? parentPort : null;
  if (port) {
    // Node imports data: URLs, unlike blob: URLs.
    const encoder = encoderSources().then(async ({ js, wasm }) =>
      basisEncoder((await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(js)}`)).default, wasm),
    );
    port.on("message", async (job: Job) => {
      try {
        const file = (await encoder)(job);
        const reply: Reply = { file };
        port.postMessage(reply, [file.buffer]);
      } catch (error) {
        const reply: Reply = { error: error instanceof Error ? error.message : String(error) };
        port.postMessage(reply);
      }
    });
  }
}
