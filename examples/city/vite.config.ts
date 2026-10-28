import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { vitecache } from "vitecache/vite";

// Import the package source directly so library edits hot-reload here.
const entry = fileURLToPath(new URL("../../packages/lod/src/index.ts", import.meta.url));

export default defineConfig({
  plugins: [vitecache()],
  resolve: {
    alias: { "@drawcall/lod": entry },
    dedupe: ["three"],
  },
  // Both entry points up front: found one by one, Vite re-bundles mid-load and a page ends up with two copies of three.
  optimizeDeps: { include: ["three", "three/webgpu", "three/tsl"] },
  build: {
    target: "es2022",
    rollupOptions: { input: { city: "index.html", viewer: "viewer.html" } },
  },
});
