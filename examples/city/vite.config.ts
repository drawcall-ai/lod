import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Import the package source directly so library edits hot-reload here.
const entry = fileURLToPath(new URL("../../packages/lod/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@drawcall/lod": entry },
    dedupe: ["three"],
  },
  build: {
    target: "es2022",
    rollupOptions: { input: { city: "index.html", viewer: "viewer.html" } },
  },
});
