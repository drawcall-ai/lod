import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Import the package source directly so library edits hot-reload here.
const entry = fileURLToPath(new URL("../../packages/impostor/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@drawcall/impostor": entry },
    dedupe: ["three"],
  },
  build: { target: "es2022" },
});
