# @drawcall/lod

Level of detail for Three.js. Build simplified meshes, baked low-poly meshes, and impostors, then switch between them by on-screen size with smooth dithered fades. Supports individual objects and instanced scenes.

Requires Three.js `WebGPURenderer` (`three/webgpu`).

```sh
npm install @drawcall/lod three
```

Load a model into an existing Three.js scene. With a warm cache, the coarse level draws first and finer levels load as the camera approaches:

```ts
import { Lod, LodLoader } from "@drawcall/lod";

const loader = new LodLoader();
const levels = await loader.loadAsync("/models/tree.glb");
scene.add(new Lod(levels));
```

Configure [vitecache](https://github.com/drawcall-ai/vitecache) in the host and ship its generated cache files. A cache miss builds the levels once; warm loads fetch and decode them. Procedural sources and named custom materials use the same loader.

Choose generated or authored levels to suit your assets. The [LOD skill](https://github.com/drawcall-ai/lod/blob/main/packages/lod/skills/lod/SKILL.md) covers asset choices, caching, lazy loading, wind, and scene integration. It also ships with the package at `skills/lod/SKILL.md`.

The [city example](https://github.com/drawcall-ai/lod/tree/main/examples/city) demonstrates a large scene with buildings, vegetation, and small props.
