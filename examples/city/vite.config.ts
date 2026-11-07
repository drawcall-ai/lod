import { defineConfig } from "vite";
import { glts } from "@drawcall/glts/vite";
import { vitecache } from "vitecache/vite";

export default defineConfig({
  plugins: [vitecache(), glts()],
  resolve: {
    dedupe: ["three"],
  },
  // Both entry points up front: found one by one, Vite re-bundles mid-load and a page ends up with two copies of three.
  // @drawcall/lod is not aliased to its src: glts() pre-bundles the built package so the page and the GLTS scripts in
  // public/ share one instance, and glts's Node warmup imports that build too. A rebuilt dist needs `vite --force`,
  // which `pnpm city` runs after building lod.
  optimizeDeps: { include: ["three", "three/webgpu", "three/tsl"] },
  build: {
    target: "es2022",
    rollupOptions: { input: { city: "index.html", viewer: "viewer.html" } },
  },
});
