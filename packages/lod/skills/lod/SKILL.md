---
name: lod
description: Use @drawcall/lod for cached, progressively loaded levels of detail in three.js WebGPURenderer scenes. Covers model and procedural assets, LODs inside .glts assets, mesh simplification, baked meshes, impostors, instanced copies, wind, interior mapping, asset preparation and capturing fully loaded frames; not WebGLRenderer or skinned animation.
---

# Level of detail with @drawcall/lod

## Start with the loader

Give a `CachedLodLoader` an asset URL and the representations to derive from it. Use `.glb` or `.gltf` for stored models and `.glts` for procedural assets. Put generation parameters in the asset URL's query: each distinct query is a distinct cache identity. Build a `Lod` from the returned levels. A `Lod` is driven like three's `InstancedMesh`: `new Lod(levels)` is one object at the Lod's own transform, and `new Lod(levels, count)` draws `count` copies placed by `instanceMatrix` and tinted by `instanceColor`.

A `Lod` needs no renderer to be made, and neither does `CachedLodLoader`. It draws with the first `WebGPURenderer` that renders it, on WebGPU only: on the WebGL2 fallback it reports an error and draws nothing. Another renderer drawing it is its error, so a second renderer, such as a minimap's, needs Lods of its own.

`loadAsync` resolves with the ladder before its levels load; each level loads when a camera first needs it. A level the cache lacks is built when it first loads, so a far camera builds only the coarse levels it needs. Give simplified and baked levels an explicit `maxPixels`: without one, a level is built with the ladder to measure its default. A simplified level also loads the source for its original materials; a source-only ladder loads its source eagerly. Prefer baked or impostor middle levels for an expensive `.glts`: a simplified level brings the script run forward to that viewing range.

Choose levels from the asset's silhouette, materials and expected viewing range. Alpha-tested leaf cards often work best as source → impostor; a simplified level has fewer of them, whole and enlarged to the same coverage, so at a low ratio its foliage reads coarser than the source up close. Hard-surface props often suit source → simplified → impostor. Detailed structures can use source → baked shell → impostor, with interiors supplied separately for windows. A very heavy source, such as a two-million-triangle scan, needs a simplified level between source and impostor, or every copy in mid range draws the full mesh. Add an empty final level when the object should disappear at distance.

Register the source loaders on the page's loading manager before loading: a `GLTSLoader` for `.glts` URLs, and a `GLTFLoader` with the decoders for models compressed with Draco or KTX2. Follow the [GLTS skill](https://github.com/drawcall-ai/glts/blob/main/packages/glts/skills/glts/SKILL.md) for script authoring and resource lifetimes. The package carries its own workers and WebAssembly; it needs no Vite configuration beyond the vitecache plugin.

This example draws many copies of one procedural asset. `positions` contains their placements in the Lod's space and `scene` is the application's scene.

```ts
import { LoadingManager, Matrix4 } from "three/webgpu";
import { GLTSLoader } from "@drawcall/glts";
import { CachedLodLoader, Lod } from "@drawcall/lod";

const manager = new LoadingManager();
manager.addHandler(/\.glts$/, new GLTSLoader(manager));
const levels = await new CachedLodLoader(manager).loadAsync({
  url: "/trees/oak.glts?seed=2",
  levels: [
    { type: "impostor", layout: "hemi", maxPixels: 120, draw: { parallax: 2 } },
    { type: "empty", maxPixels: 4 },
  ],
});
const trees = new Lod(levels, positions.length);

const matrix = new Matrix4();
positions.forEach((position, i) => trees.setMatrixAt(i, matrix.makeTranslation(position)));
trees.instanceMatrix.needsUpdate = true;
scene.add(trees);
```

Supply authored low shells and baking interiors as asset URLs on a baked level; both resolve relative to the source asset as ordinary URLs, so a query-only value replaces the source's whole query. For a variant of the same script, repeat the source's generation parameters, for example the source URL plus `&part=low`. The source asset should be complete at full detail; a baking interior supplies room structure for the distant windows. Author all three in the same coordinate system.

## Give a .glts asset its own levels

A `.glts` script can draw its asset at levels of detail, so that every glts host gets them without knowing of lod. Keep the detailed asset in a script of its own, here `./model.glts` beside the wrapping script; load its ladder with the wrapping script's `loadingManager`, which resolves URLs relative to the script, after giving that manager the script's `gltsLoader` for `.glts` sources. Add a `Lod` of it to the script's scene, tracked by the same manager, so that a host waiting on its loads, such as the glts CLI rendering the script, waits for the levels its cameras need:

```ts
import { gltsLoader, loadingManager, onDispose, scene } from "@drawcall/glts";
import { CachedLodLoader, Lod } from "@drawcall/lod";

loadingManager.addHandler(/\.glts$/i, gltsLoader);
const levels = await new CachedLodLoader(loadingManager).loadAsync({
  url: "./model.glts",
  levels: [
    { type: "impostor", maxPixels: 120 },
    { type: "empty", maxPixels: 4 },
  ],
});
const lod = new Lod(levels, 1, { manager: loadingManager });
scene.add(lod);
onDispose(() => lod.dispose());
```

A host that draws the asset many times calls `gltsLoader.loadInstancesAsync(url, count)`; glts hands that asset's `instanceMatrix`, `instanceColor`, `count`, `boundingBox` and `clusters` to the Lod, which then draws every copy.

## Cache every level

Follow the [vitecache skill](https://github.com/drawcall-ai/vitecache/blob/main/packages/vitecache/skills/vitecache/SKILL.md) to add its plugin and to write loads it finds: call `loadAsync` on `new CachedLodLoader(...)`, or on a variable initialized with one, with a literal request, one load per ladder the app uses. Constructor options, such as the loading manager and `onLevel`, change nothing stored. When the app is deployed under a sub-path, pass that location as `new CachedLodLoader(manager, { basePath })`.

The plugin repeats each load in Node, where the loader builds every level of the ladder and saves each with the public files its loads read and the versions of three and of the packages its `.glts` sources import; changing any of them rebuilds the levels, and pages read them. There, URLs such as `/trees/oak.glts` load from the app's `public` directory, `.glts` sources run with the packages the app installs, and bakes draw on a GPU through [@drawcall/webgpu](https://github.com/drawcall-ai/webgpu/blob/main/skills/webgpu/SKILL.md). Write asset URLs from the site root, and keep sources free of the DOM: they get WebGPU, `fetch` of the app's public files, image decoding and classic workers, but no `document` or 2D canvas. A load that fetches any other URL, or a source that imports a module from a CDN, fails the build, since no stored level could be checked against it.

A page that misses, for a load the plugin could not see, builds the level each time it loads, without saving it.

## Place, share and dispose levels

Load an asset once and build a `Lod` per spatial region from its levels, each with its own placements and colours; clone a `Lod` for a further copy with its own attributes. Reuse the loaded levels across Lods; adjust each Lod's resolved thresholds through its `levels`. Lods made from the same levels share geometry, materials, textures and deferred loads. Disposing a `Lod` frees only what it made of its levels: objects you give or load are yours to dispose once every Lod drawing them is disposed, while `CachedLodLoader` frees what it loaded, and the renderer it baked with, when the last Lod holding its levels is disposed.

Use the loader's `onLevel` option for application effects and shadow settings, `castShadow` and `shadowSide` included. Put source generation and its materials in the asset so that the same URL also loads correctly outside the LOD host.

Levels draw with copies of the source's materials, made once through three's `clone`. A custom material class must carry its own state in `copy`, and changes meant to reach drawn levels belong in shared TSL uniforms rather than in properties set on the original afterwards.

Apply a shared `Wind` after assembling a LOD and before its first render; arriving levels inherit the effect. A `Lod` that has rendered refuses wind: its shaders would build in a frame.

Levels are chosen by on-screen size in CSS pixels on the actual render target, so a lower renderer pixel ratio saves shading, not geometry. Compile the initial scene with the actual camera and renderer before revealing it. Render every frame while finer levels load: they upload and compile only inside renders.

## Place instances, and bound them

Edit instances as on an `InstancedMesh`: `setMatrixAt` and `setColorAt`, then set the attribute's `needsUpdate`; with `addUpdateRange`, only those ranges upload. Assigning a new `instanceMatrix` or `instanceColor` takes effect at the next render; `count` draws the first `count` instances. A matrix of scale 0 draws nothing, but prefer `count` and smaller Lods over parking many instances at scale 0.

Each camera loads the levels, and shows the level meshes, that the instances' bounds can need. Without `clusters`, the bounds are `boundingBox` if set, else what the CPU measures of the matrices; reaching from the camera to the horizon, they load every level. Give a Lod that spans a large area `clusters`: disjoint ranges of instances, each with a `boundingBox` in the Lod's space and, where known, `minScale` and `maxScale`. Each cluster is culled and chooses levels on its own, and only instances inside a cluster draw.

When a compute pass of yours writes the instances, assign a `StorageInstancedBufferAttribute` (`instancedArray(n, "mat4")`'s value) as `instanceMatrix`, and a four-float one as `instanceColor`. The Lod reads them in place every frame; no `needsUpdate` is needed. The CPU cannot read them, so set `boundingBox` or `clusters` yourself: without either, every level loads and the Lod warns once. When your pass also decides how many of a cluster's instances are live, from its start, set the cluster's `liveCount` to `{ attribute, index }`, the u32 your pass writes into a `StorageBufferAttribute` that all of the Lod's clusters share, so that only those are sorted and drawn. `count` remains the most the range holds. `computeBoundingBox`, `getLevelAt` and `raycast` work on CPU matrices only.

A Lod's `instanceMatrix` must fit one storage binding of the device: split large instance sets across Lods, or raise `maxStorageBufferBindingSize` in the renderer's `requiredLimits`.

Give a Lod a `cullDistance` to thin it out towards a distance instead of cutting it off. `scaleSurvivors` enlarges the copies that remain so that small things like grass cover about as much; leave it off for objects whose size reads, such as trees. Thinning does not change which levels load: let the ladder's last drawn level end near `far`, or add an empty level there.

In this example `grass` is a Lod, `camera` the camera it thins from, and `matrices` and `bounds` a compute pass's instance matrices and the box they lie in.

```ts
grass.cullDistance = { camera, near: 35, far: 60, scaleSurvivors: true };
grass.instanceMatrix = matrices;
grass.boundingBox = bounds;
```

## Assemble levels you already have

Pass levels in finest-to-coarsest order. An empty object can be a deliberate culled level. A ladder needs measurable bounds.

Describe a deferred representation with a load function, bounds and a transition height. The function returns the object already placed in the Lod's space; the bounds cover it in that same space, including its children. For a cached impostor, decode the atlas and return an `ImpostorMesh` with the intended draw settings.

Here, `loadDetailedMesh` loads the detailed object, `sourceBox` describes its bounds in the Lod's space, and `coarseMesh` is already available.

```ts
import { Lod } from "@drawcall/lod";

const object = new Lod([{ load: loadDetailedMesh, maxPixels: Infinity, box: sourceBox }, { object: coarseMesh }]);
scene.add(object);
```

A level fades in over the coarser one drawn in its place once it arrives. A Lod loads every level its instances' bounds can need for a camera (see above). Levels are drawn as instanced meshes, so a level may not contain a three `LOD`, an `InstancedMesh` other than an `ImpostorMesh`, or lines, points and sprites. The resources a deferred load uses must stay alive until it finishes.

For direct preparation and storage outside `CachedLodLoader`, combine `simplify`, `bakeMesh`, or `bakeImpostor` with the corresponding codecs and drawing objects. Bakes that draw take a renderer made with `createBakeRenderer`, never the application's, whose canvas a bake would draw over. Use `ImpostorMesh` directly when copies stay distant throughout their lifetime. For external detail systems, combine an empty near level with a coarse representation and ask `lod.getLevelAt(index, camera)` where to supply detail.

## Prepare assets that survive transitions

Ship source models with deduplicated textures, sized to their on-screen use and GPU-compressed as KTX2, using established tools such as gltf-transform. Uploads are paced per frame, so variants that each carry their own uncompressed 2048² textures add up to gigabytes of uploads and long waits before a close-up is complete. Use instance colour variation when it can replace separately textured variants.

Author sources, simplified geometry, low shells and interiors in one coordinate system. A ground-level pivot helps upright repeated assets.

Author foliage with alpha-tested cut-outs and colour beyond the visible texture edges. Cut-out source materials need alpha to coverage and an alpha that holds coverage in smaller mips, for the camera and the shadow maps, or distant leaves thin out and vanish. Fill a cut-out's transparent texels with the mean colour of its opaque texels, as the last step, in a format that preserves colour under zero alpha: lossy webp discards it, PNG preserves it, and a KTX2 encoder needs checking. Mips average those texels in, so left dark they darken the distant source while an impostor, baked from full detail, holds its colour and turns brighter where the two switch. Dilating from the edges instead spreads their often dark fringe. Match visual effects across representations so foliage does not change lighting at a transition.

Use the package's foliage material for leaves, grass and other thin plant parts: it gives cut-outs that coverage and lets sunlight through to a leaf's shaded side, so back-lit plants glow instead of turning black. Convert a loaded plant model with `foliageModel`, or make a procedural asset's leaf material a `Foliage` with `foliage`. An impostor baked from either holds no light passing through its leaves: apply `foliageLevels` with the same translucency in the loader's `onLevel`, so that the impostor lights like its source at the switch.

Custom shading on an impostor has little room: an impostor uses close to WebGPU's 16 varyings, so a colour node of your own may find none left; read per pixel what a mesh would carry. An impostor's `normalView` is one unit normal per texel, however many leaves that texel averages. For a lighting term of your own, read `cosine(impostor.material.spread, lightDirection)`, the mean of the clamped cosine over those leaves. Here `impostor` is the level's `ImpostorMesh` and `lightDirection` the view-space direction towards the light.

Match a low shell to the source's occupied shape and fit it within the source's bounds: `CachedLodLoader` rejects a level that reaches beyond them. Preserve important silhouette features and remove faces that will never be seen. Generate shell and source from the same parameters when possible. Author rooms separately, with their boundaries just behind windows and furnishings near visible walls; include rooms in the detailed source when they should appear up close too.

For dense cover, combine near individuals with a baked distant patch. Jitter position and rotation to avoid aligned gaps, preserve continuity across tile borders, and use side walls only on exposed boundaries. An empty far level can stop drawing individuals once the patch carries their appearance.

## Wait for a complete frame before a screenshot

Levels load as the camera comes to need them, so a frame drawn soon after loading can lack them. Give the Lods a `manager` of their own, so that it tracks only them: each holds an item there while the levels its cameras need load, compile or fade in, and ends it once they are complete. Render the `Scene` that holds them each frame, since a Lod loads nothing before such a render.

To capture one frame, even with nothing cached, place the camera and render, then wait a frame; while the manager is loading, compile with `renderer.compileAsync(scene, camera)`, render again and wait a frame; capture after a quiet frame, one in which no item started or ended. After moving the camera, wait again. In this example `levels` and `treeLevels` are ladders from `CachedLodLoader`, `instanceMatrix` an attribute of tree matrices, and `viewpoint` the camera position to capture.

```ts
import { LoadingManager } from "three/webgpu";
import { Lod } from "@drawcall/lod";

const manager = new LoadingManager();
const lod = new Lod(levels, 1, { manager });
const trees = new Lod(treeLevels, instanceMatrix.count, { manager });
trees.instanceMatrix = instanceMatrix;
scene.add(lod, trees);

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
// The last render drew the complete frame: capture it.
```

Loaded levels stay until their Lod is disposed, which nothing does for you: in a world larger than memory, dispose the Lods the camera has left far behind.

## Tune the complete scene

Tune transitions in the intended viewport with `Lod.debug`, then inspect motion through them. Use `Lod.quality` for a scene-wide adjustment and individual thresholds for particular assets. Give an impostor bake the intended screen size at its switch, then inspect its coverage and colour from several angles. Compare both sides of a switch under one camera, drawing each with the Lod's `forceLevel`, looking toward the sun as well as away: a mismatch can show in one light direction only.

Group nearby copies into spatial regions. Broad batches can lose useful culling, while tiny batches spend too much time submitting draws. Move changed instances, marking only their update ranges, instead of rebuilding whole Lods. Count material groups as well as triangles; an atlas alone does not combine draws. Each distinct material structure costs a pipeline compile on first use, so variants should share material structure.

Avoid custom shadow nodes on lights that LOD objects should cast into. When shadow casting dominates, turn `castShadow` off in `onLevel` on the levels that matter least to the shadow, such as small plants.

Judge impostors by covered screen area and overlap as well as triangle count. Compare individual cards with baked patches for dense cover, and inspect parallax and mip quality during transitions.

Compare cold startup, warm startup and first traversal under the same camera movement, viewport, shadows, wind and thresholds. Leave expensive diagnostic overlays out of measurements. A warm repeat does not reveal first-use work, and fewer draws can still lose to worse culling, shading or memory costs.
