---
name: lod
description: Use @drawcall/lod for cached, progressively loaded levels of detail in three.js WebGPURenderer scenes. Covers model and procedural assets, LODs inside .glts assets, mesh simplification, baked meshes, impostors, instanced copies, wind, interior mapping, choosing tree and grass representations, diagnosing frame cost and capturing fully loaded frames; not WebGLRenderer or skinned animation.
---

# Level of detail with @drawcall/lod

## Start with the loader

Give a `CachedLodLoader` an asset URL and the representations to derive from it. Use `.glb` or `.gltf` for stored models and `.glts` for procedural assets. Put generation parameters in the asset URL's query: each distinct query is a distinct cache identity. Build a `Lod` from the returned levels. A `Lod` is driven like three's `InstancedMesh`: `new Lod(levels)` is one object at the Lod's own transform, and `new Lod(levels, count)` draws `count` copies placed by `instanceMatrix` and tinted by `instanceColor`.

For procedural geometry in a Vite application module, pass an inline `source` function. Return a fresh Three.js object each time so the loader can dispose it. Dynamic imports inside the function also run during cache warming. In a public `.glts` script, use an asset URL because the cache plugin transforms inline functions only in application modules.

```ts
const levels = await new CachedLodLoader(manager).loadAsync({
  source: async ({ manager }) => {
    const { makeTree } = await import("./tree.js");
    return makeTree(manager);
  },
  levels: [{ type: "impostor", resolution: 128 }],
});
```

A `Lod` needs no renderer to be made, and neither does `CachedLodLoader`. It draws with the first `WebGPURenderer` that renders it, on WebGPU only: on the WebGL2 fallback it reports an error and draws nothing. Another renderer drawing it is its error, so a second renderer, such as a minimap's, needs Lods of its own.

`loadAsync` resolves with the ladder before its levels load; each level loads when a camera first needs it. A level the cache lacks is built when it first loads, so a far camera builds only the coarse levels it needs. Choose `maxPixels` for simplified and baked levels by looking at the transition. The default of half the finer neighbour's height does not measure visual error. A prebuilt impostor already derives its threshold from its fitted atlas. A simplified level also loads the source for its original materials; a source-only ladder loads its source eagerly. Prefer baked or impostor middle levels for an expensive `.glts`: a simplified level brings the script run forward to that viewing range.

Choose levels by the silhouette and materials that must survive the switch. Hard-surface props often suit source → simplified → impostor. Buildings with windows can use a baked shell with an interior. Alpha-tested foliage can go straight to an impostor once its branches or blades stop reading individually. If many copies still draw full geometry at that distance, try a simplified middle level. Add an empty final level when the object should disappear.

Nothing draws until the coarsest level that draws has loaded, near views included, so its bytes decide how soon any view appears. For a fast first view, end the drawn ladder with a level sized for the few pixels a far object covers, such as a 16-pixel impostor or a baked shell with a 64² texture. At that size boxy objects such as buildings read better, in fewer bytes, as a baked shell than as an impostor; foliage, whose silhouette no shell carries, stays an impostor.

Register the source loaders on the page's loading manager before loading: a `GLTSLoader` for `.glts` URLs, and a `GLTFLoader` with the decoders for models compressed with Draco or KTX2. Follow the [GLTS skill](https://github.com/drawcall-ai/glts/blob/main/packages/glts/skills/glts/SKILL.md) for script authoring and resource lifetimes. The package carries its own workers and WebAssembly; it needs no Vite configuration beyond the cache plugin.

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

Follow the [cache skill](https://github.com/drawcall-ai/cache/blob/main/packages/cache/skills/cache/SKILL.md) to add its plugin and to write loads it finds: call `loadAsync` on `new CachedLodLoader(...)`, or on a variable initialized with one, with a literal request, one load per ladder the app uses. Constructor options, such as the loading manager and `onLevel`, change nothing stored. When the app is deployed under a sub-path, pass that location as `new CachedLodLoader(manager, { basePath })`.

The plugin repeats each load in Node, where the loader builds every level of the ladder and saves each with the versions of three and of the packages its `.glts` sources import, and with the public files its loads read, which it records; changing any of them rebuilds the levels, and pages read them. There, URLs such as `/trees/oak.glts` load from the app's `public` directory, `.glts` sources run with the packages the app installs, and bakes draw on a GPU through [@drawcall/webgpu](https://github.com/drawcall-ai/webgpu/blob/main/skills/webgpu/SKILL.md). Write asset URLs from the site root, and keep sources free of the DOM: they get WebGPU, the app's public files through their `loadingManager`, image decoding and classic workers, but no `document` or 2D canvas. A load that requests any other URL through its manager, or a source that imports a module from a CDN, fails the build, since no stored level could be checked against it; a source that fetches without its manager is not served.

A page that misses, for a load the plugin could not see, builds the level each time it loads, without saving it.

## Place, share and dispose levels

Load an asset once and build a `Lod` per spatial region from its levels, each with its own placements and colours; clone a `Lod` for a further copy with its own attributes. Reuse the loaded levels across Lods; adjust each Lod's resolved thresholds through its `levels`. Lods made from the same levels share geometry, materials, textures and deferred loads. Disposing a `Lod` frees only what it made of its levels: objects you give or load are yours to dispose once every Lod drawing them is disposed, while `CachedLodLoader` frees what it loaded, and the renderer it baked with, when the last Lod holding its levels is disposed.

Use the loader's `onLevel` option for application effects and shadow settings, `castShadow` and `shadowSide` included. Put source generation and its materials in the asset so that the same URL also loads correctly outside the LOD host.

For repeated placements, one `Lod(levels, count)` batches across those copies. Each eligible mesh or material group in a level still has its own indirect draw per pass. Separate Lods that share levels also submit separately. GLTS forwarding the host's instances, reusing a material, and packing textures into one atlas all preserve those draw boundaries. When submission dominates, merge compatible static parts that always switch together into one mesh with one material at the source.

Levels draw with copies of the source's materials, made once through three's `clone`. A custom material class must carry its own state in `copy`, and changes meant to reach drawn levels belong in shared TSL uniforms rather than in properties set on the original afterwards.

Apply a shared `Wind` after assembling a LOD and before its first render; arriving levels inherit the effect. A `Lod` that has rendered refuses wind: its shaders would build in a frame.

Levels are chosen by on-screen size in CSS pixels on the actual render target, so a lower renderer pixel ratio saves shading, not geometry. Compile the initial scene with the actual camera and renderer before revealing it. Render every frame while finer levels load: they upload and compile only inside renders.

## Place instances, and bound them

Edit instances as on an `InstancedMesh`: `setMatrixAt` and `setColorAt`, then set the attribute's `needsUpdate`; with `addUpdateRange`, only those ranges upload. Assigning a new `instanceMatrix` or `instanceColor` takes effect at the next render; `count` draws the first `count` instances. A matrix of scale 0 draws nothing, but prefer `count` and smaller Lods over parking many instances at scale 0.

Each camera loads the levels, and shows the level meshes, that the instances' bounds can need. Without `clusters`, the bounds are `boundingBox` if set, else what the CPU measures of the matrices; reaching from the camera to the horizon, they load every level. Give a Lod that spans a large area `clusters`: disjoint ranges of instances, each with a `boundingBox` in the Lod's space and, where known, `minScale` and `maxScale`. Each cluster is culled and chooses levels on its own, and only instances inside a cluster draw. Clusters narrow the work for the existing ladder. They contain no replacement geometry for the group.

When a compute pass of yours writes the instances, assign a `StorageInstancedBufferAttribute` (`instancedArray(n, "mat4")`'s value) as `instanceMatrix`, and a four-float one as `instanceColor`. The Lod reads them in place every frame; no `needsUpdate` is needed. The CPU cannot read them, so set `boundingBox` or `clusters` yourself: without either, every level loads and the Lod warns once. When your pass also decides how many of a cluster's instances are live, from its start, set the cluster's `liveCount` to `{ attribute, index }`, the u32 your pass writes into a storage attribute, such as `instancedArray(n, "uint")`'s value, that all of the Lod's clusters share, so that only those are sorted and drawn. `count` remains the most the range holds. `computeBoundingBox`, `getLevelAt` and `raycast` work on CPU matrices only.

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

For direct preparation and storage outside `CachedLodLoader`, combine `simplify`, `bakeMesh`, or `bakeImpostor` with the corresponding codecs and drawing objects. Bakes and the codecs that encode their maps take a renderer made with `createBakeRenderer`, never the application's, whose canvas a bake would draw over. The codecs store maps as GPU blocks of one format, and a device samples either BC7 or ASTC 4x4: store a file of each and load the one the device's adapter samples. Use `ImpostorMesh` directly when copies stay distant throughout their lifetime. For external detail systems, combine an empty near level with a coarse representation and ask `lod.getLevelAt(index, camera)` where to supply detail.

## Prepare assets that survive transitions

Ship source models with deduplicated textures, sized to their on-screen use and GPU-compressed as KTX2, using established tools such as gltf-transform. Uploads are paced per frame, so variants that each carry their own uncompressed 2048² textures add up to gigabytes of uploads and long waits before a close-up is complete. Use instance colour variation when it can replace separately textured variants.

Filter every texture a material samples linearly, with mipmaps where it is minified; three's `DataTexture` defaults to nearest. While a Lod compiles its levels, one nearest-filtered map can fail the pipelines of other materials ("Binding type in the shader … doesn't match the type in the layout"), and the Lod then stays on a coarser level, reporting `Lod: render pipeline compilation failed`.

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

## Choose levels for trees and grass

For a tree viewed both up close and across a forest, try source → simplified whole tree → directional whole-tree impostor. This works with a single tree model, including one with foliage and wood combined. Set the simplified level's `maxPixels` so the simplifier can remove triangles inside tessellated leaf planes while keeping their borders. Then raise the **first impostor's** `maxPixels` to try switching earlier. For textured cut-outs the simplifier keeps fewer leaf planes and enlarges the survivors to compensate. Lowering `ratio` further can preserve total leaf area while opening holes between oversized leaves. Baking onto that thinned mesh still leaves the holes.

Test the largest impostor from the side as the camera passes. Doubled branches or a flattened crown between baked views are reasons to try one parallax step. A softer but correctly placed leaf edge is a reason to try more texels per view (`resolution`). Increase `frames` for finer angular sampling. It counts views **per side** of the atlas, so doubling either setting alone roughly quadruples the texel count. Use `layout: "hemi"` for upright assets seen from the horizon up. A smaller, zero-parallax impostor farther out can save both first-view bytes and shading. A larger near atlas trades transfer and residency for detail, even when the warm frame gets faster.

If the forks still need geometry where the leaves become expensive, an authored canopy (the leafy crown) is an ordinary mesh level. Keep the visible wood and bake nearby leaf clusters onto crossed, alpha-tested planes merged per foliage material. Compare against the whole-tree ladder first. Independent cluster selection is worth testing where many clusters on the same tree need different detail or can be culled individually. Repeating even one directional cluster impostor in a single draw still shades overlapping quads throughout the crown. A stand impostor can replace a distant group of trees when its layout preserves their spacing and gaps and it actually suppresses their individual draws. Check the distant approach where it takes over. An interior forest view can remain dominated by nearby trees.

For grass, start with source blades → simplified blades while their roots, lean and depth are visible → empty once the ground carries their colour and coverage. If a distant tuft reads as a silhouette, compare an ordinary textured plane. A fixed upright plane vanishes edge-on. A billboard rotating around the vertical axis preserves its width at grazing angles. Two crossed upright planes cover more horizontal directions with fixed geometry, but show a flat root line up close and lose area from above. A horizontal plane has the opposite viewing range. Test at the lowest **and** highest camera elevations in use. Authored single or crossed planes fit a mesh level (`{ object: mesh }` when assembling levels directly).

## Tune the complete scene

Tune transitions in the intended viewport with `Lod.debug` and use `Lod.quality` for a scene-wide adjustment. At the nearest intended view of each level, use `lod.forceLevel` to compare it with the detailed source at the same pose, light and wind time. Check silhouette area **and where the gaps fall**, shadows, colour and fine detail. Release the override and move through the fade, toward the sun as well as away.

A directional impostor draws a camera-facing quad and blends three neighbouring baked views. Its camera depth and its parallax solve different problems:

- Keep the default `draw: { depth: "reconstructed" }` when distinct surfaces interleave, such as a fence crossing a trunk. The fragment shader uses baked surface depth to place each covered pixel in the depth buffer. Overlapping quads can then require shading before the GPU knows which surface wins.
- Try `draw: { depth: "card" }` when overlaps are hard to distinguish, such as similar plants in a field. The quad supplies ordinary raster depth, allowing early rejection of hidden fragments. The image still comes from the directional atlas. Check foreground crossings in motion for incorrect occlusion. Both modes test and write depth on covered samples and reconstruct depth in shadow maps. For a separately sorted translucent effect, keep its material's depth test and disable depth writes when it should blend with surfaces behind it.
- `draw.parallax` refines where each baked view is sampled using depth. Each extra step adds atlas reads. Try zero when motion within the silhouette is imperceptible at the largest intended size. Card depth can retain parallax, and zero parallax can retain reconstructed depth.

Avoid custom shadow nodes on lights that LOD objects should cast into. Each shadow camera selects its own levels. If a cascade dominates, inspect its actual casters. Use `onLevel` to turn off `castShadow` where losing that shadow is acceptable.

For a flythrough that misses its frame budget, isolate the slow camera positions and separate CPU submission, camera shading, shadow rendering and first-use stalls. The [LOD profiling guide](references/profiling.md) gives matched controls for each.
