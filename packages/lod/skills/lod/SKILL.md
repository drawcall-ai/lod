---
name: lod
description: Use @drawcall/lod for cached, progressively loaded levels of detail in three.js WebGPURenderer scenes. Covers model and procedural assets, mesh simplification, baked meshes, impostors, instanced crowds, wind, interior mapping, asset preparation and capturing fully loaded views; not WebGLRenderer or skinned animation.
---

# Level of detail with @drawcall/lod

## Start with the loader

Give the host's `LodLoader` an asset URL and the representations to derive from it. Use `.glb` or `.gltf` for stored models and `.glts` for procedural assets. Put generation parameters in the asset URL's query: each distinct query is a distinct cache identity. Build a `Lod` from the returned levels for an independently placed object, or an `InstancedLod` for repeated objects with per-instance matrices and colours.

`loadAsync` resolves with the coarsest drawable level ready; finer levels load when the camera needs them. On a cache miss a derived level is built only when it loads, from a fresh run of the source, so a cold far view builds only the coarsest level. Give finer derived levels an explicit `maxPixels`: one without it is built with the ladder, because its default threshold is measured from the built level. Include an impostor or baked mesh as the coarsest drawable when an overview should avoid constructing the source. A simplified coarsest level also loads the source for its original materials; a source-only ladder loads its source eagerly. Prefer baked or impostor middle levels for an expensive `.glts`: a simplified level brings the script run forward to that viewing range.

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

Follow the [vitecache skill](https://github.com/drawcall-ai/vitecache/blob/main/packages/vitecache/skills/vitecache/SKILL.md) to configure the host. `LodLoader` writes each derived level to the cache directory when the app first loads that level under the Vite dev server with the vitecache plugin; `vite build` does not generate them. Before deploying, load every deployed URL and level list in development and bring each level into view, or call the `load` of every deferred level `loadAsync` returns; then deploy the cache directory together with the original assets. A deployed miss builds the missing level in the browser each time it loads, without persisting it. When the app is deployed under a sub-path, pass that cache location to `LodLoader`.

Edits to the script, its helpers, packages and loaded files invalidate the derived levels; no dependency list is needed. A level rebuilds on every load when its source or anything the script loads cannot be tied to a project file: packages imported from a CDN at runtime or not installed by the app, resources from another origin, and same-origin URLs without a file, such as server routes.

Cache expensive generation inside a `.glts` asset, such as geometry, rooms or generated texture data that would otherwise stall the first approach, as the GLTS skill describes; leave cheap generation uncached. Use the `encodeMeshAsync` / `decodeMeshAsync` codec for asset-owned geometry caches. The GLTS build does not warm `LodLoader`'s derived levels.

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

A missing level draws as the nearest ready coarser representation, skipping empty levels, or as the nearest finer one if none is ready; a crowd never pays for detail its view does not select. Requests follow the visible view and begin ahead of the transition. Keep the resources used by a deferred load alive until it finishes.

For direct preparation and storage outside `LodLoader`, combine `simplify`, `bakeMesh`, or `bakeImpostor` with the corresponding codecs and drawing objects. Use `ImpostorMesh` directly when copies stay distant throughout their lifetime. For external detail systems, combine an empty near level with a coarse representation and use `levelOf` or level visibility to decide where to supply detail.

## Prepare assets that survive transitions

Ship source models with deduplicated textures, sized to their on-screen use and GPU-compressed as KTX2, using established tools such as gltf-transform. Levels upload about one uncompressed 2048² texture per frame, and variants that each carry their own uncompressed 2048² textures add up to gigabytes of uploads and long waits before a close view is complete. Use instance colour variation when it can replace separately textured variants.

Keep sources, simplified geometry, low shells and interiors in a consistent coordinate system. A ground-level pivot helps upright repeated assets.

Author foliage with alpha-tested cutouts and colour beyond the visible texture edges. The package supplies no foliage material: give cut-out source materials alpha to coverage and an alpha that holds coverage in smaller mips, in the view and the shadow maps, or distant leaves thin out and vanish. Inspect the source at distance before baking: dark transparent texels can darken small mips and every derived representation. Match visual effects across representations so foliage does not change lighting at a transition.

Match a low shell to the source's occupied shape and keep it inside the source's bounds: `LodLoader` rejects a level that reaches beyond them. Preserve important silhouette features and remove faces that will never be seen. Generate shell and source from the same parameters when possible. Keep rooms separate while authoring, with their boundaries just behind windows and furnishings near visible walls; include rooms in the detailed source when they should appear in the near view too.

For dense cover, combine near individuals with a baked distant patch. Jitter position and rotation to avoid aligned gaps, preserve continuity across tile borders, and use side walls only on exposed boundaries. An empty far level can stop drawing individuals once the patch carries their appearance.

## Wait for a view before a screenshot

Levels load as the camera comes to need them, so a frame drawn soon after loading still shows coarser stand-ins. To capture one view correctly, even with nothing cached, place the camera, keep the frame loop running, and await `ready()` on every visible `Lod` and `InstancedLod`, together with any other streamed content in view, such as a terrain; then capture a frame. A cold cache builds only the levels that view selects. After moving the camera, await again. A hidden owner is never updated, so its `ready()` waits until it is shown.

```ts
import { InstancedLod, Lod } from "@drawcall/lod";

camera.position.copy(viewpoint);
const lods: (Lod | InstancedLod)[] = [];
scene.traverseVisible((node) => {
  if (node instanceof Lod || node instanceof InstancedLod) lods.push(node);
});
await Promise.all(lods.map((lod) => lod.ready()));
// the frame loop keeps rendering; capture the next frame
```

## Tune the complete scene

Tune transitions in the intended viewport with `Lod.debug`, then inspect motion through them. Use `Lod.quality` for a scene-wide adjustment and individual thresholds for particular assets. Give an impostor bake the intended screen size at its handover, then inspect its coverage and colour from several angles.

Group nearby copies into spatial regions. Broad batches can lose useful culling, while tiny batches spend too much time submitting draws. Reuse instance slots and update changed matrices or colours instead of rebuilding whole crowds. Count material groups as well as triangles; an atlas alone does not combine draws. Each distinct material structure costs a pipeline compile on the first view, so variants should share material structure.

Levels cast into three's shadow maps, not into a light whose shadow map has been replaced by a custom shadow node. An `InstancedLod` draws into each view, shadow maps included, only the instances inside it, at the level the map's texels resolve, so shadow casting costs about what the map can show. When it still dominates, turn `castShadow` off in `onLevel` on the levels that matter least to the shadow, such as small plants.

Judge impostors by covered screen area and overlap as well as triangle count. Compare individual cards with baked patches for dense cover, and inspect parallax and mip quality during transitions.

Compare cold startup, warm startup and first traversal under the same camera movement, viewport, shadows, wind and thresholds. Keep expensive diagnostic overlays outside measurements. A warm repeat does not reveal first-use work, and fewer draws can still lose to worse culling, shading or memory costs.
