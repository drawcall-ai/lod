// The worker an impostor map encodes in. The page imports this module only for its URL, at which it then starts it as
// a worker: unlike `new URL("./file", import.meta.url)`, a module's own URL holds wherever a bundler moves it.
import type { Job, Reply } from "./encode.js";
import { encode } from "./uastc.js";

export const url = import.meta.url;

const scope: unknown = Reflect.get(globalThis, "WorkerGlobalScope");
if (typeof scope === "function" && globalThis instanceof scope) {
  // The encoder reports every image's progress on stdout, which Emscripten writes to console.log; nothing else here logs.
  console.log = () => {};
  addEventListener("message", (event: MessageEvent<Job>) => {
    encode(event.data).then(
      (file) => reply({ file }, [file.buffer]),
      (error: unknown) => reply({ error: error instanceof Error ? error.message : String(error) }),
    );
  });
}

const reply = (message: Reply, transfer: Transferable[] = []) => postMessage(message, { transfer });
