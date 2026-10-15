# @drawcall/lod

Level of detail for three.js. Load a model, get cheaper levels built for it — an
octahedral impostor, a simplified mesh, a baked low-poly mesh — and switch between them
by on-screen size, with a dithered fade so the switch does not pop.

**WebGLRenderer only.** The shaders patch three's WebGL material chunks; WebGPURenderer
is not supported.

```sh
npm install @drawcall/lod three
```

## Usage

```ts
import { LodLoader } from "@drawcall/lod";

const loader = new LodLoader(manager); // a three.js Loader
const tree = await loader.loadAsync("/models/tree.glb"); // source → impostor
scene.add(tree); // the renderer switches levels by itself, shadows included

const rock = await loader.loadAsync({ url: "/models/rock.glb", levels: [{ type: "simplified" }, { type: "impostor" }] });
const house = await loader.loadAsync({
  url: "/models/house.glb",
  levels: [
    { type: "baked", low: "/models/house-low.glb" },
    { type: "impostor", layout: "hemi" },
  ],
});
```

### Which levels for which asset

| Asset                                                                       | Levels                                                                                                                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foliage: trees, bushes, grass, plants — anything of alpha-tested leaf cards | the default: straight to an `impostor` (`layout: "hemi"` if it stands upright). Never a `simplified` level: decimation tears leaf cards apart       |
| Closed hard-surface meshes: props, rocks, vehicles                          | `simplified`, then `impostor`                                                                                                                       |
| Buildings and large hard surfaces                                           | `baked` onto an authored or generated low mesh, then `impostor`; with `interior: "/models/house-rooms.glts"` its windows show the rooms behind them |
| Low-poly props                                                              | `simplified`, or none: an impostor costs more than the mesh                                                                                         |

A `"baked"` level (experimental) is one low-poly mesh with the source's colour, normals
and material values baked into its own textures. Its low mesh has to keep the silhouette
(eaves, chimneys): only surface detail moves into its textures.

`.glb`/`.gltf` load through the manager's handler when one is registered (a GLTFLoader
with Draco), `.glts` through a registered `GLTSLoader` from `@drawcall/glts`. Levels are
built at load time.

For many copies, `loader.loadInstancesAsync(url, count)` gives an `InstancedLod`: one
draw per level and mesh, each instance switching by its own size on screen; place them
with `setMatrixAt`.

Bring your own levels with `new Lod([source, ...levels])` or
`new InstancedLod([source, ...levels], count)`: any `Object3D`, including another `Lod`
(but not inside an `InstancedLod`). `Lod.quality` trades detail for speed globally,
`Lod.debug` tints each level, `lod.forceLevel` pins one.

### Building blocks

The pieces behind the loader are exported too: `simplify` (meshoptimizer), `bakeMesh`
(the baked level), `bakeImpostor` and `ImpostorMesh` (an `InstancedMesh` drawing
thousands of impostors in one call), and `encodeImpostor`/`decodeImpostor` to save
impostors as KTX2.

The package ships a skill for coding agents with the details of when to use which part.

The showcase, `examples/city` (`pnpm city`), flies over a 4 km world from two
kilometres up down to a ladybird on a corn leaf, every kind of content on the levels
that suit it.
