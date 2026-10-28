import { fileURLToPath } from "node:url";
import { build, defineConfig, type Plugin } from "vite";
import { vitecache } from "vitecache/vite";

const entry = fileURLToPath(new URL("../../packages/lod/src/index.ts", import.meta.url));

/**
 * Serves the package as if it were on a CDN, for GLTS scripts that import
 * `@drawcall/lod@<version>`: GET /esm/@drawcall/lod@* answers with an ESM
 * bundle of the package source, `three` left as a bare import for the loader to
 * rewrite, everything else inlined. Load with `new GLTSLoader(manager, { cdnURL: "<origin>/esm/" })`.
 */
function packageCdn(): Plugin {
  return {
    name: "lod-cdn",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/esm/")) return next();
        // Everything else (Three.js addons, npm packages) comes from the real CDN.
        if (!req.url.startsWith("/esm/@drawcall/lod@")) {
          res.statusCode = 302;
          res.setHeader("Location", `https://esm.sh/${req.url.slice("/esm/".length)}`);
          return res.end();
        }
        try {
          const output = await build({
            configFile: false,
            logLevel: "silent",
            build: {
              write: false,
              minify: false,
              target: "es2022",
              lib: { entry, formats: ["es"], fileName: "index" },
              rolldownOptions: { external: ["three"] },
            },
          });
          const results = Array.isArray(output) ? output : [output];
          const chunk = results.flatMap((r) => ("output" in r ? r.output : [])).find((o) => o.type === "chunk" && o.isEntry);
          if (!chunk || chunk.type !== "chunk") throw new Error("lod-cdn: no entry chunk");
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(chunk.code);
        } catch (error) {
          res.statusCode = 500;
          res.end(error instanceof Error ? (error.stack ?? error.message) : String(error));
        }
      });
    },
  };
}

const page = (name: string) => fileURLToPath(new URL(`${name}.html`, import.meta.url));

// The lab imports the package source directly so shader edits hot-reload.
export default defineConfig({
  plugins: [vitecache(), packageCdn()],
  resolve: {
    alias: { "@drawcall/lod": entry },
    dedupe: ["three"],
  },
  // Both entry points up front: found one by one, Vite re-bundles mid-load and a page ends up with two copies of three.
  optimizeDeps: { include: ["three", "three/webgpu", "three/tsl"] },
  build: {
    target: "es2022",
    rolldownOptions: { input: ["index", "bench", "glts", "instanced", "interior", "lod", "switching"].map(page) },
  },
});
