import { fileURLToPath } from "node:url";
import { build, defineConfig, type Plugin } from "vite";

const entry = fileURLToPath(new URL("../../packages/impostor/src/index.ts", import.meta.url));

/**
 * Serves the package as if it were on a CDN, for GLTS scripts that import
 * `@drawcall/impostor@<version>`: GET /esm/@drawcall/impostor@* answers with an ESM
 * bundle of the package source, `three` left as a bare import for the loader to
 * rewrite, everything else inlined. Load with `new GLTSLoader(manager, { cdnURL: "<origin>/esm/" })`.
 */
function impostorCdn(): Plugin {
  return {
    name: "impostor-cdn",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/esm/")) return next();
        // Everything else (Three.js addons, npm packages) comes from the real CDN.
        if (!req.url.startsWith("/esm/@drawcall/impostor@")) {
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
          if (!chunk || chunk.type !== "chunk") throw new Error("impostor-cdn: no entry chunk");
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(chunk.code);
        } catch (error) {
          res.statusCode = 500;
          res.end(String((error as Error).stack ?? error));
        }
      });
    },
  };
}

// The lab imports the package source directly so shader edits hot-reload.
export default defineConfig({
  plugins: [impostorCdn()],
  resolve: {
    alias: { "@drawcall/impostor": entry },
    dedupe: ["three"],
  },
  build: { target: "es2022" },
});
