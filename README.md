# @drawcall/lod

Level of detail for Three.js. Build simplified meshes, baked low-poly meshes, and impostors, then switch between them by on-screen size with smooth dithered fades. Supports individual objects and instanced scenes.

Requires Three.js `WebGPURenderer` (`three/webgpu`).

```sh
npm install @drawcall/lod three typegpu
```

Load a model into an existing Three.js scene. Each level loads once the camera needs it, finer ones as the camera approaches. Make one `LodGpu` per renderer once it is initialised and give it to every `Lod` and `InstancedLod` drawing with that renderer; dispose it after them:

```ts
import { CachedLodLoader, Lod, LodGpu } from "@drawcall/lod";

await renderer.init();
const gpu = new LodGpu(renderer);
const levels = await new CachedLodLoader().loadAsync("/models/tree.glb");
scene.add(new Lod(levels, gpu));
```

Add the [vitecache](https://github.com/drawcall-ai/vitecache) Vite plugin to the host. It finds every load in the app's source and builds its levels in Node, during development and `vite build`, so pages read them instead of building them. For procedural assets, pass a `.glts` URL and register a GLTSLoader on the page's loading manager.

Choose derived levels to suit your assets. The [LOD skill](https://github.com/drawcall-ai/lod/blob/main/packages/lod/skills/lod/SKILL.md) covers asset choices, caching, lazy loading, wind, and scene integration. It also ships with the package at `skills/lod/SKILL.md`.

The [city example](https://github.com/drawcall-ai/lod/tree/main/examples/city) demonstrates a large scene with buildings, vegetation, and small props, its ground cover scattered around the camera by a compute pass of its own.
