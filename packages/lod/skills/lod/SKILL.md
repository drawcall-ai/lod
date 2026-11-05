---
name: lod
description: Use @drawcall/lod for cached, progressively loaded levels of detail in three.js WebGPURenderer scenes. Covers model and procedural assets, mesh simplification, baked meshes, impostors, instanced crowds, wind, interior mapping, asset preparation and capturing fully loaded views; not WebGLRenderer or skinned animation.
---

# Level of detail with @drawcall/lod

## Start with the loader

Give the host's `LodLoader` an asset URL and the representations to derive from it. Use `.glb` or `.gltf` for stored models and `.glts` for procedural assets. Put generation parameters in the asset URL's query: each distinct query is a distinct cache identity. Build a `Lod` from the returned levels for an independently placed object, or an `InstancedLod` for repeated objects with per-instance matrices and colours.

`loadAsync` resolves with the ladder before its levels load; each level loads when a view first selects it, and a level still loading draws as a ready coarser one, as the level a copy already showed, or not at all. On a cold cache a derived level is built when it first loads, so a cold far view builds only the coarse levels it selects. Give simplified and baked levels an explicit `maxPixels`: without one, a level is built with the ladder to measure its default. A simplified level also loads the source for its original materials; a source-only ladder loads its source eagerly. Prefer baked or impostor middle levels for an expensive `.glts`: a simplified level brings the script run forward to that viewing range.

Choose levels from the asset's silhouette, materials and expected viewing range. Alpha-tested leaf cards often work best as source → impostor; simplifying the cards can destroy their shape. Hard-surface props often suit source → simplified → impostor. Detailed structures can use source → baked shell → impostor, with interiors supplied separately for windows. A very heavy source, such as a two-million-triangle scan, needs a simplified level between source and impostor, or every copy in mid range draws the full mesh. Add an empty final level when the object should disappear at distance.

Register the source loaders on the loading manager before loading: a `GLTSLoader` for `.glts` URLs, and for `.glb` or `.gltf` models compressed with Draco or KTX2 a `GLTFLoader` configured with those decoders, since `LodLoader`'s fallback decodes meshopt only. Follow the [GLTS skill](https://github.com/drawcall-ai/glts/blob/main/packages/glts/skills/glts/SKILL.md) for the Vite plugin, script authoring and resource lifetimes. The package carries its own workers and WebAssembly; it needs no Vite configuration beyond the vitecache plugin.

This example creates a crowd from one procedural asset. `positions` contains placements in the crowd's space, and `scene` is the application's scene.

```ts
import { LoadingManager, Matrix4 } from "three/webgpu";
import { GLTSLoader } from "@drawcall/glts";
import { InstancedLod, LodLoader } from "@drawcall/lod";

const manager = new LoadingManager();
manager.addHandler(/\.glts$/, new GLTSLoader(manager));
const loader = new LodLoader(manager);
const levels = await loader.loadAsync({
  url: "/trees/oak.glts?seed=2",
  levels: [
    { type: "impostor", layout: "hemi", maxPixels: 120, draw: { parallax: 2 } },
    { type: "empty", maxPixels: 4 },
  ],
});
const trees = new InstancedLod(levels, positions.length);

const matrix = new Matrix4();
positions.forEach((position, index) => {
  trees.setMatrixAt(index, matrix.makeTranslation(position));
});
scene.add(trees);
```

Supply authored low shells and baking interiors as asset URLs on a baked level; both resolve relative to the source asset as ordinary URLs, so a query-only value replaces the source's whole query. For a variant of the same script, repeat the source's generation parameters, for example the source URL plus `&part=low`. The source asset should be complete at full detail; a baking interior supplies room structure for the distant windows. Keep all three in the same coordinate system.

## Put each cache with its computation

Follow the [vitecache skill](https://github.com/drawcall-ai/vitecache/blob/main/packages/vitecache/skills/vitecache/SKILL.md) to configure the host. `LodLoader` writes each derived level to the cache directory when the app first loads that level under the Vite dev server with the vitecache plugin. A deployed miss builds the missing level in the browser each time it loads, without persisting it. When the app is deployed under a sub-path, pass that cache location to `LodLoader`.

To deploy every level prebuilt, load the ladders in a public `.glts` script, which `vite build` runs in Node as the [GLTS skill](https://github.com/drawcall-ai/glts/blob/main/packages/glts/skills/glts/SKILL.md#precomputing-into-the-build) describes. There `LodLoader` builds and saves every level of each ladder it loads, deferred ones included. Request the same URLs and levels as the app, from a helper beside the script that the app imports too; `onLevel` changes nothing cached, so the app adds its effects to the shared requests. Register the contextual `gltsLoader` for `.glts` sources, as the app registers its `GLTSLoader`, and add every level to `scene`: a level can hold a `.glts` source the script loaded, which GLTS requires beneath `scene`.

```ts
// public/precompute.glts
import { gltsLoader, loadingManager, scene } from "@drawcall/glts";
import { LodLoader } from "@drawcall/lod";
import { ladders } from "./ladders.ts";

loadingManager.addHandler(/\.glts$/i, gltsLoader);
const loader = new LodLoader(loadingManager);
for (const ladder of ladders) {
  for (const level of await loader.loadAsync(ladder)) scene.add(level.object ?? (await level.load()));
}
```

Edits to the script, its helpers, packages and loaded files invalidate the derived levels; no dependency list is needed. A level rebuilds on every load when its source or anything the script loads cannot be tied to a project file: packages imported from a CDN at runtime or not installed by the app, resources from another origin, and same-origin URLs without a file, such as server routes. Precomputing such a level fails the build, so install every package the precomputed sources import.

Cache expensive generation inside a `.glts` asset, such as geometry, rooms or generated texture data that would otherwise stall the first approach, as the GLTS skill describes; leave cheap generation uncached. Use the `encodeMeshAsync` / `decodeMeshAsync` codec for asset-owned geometry caches.

## Place, share and dispose levels

Load an asset once and build spatial crowds from its levels, each with its own instance count, placements and colours; clone a `Lod` for further independently placed copies. Reuse descriptors across owners; adjust each owner's resolved thresholds through its `levels` view. Clones and crowds share geometry, materials, textures and deferred loads. Dispose shared resources only after every copy has stopped drawing; disposal does not count references.

Use `onLevel` for application effects and shadow settings. Set `castShadow` and `shadowSide` there rather than after a level arrives: a level compiles its draws, including those into the shadow maps the scene already draws into, before it arrives, and a setting changed afterwards compiles its shadow pipeline in the middle of a frame. Keep source generation and its materials in the asset so that the same URL also loads correctly outside the LOD host.

Levels draw with copies of the source's materials, made once through three's `clone`. A custom material class must carry its own state in `copy`, and changes meant to reach drawn levels belong in shared TSL uniforms rather than in properties set on the original afterwards.

Apply a shared `Wind` after assembling a LOD and before rendering; arriving levels inherit the effect. Apply it separately to nested LODs and independently managed batches.

Levels are chosen by on-screen size in CSS pixels on the actual render target, so a lower renderer pixel ratio saves shading, not geometry. Seed the camera with `setViewportHeight` before preparing its first view, and refresh that height after resizing views whose levels may all be culled. Compile the initial scene with the actual camera and renderer before revealing it. Continue drawing while finer levels load so preparation can use the same rendering context.

## Assemble levels you already have

Pass levels in finest-to-coarsest order. An empty object can be a deliberate culled level. A ladder needs measurable bounds; when all levels are deferred, it draws nothing until a level is ready.

Describe a deferred representation with a load function, bounds and a transition height. The function returns the object already placed in the owner's space; the bounds cover it in that same space, including its children. For a cached impostor, decode the atlas and return an `ImpostorMesh` with the intended draw settings.

Here, `loadDetailedMesh` loads the detailed object, `sourceBox` describes its bounds in the owner's space, and `coarseMesh` is already available.

```ts
import { Lod } from "@drawcall/lod";

const object = new Lod([{ load: loadDetailedMesh, maxPixels: Infinity, box: sourceBox }, { object: coarseMesh }]);
scene.add(object);
```

A missing level draws as the nearest ready coarser level, skipping empty ones; else each copy keeps drawing the level it already showed; else nothing. A copy never starts drawing a level finer than it selects. Each copy requests the levels its distance and screen size select, whichever way the camera faces, so shadow casters out of view and a turning camera find their levels loaded; a crowd never pays for detail no copy selects. A level that replaces a drawn one, including a kept one, fades in over it; one that replaces nothing draws at once. Keep the resources used by a deferred load alive until it finishes.

For direct preparation and storage outside `LodLoader`, combine `simplify`, `bakeMesh`, or `bakeImpostor` with the corresponding codecs and drawing objects. Use `ImpostorMesh` directly when copies stay distant throughout their lifetime. For external detail systems, combine an empty near level with a coarse representation and use `levelOf` or level visibility to decide where to supply detail.

## Prepare assets that survive transitions

Ship source models with deduplicated textures, sized to their on-screen use and GPU-compressed as KTX2, using established tools such as gltf-transform. Levels upload about one uncompressed 2048² texture per frame, and variants that each carry their own uncompressed 2048² textures add up to gigabytes of uploads and long waits before a close view is complete. Use instance colour variation when it can replace separately textured variants.

Keep sources, simplified geometry, low shells and interiors in a consistent coordinate system. A ground-level pivot helps upright repeated assets.

Author foliage with alpha-tested cutouts and colour beyond the visible texture edges. The package supplies no foliage material: give cut-out source materials alpha to coverage and an alpha that holds coverage in smaller mips, in the view and the shadow maps, or distant leaves thin out and vanish. Inspect the source at distance before baking: dark transparent texels can darken small mips and every derived representation. Match visual effects across representations so foliage does not change lighting at a transition.

Match a low shell to the source's occupied shape and keep it inside the source's bounds: `LodLoader` rejects a level that reaches beyond them. Preserve important silhouette features and remove faces that will never be seen. Generate shell and source from the same parameters when possible. Keep rooms separate while authoring, with their boundaries just behind windows and furnishings near visible walls; include rooms in the detailed source when they should appear in the near view too.

For dense cover, combine near individuals with a baked distant patch. Jitter position and rotation to avoid aligned gaps, preserve continuity across tile borders, and use side walls only on exposed boundaries. An empty far level can stop drawing individuals once the patch carries their appearance.

## Wait for a view before a screenshot

Levels load as the camera comes to need them, so a frame drawn soon after loading can lack them: a missing level draws as a ready coarser one, as the level a copy already showed, or not at all. Each `Lod` and `InstancedLod` reports to the `manager` it is given: it holds one item while the levels its views need load, install, compile or fade in, and ends it once they are complete, or once its scene renders a frame without updating it; a failed level is an item error. Give the owners a manager of their own so that it tracks only them, and render the `Scene` that holds them, with every camera that views it each frame: an owner loads nothing before such a render, and a camera that skips frames lets the item end and start again. The manager hears of the item once the render returns. To capture one view, even with nothing cached, place the camera and render, then wait a frame; while the manager is loading, compile with `renderer.compileAsync(scene, camera)`, render again and wait a frame, which lets loads, workers and timers run; capture the render after which the manager is idle. A cold cache builds only the levels that viewpoint selects. After moving the camera, wait again. Loaded levels stay until their owner is disposed, which nothing does for you: in a world larger than memory, dispose the owners the camera has left far behind.

```ts
import { LoadingManager } from "three/webgpu";
import { InstancedLod, Lod } from "@drawcall/lod";

const manager = new LoadingManager();
const lod = new Lod(levels, { manager });
const trees = new InstancedLod(treeLevels, positions.length, { manager });

camera.position.copy(viewpoint);
let loading = false;
manager.onStart = () => (loading = true);
manager.onLoad = () => (loading = false);
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
renderer.render(scene, camera);
await frame();
while (loading) {
  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);
  await frame();
}
// The last render drew the complete view: capture it.
```

## Tune the complete scene

Tune transitions in the intended viewport with `Lod.debug`, then inspect motion through them. Use `Lod.quality` for a scene-wide adjustment and individual thresholds for particular assets. Give an impostor bake the intended screen size at its handover, then inspect its coverage and colour from several angles.

Group nearby copies into spatial regions. Broad batches can lose useful culling, while tiny batches spend too much time submitting draws. Reuse instance slots and update changed matrices or colours instead of rebuilding whole crowds. Count material groups as well as triangles; an atlas alone does not combine draws. Each distinct material structure costs a pipeline compile on the first view, so variants should share material structure.

Levels cast into three's shadow maps, not into a light whose shadow map has been replaced by a custom shadow node. An `InstancedLod` draws into each view, shadow maps included, only the instances inside it, at the level the map's texels resolve, so shadow casting costs about what the map can show. When it still dominates, turn `castShadow` off in `onLevel` on the levels that matter least to the shadow, such as small plants.

Judge impostors by covered screen area and overlap as well as triangle count. Compare individual cards with baked patches for dense cover, and inspect parallax and mip quality during transitions.

Compare cold startup, warm startup and first traversal under the same camera movement, viewport, shadows, wind and thresholds. Keep expensive diagnostic overlays outside measurements. A warm repeat does not reveal first-use work, and fewer draws can still lose to worse culling, shading or memory costs.
