---
name: lod
description: Use @drawcall/lod for cached, progressively loaded levels of detail in three.js WebGPURenderer scenes. Covers model and procedural assets, LODs inside .glts assets, mesh simplification, baked meshes, impostors, instanced copies, wind, interior mapping, choosing levels for plants, asset preparation and capturing fully loaded frames; not WebGLRenderer or skinned animation.
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

`loadAsync` resolves with the ladder before its levels load; each level loads when a camera first needs it. A level the cache lacks is built when it first loads, so a far camera builds only the coarse levels it needs. Choose `maxPixels` for simplified and baked levels by looking at the transition. The default of half the finer neighbour's height does not measure visual error. An impostor's default is the largest height at which its atlas stays sharp. A source-only ladder loads its source eagerly.

**The original never has to draw.** If the first derived level holds up at the closest reachable view, set `levels[1].maxPixels = Infinity` on the returned ladder before constructing the `Lod`. Keeping this assignment outside the loader request lets the cache plugin read the request as JSON. A cached bake or impostor can then draw without fetching the original. A cache miss needs the source to build it, and a simplified mesh still loads the source for its materials. Use `forceLevel = 0` for a visual comparison.

Choose each level for the detail the camera can still resolve. Keep the source where the viewer can see detail a cheaper representation loses. Simplify when fewer triangles preserve the silhouette and the source materials still suit it. Bake when a simple mesh holds the shape and textures can carry the surface detail, optionally with an interior behind windows. Try an impostor when a complex silhouette still matters but changes in perspective within it are small. Use an empty level once the object can disappear. Compare neighboring levels in motion at the intended size and density before adding a transition.

Nothing draws until the coarsest level that draws has loaded, near views included, so its bytes decide how soon any view appears. For a fast first view, end the drawn ladder with a level sized for the few pixels a far object covers, such as a 16-pixel impostor or a baked shell with a 64² texture. Size the texture for the largest view that level serves. A boxy building can keep the same shell to the horizon, dropping the mapped rooms once the windows need only their baked appearance. An impostor can retain the silhouette of a leafy crown.

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

Supply authored low shells and baking interiors as asset URLs on a baked level; both resolve relative to the source asset as ordinary URLs, so a query-only value replaces the source's whole query. For a variant of the same script, repeat the source's generation parameters, for example the source URL plus `&part=low`. Use a baked shell when you need to transfer the source’s surface detail onto simpler geometry. If an authored exterior already has the materials and silhouette you want up close, it can be the source itself. A baking interior supplies room structure behind the windows. Author the shell, source and interior in the same coordinate system.

## Give a .glts asset its own levels

A `.glts` script can draw its asset at levels of detail, so that every glts host gets them without knowing of lod. Keep the detailed asset in a script of its own, here `./model.glts` beside the wrapping script; load its ladder with the wrapping script's `loadingManager`, which resolves URLs relative to the script, after giving that manager the script's `gltsLoader` for `.glts` sources. Add a `Lod` of it to the script's scene, tracked by the same manager, so that a host waiting on its loads, such as the glts CLI rendering the script, waits for the levels its cameras need. Here the camera stays outside a building, where its baked exterior suffices even up close. The distant level reuses that shape with a small texture once the rooms are too small to see.

```ts
import { gltsLoader, loadingManager, onDispose, scene } from "@drawcall/glts";
import { CachedLodLoader, Lod } from "@drawcall/lod";

loadingManager.addHandler(/\.glts$/i, gltsLoader);
const levels = await new CachedLodLoader(loadingManager).loadAsync({
  url: "./model.glts",
  levels: [
    { type: "baked", low: "./exterior.glts", interior: "./rooms.glts", textureSize: 512 },
    { type: "baked", low: "./exterior.glts", textureSize: 64, maxPixels: 24 },
  ],
});
const exterior = levels[1];
if (!exterior) throw new Error("Expected a baked exterior");
exterior.maxPixels = Infinity;
const lod = new Lod(levels, 1, { manager: loadingManager });
scene.add(lod);
onDispose(() => lod.dispose());
```

A host that draws the asset many times calls `gltsLoader.loadInstancesAsync(url, count)`; glts hands that asset's `instanceMatrix`, `instanceColor`, `count`, `boundingBox` and `clusters` to the Lod, which then draws every copy.

## Cache every level

Follow the [cache skill](https://github.com/drawcall-ai/cache/blob/main/packages/cache/skills/cache/SKILL.md) to add its plugin and to write loads it finds: call `loadAsync` on `new CachedLodLoader(...)`, or on a variable initialized with one, with a literal request, one load per ladder the app uses. Constructor options, such as the loading manager and `onLevel`, change nothing stored. An app deployed under a sub-path, such as `/app/`, serves its root-absolute URLs there through the URL modifier of the loading manager its loaders and GLTS scripts load with, prefixing `/app` to URLs that start with `/`; the loader finds its cache at `/_cache/` through that modifier too, so asset scripts written for the root, installed ones included, need no change. Levels are stored alike wherever the app is served. Without such a modifier, pass the cache's location as `new CachedLodLoader(manager, { basePath: "/app/_cache/" })`.

The plugin repeats each load in Node, where the loader builds every level of the ladder and saves each with the versions of three and of the packages its `.glts` sources import, and with the public files its loads read, which it records; changing any of them rebuilds the levels, and pages read them. There, URLs such as `/trees/oak.glts` load from the app's `public` directory, `.glts` sources run with the packages the app installs, and bakes draw on a GPU through [@drawcall/webgpu](https://github.com/drawcall-ai/webgpu/blob/main/skills/webgpu/SKILL.md). Write asset URLs from the site root, and keep sources free of the DOM: they get WebGPU, the app's public files through their `loadingManager`, image decoding and classic workers, but no `document` or 2D canvas. A load that requests any other URL through its manager, or a source that imports a module from a CDN, fails the build, since no stored level could be checked against it; a source that fetches without its manager is not served.

A page that misses, for a load the plugin could not see, builds the level each time it loads, without saving it.

## Place, share and dispose levels

Load an asset once and build a `Lod` per spatial region from its levels, each with its own placements and colours; clone a `Lod` for a further copy with its own attributes. Reuse the loaded levels across Lods; adjust each Lod's resolved thresholds through its `levels`. Lods made from the same levels share geometry, materials, textures and deferred loads. Disposing a `Lod` frees only what it made of its levels: objects you give or load are yours to dispose once every Lod drawing them is disposed, while `CachedLodLoader` frees what it loaded, and the renderer it baked with, when the last Lod holding its levels is disposed.

Use the loader's `onLevel` option for application effects and shadow settings, `castShadow` and `shadowSide` included. Put source generation and its materials in the asset so that the same URL also loads correctly outside the LOD host.

Each mesh and material group of a level is a draw of its own in every pass, however many copies draw it: where submission dominates, merge the static parts that switch together into one mesh with one material in the source.

When nearby instances hide coarser instances of the same `Lod`, try `renderer.setOpaqueSort(opaqueSort)` with `opaqueSort` from `@drawcall/lod`. It draws finer levels first when group order, render order and depth tie. Measure where the levels overlap.

Levels draw with copies of the source's materials, made once through three's `clone`. A custom material class must carry its own state in `copy`, and changes meant to reach drawn levels belong in shared TSL uniforms rather than in properties set on the original afterwards.

Apply a shared `Wind` after assembling a LOD and before its first render; arriving levels inherit the effect. A `Lod` that has rendered refuses wind: its shaders would build in a frame. When shadow maps refresh too slowly to follow the sway smoothly, use `new Wind({ animateShadows: false })` to cast from the rest pose. Keep the default when the shadow needs to follow the visible silhouette.

Levels are chosen by on-screen size in CSS pixels on the actual render target, so a lower renderer pixel ratio saves shading, not geometry. Compile the initial scene with the actual camera and renderer before revealing it. Render every frame while finer levels load: they upload and compile only inside renders.

## Place instances, and bound them

Edit instances as on an `InstancedMesh`: `setMatrixAt` and `setColorAt`, then set the attribute's `needsUpdate`; with `addUpdateRange`, only those ranges upload. Assigning a new `instanceMatrix` or `instanceColor` takes effect at the next render; `count` draws the first `count` instances. A matrix of scale 0 draws nothing, but prefer `count` and smaller Lods over parking many instances at scale 0.

Each camera loads the levels, and shows the level meshes, that the instances' bounds can need. Without `clusters`, the bounds are `boundingBox` if set, else what the CPU measures of the matrices; broad bounds can load levels for the full range of screen sizes. Give a Lod that spans a large area `clusters`: disjoint ranges of instances, each with a `boundingBox` in the Lod's space and, where known, `minScale` and `maxScale`. Each cluster is culled and chooses levels on its own, and only instances inside a cluster draw. Clusters narrow the work for the existing ladder. They contain no replacement geometry for the group.

When a compute pass of yours writes the instances, assign a `StorageInstancedBufferAttribute` (`instancedArray(n, "mat4")`'s value) as `instanceMatrix`, and a four-float one as `instanceColor`. The Lod reads them in place every frame; no `needsUpdate` is needed. The CPU cannot read them, so set `boundingBox` or `clusters` yourself: without either, the Lod assumes every screen size is possible and warns once. When your pass also decides how many of a cluster's instances are live, from its start, set the cluster's `liveCount` to `{ attribute, index }`, the u32 your pass writes into a storage attribute, such as `instancedArray(n, "uint")`'s value, that all of the Lod's clusters share, so that only those are sorted and drawn. `count` remains the most the range holds. `computeBoundingBox`, `getLevelAt` and `raycast` work on CPU matrices only.

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

## Choose levels for plants

For a dense crown, try a simplified whole tree while its branches still read individually, then a whole-tree impostor once its silhouette dominates. Look for doubled branches as the camera moves between baked views. Add parallax only if it improves that transition.

For sparse blades or leaves with large gaps, a cheap mesh can beat an impostor. The mesh follows the blades, while overlapping impostor rectangles sample the atlas across those gaps. Compare the source or a low mesh against the impostor at the same density, distance and render resolution. Pan slowly at the shipping sample count to check for shimmer on thin foliage. Alpha to coverage needs a multisampled scene target. Include a view from inside the planting.

## Tune the complete scene

Replay the same short movement at the target viewport and pixel ratio, after the required levels have loaded. Time GPU-completed frames with only the LOD objects, then with the complete scene. Hiding foliage exposes the surfaces behind it and changes which fragments pass the depth test. To isolate an expensive background material, keep its geometry and depth behavior and substitute a plain material. If that wins, simplify the background before sacrificing detail on the focal objects. Confirm the saving with the full scene in motion.

Tune transitions in the intended viewport with `Lod.debug` and use `Lod.quality` for a scene-wide adjustment. At the nearest intended view of each level, use `lod.forceLevel` to compare it with the detailed source at the same pose, light and wind time. Check silhouette area **and where the gaps fall**, shadows, colour and fine detail. Release the override and move through the fade, toward the sun as well as away.

If a baked surface shimmers at a grazing angle, hold its level fixed and replay the motion with the normal map disabled. If that removes the shimmer, try a positive mip bias on the normal map alone. Check that the relief still reads at the closest view.

An impostor's `depth: "reconstructed"` places each pixel at its baked surface, so interleaved surfaces such as a fence crossing a trunk stay correct, but every overlapping card shades before depth decides. `depth: "card"` lets the GPU reject hidden pixels early, which pays off in fields of similar plants; check foreground crossings in motion. Each `parallax` step adds atlas reads: try zero where motion within the silhouette is imperceptible at the largest intended size.

Avoid custom shadow nodes on lights that LOD objects should cast into. Each shadow camera selects its own levels. If a cascade dominates, inspect its actual casters. Use `onLevel` to turn off `castShadow` where losing that shadow is acceptable.
