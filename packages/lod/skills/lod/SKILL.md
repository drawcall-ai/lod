---
name: lod
description: Use @drawcall/lod to give three.js objects levels of detail — load a model and get a simplified mesh, a baked low-poly mesh or an octahedral impostor that switch by on-screen size with a dithered fade, or switch your own levels — including crowds of instances, vegetation swaying in wind, buildings whose windows show the rooms behind them (interior mapping), shadows over large worlds, and preparing models that bake into good impostors. Use when a WebGPURenderer scene (`three/webgpu`) has many or large objects seen from far away; not for WebGLRenderer, skinned animation, or glass objects.
---

# Level of detail with @drawcall/lod

## Which part to reach for

- **A model file → `LodLoader`.** It loads the model and builds its cheaper levels; impostors can be deferred until a view needs them. The result is a `Lod` you add to the scene. Three's renderer updates every `Lod` while it renders.
- **Many copies of one object → `InstancedLod`** (`loadInstancesAsync`, or built from levels): every copy switches and fades on its own, with one draw per level and mesh.
- **Levels you already have → `new Lod([source, ...levels])`**: any `Object3D` per level, another `Lod` included, detailed to cheap. Levels made by this package know how far off they are and pick their own switch size; hand-made ones need a `maxPixels`.
- **Only ever far away, never switching → an `ImpostorMesh`** from `bakeImpostor`: one instanced draw for thousands of copies.

Which levels to build, by asset:

- **Foliage** — trees, bushes, grass, plants, anything of alpha-tested leaf cards → an impostor only (the loader's default). A simplified level in between tears the cards apart. A scan that models every leaf in many triangles is different: draw it from its own `simplify` copy (around a quarter of the triangles keeps the leaves' shape; far fewer smears them) and use that as the source.
- **Hard-surface props** — rocks, vehicles, furniture → simplified, then impostor. Low-poly props need no levels: an impostor costs more than they do.
- **Buildings** → baked (experimental), then impostor. The baked level is one low mesh carrying the source's colour, normals and roughness in its own textures, so window frames, gutters and doors survive as texture, onto a low shell you give it (see "Impostor-ready assets").
- **Buildings you can see into** → the same, plus an `interior`: the rooms as a model of their own. Up close the real rooms show through the real glass; the baked level shows each room through its windows by interior mapping — a picture of the room that shifts with the view, at no geometry cost.
- **Dense patches of plants** (a block of corn, a patch of grass) → the plants as an `InstancedLod` (source, impostor, then an empty level so far plants draw nothing), and one `bakeMesh` of a patch's plants onto a canopy as the far level of the patches (see "Impostor-ready assets").

```ts
import * as THREE from "three/webgpu";
import { Lod, LodLoader } from "@drawcall/lod";

const manager = new THREE.LoadingManager();
manager.addHandler(/\.glb$/i, new GLTFLoader(manager).setDRACOLoader(draco)); // LodLoader uses it
const loader = new LodLoader(manager);

const tree = await loader.loadAsync({ url: "/tree.glb", levels: [{ type: "impostor", layout: "hemi" }] });
const shop = await loader.loadAsync({
  url: "/shop.glb",
  levels: [
    { type: "baked", low: "/shop-low.glb", interior: "/shop-rooms.glb" },
    { type: "impostor", layout: "hemi" },
  ],
});
scene.add(tree, shop);

const forest = await loader.loadInstancesAsync("/tree.glb", spots.length);
spots.forEach((spot, i) => forest.setMatrixAt(i, new THREE.Matrix4().setPosition(spot)));
scene.add(forest);

Lod.debug = true; // tint levels to see where each draws
```

## How the parts combine

- **Vegetation in wind:** build the resting asset and its levels, then apply one `Wind` to the `Lod` or `InstancedLod`. Deferred impostors inherit that wind when they arrive. Update its time before rendering; share the same breeze across plants. Apply to individual plants or their instance batches, rather than a whole forest hierarchy. Broad sway moves the whole plant; it does not animate individual branches or leaves. Independent objects attached to a plant need to follow its motion too.

- **Switching is by on-screen height in CSS pixels:** a high-density screen picks the levels a standard one does and pays for its extra pixels in fill only. `Lod.quality` scales every measurement: below 1, cheaper levels take over sooner — the global performance knob (set it to the pixel ratio to switch by device pixels).
- **Near a switch both levels draw** and split the pixels with a dither, so nothing pops. Elsewhere only one level is visible: hidden levels submit no draws or shadows, but their geometry and textures stay resident. Each level's switch size must stay far enough below the previous one's for one fade to end before the next begins; the `Lod` throws otherwise.
- **Nested `Lod`s** switch their own levels; the parent hands over to and from them without the dither, and a hidden parent level hides everything inside.
- **Clone instead of loading twice:** `clone()` shares geometry, textures and deferred atlas requests. A persistent cache avoids rebaking, but each separate load still reconstructs the model and its other levels. For hundreds of copies use `InstancedLod`, as a `Lod` per copy costs draws per copy.
- **Split large crowds into regions:** use one `InstancedLod` per region so regions outside the view or a shadow map can skip their draws. Keep nearby instances together in the batch; one scattered world-sized crowd is hard to cull, while many tiny crowds spend the frame submitting draws. Cheap far cards can use larger batches than detailed source models; compare their draw overhead and culling cost separately. Check that your target devices offer the required WebGPU feature `indirect-first-instance`. Keep the batch's own transform uniformly scaled (instances may scale any way). Build its levels as templates without nested `Lod`s or InstancedMeshes; use `Lod` for hierarchies.
- **Hierarchies on top** (a field whose plants exist only near the camera): level 0 may be an empty `Object3D`, and the `Lod` measures by the first level that draws. Draw the detail yourself where level 0 shows: `levelOf` on an `InstancedLod`, `visible` on a `Lod`'s level. `Lod.fade` is the share of a level's `maxPixels` its fade spans.
- **Saving results:** persist impostors with `encodeImpostor` and baked meshes with `encodeBakedMesh`, before applying runtime material changes or adding them to a `Lod`. Decode cached results instead of repeating their bakes; the asynchronous impostor decoder avoids long synchronous JavaScript decompression where native streams are available. Simplified levels still need construction. An incompatible encoding change requires rebaking old files, and results need regeneration when their inputs or baking algorithm change.
- **`dispose()` frees everything,** the source included. Clones share geometry and textures: dispose only once no clone draws any more.

## Cached and deferred impostors

Use `LodLoader` with a GLTS asset to cache its impostors through vitecache. A whole authored GLTS asset is one cache unit: its source URL, observed dependency URLs and bake settings identify the result. Direct object input belongs inside an active GLTS execution; use the complete asset, and finish loading its resources before requesting levels. Outside GLTS, load a URL or compose `Lod`/`InstancedLod` from the building blocks. See the [GLTS skill](https://github.com/drawcall-ai/glts/blob/main/packages/glts/skills/glts/SKILL.md) for contextual loaders and sharing package instances.

Enable vitecache in the host Vite app, and generate the public cache files before deployment. Follow the [vitecache skill](https://github.com/drawcall-ai/vitecache/blob/main/packages/vitecache/skills/vitecache/SKILL.md) for dependency declarations and deployment. Match the loader's cache location to the app's URL base; asset paths and cache paths are separate. GLTS tracks observed files, so declare additional generator packages or other inputs in the loader's cache dependencies. Procedural assets outside GLTS can combine `cachedImpostor` with explicit file and parameter dependencies; include every input that changes the asset, including helper code and textures. Do not reuse one dependency set for different asset variants.

```ts
const trees = await loader.loadInstancesAsync(
  {
    url: "/assets/tree.glts",
    levels: [{ type: "impostor", layout: "hemi", lazy: true, maxPixels: 128 }],
  },
  spots.length,
);
```

Use `LazyImpostor` when assembling levels yourself. Keep an eager source and a known switch height; while an atlas loads, a ready finer level stays visible. Keep the bake input alive and unchanged until loading finishes. If batching consumes or replaces its geometry, retain an authored snapshot for the deferred bake. Apply custom impostor material setup and refresh custom draw or shadow registries on `levelschange`, as well as at construction. Use `load()` to prefetch or explicitly retry; failures reject and automatic demand reports the error while retaining the finer fallback.

Measure the first visible frame, a warm reload, and the first traversal separately. Cached atlas bytes avoid baking; deferred levels avoid reading and uploading unused atlases. They do not remove source loading, other derived-level construction, or first-use shader preparation. Check caches before constructing their expensive inputs, and persist baked meshes too when those dominate startup. Prefetch only the initial view if its fallback would be too expensive; include any custom instance-streaming updates before measuring demand.

When preparing a view before its first render, seed its viewport with `setViewportHeight` before updating or prefetching LODs. This lets the first update exclude tiers that cannot draw; otherwise their shaders and textures can be prepared unnecessarily. Refresh the supplied height on resize, especially when every LOD is currently culled; normal draws continue measuring the viewport automatically.

## Impostor-ready assets

- **Units and pivot:** Y up, metres, origin at the ground under the object, so instance matrices place it standing. Vary copies cheaply with per-instance colour (`setColorAt`): every variant model costs its own levels and bakes.
- **Foliage leaves are alpha-tested** (glTF `MASK`, never `BLEND`), the alpha in the base colour texture, and the colour bled out into the transparent texels: black there darkens every mip, so the source darkens with distance and its bakes with it.
- **Custom lighting is not baked.** Impostors and baked levels keep the surface (colour, normal, roughness) and light it as a standard material: lighting a source's node material changes on top, such as leaves glowing in back light, is lost, and such foliage reads darker once its impostor shows, worst against the light. Give each `ImpostorMesh`'s material (a `MeshStandardNodeMaterial`) the same change once the `Lod` or `InstancedLod` is built, for example as an `emissiveNode`.
- **Jitter dense plantings** in position and rotation. Bakes and impostor views look along parallel rays: plants on a grid leave straight gaps there that no perspective view of the real plants shows.
- **A building's low shell** is geometry only, generated from the same parameters as the building and in its space. Parts it leaves out (a chimney) show only as texture and lower the level's switch size. Close it where the source is closed (a floor for a floor); leave out faces nobody sees, which take texture space from those that are seen. Make glass see-through and the rooms their own model (see "Interiors").
- **A canopy for a patch of plants** sits at the leaf tops, with side walls only on the outer edge of the whole field: inner walls show as a cliff where plants hand over. Rays that find no leaf at the top bake the leaves further down, so the canopy needs nothing under it. Whatever stands above the leaves (tassels, flowers) covers far more of a top-down bake than of any view across the field: bake the canopy from plants with fewer of them. Lay out the patch so rows run on across its borders, then copies tile without seams. Switch the plants on top per plant, by their own distance, not per patch: the hand-over then follows a smooth contour around the camera instead of patch edges.

## Performance

- **Tune switch sizes on a standard screen.** They are in CSS pixels, so the choice holds on a high-density one; size anything of your own that reacts to on-screen size (how far plants exist, how many) in CSS pixels too, or a high-density screen multiplies it.
- **When source geometry dominates,** lighten the source first, then let its impostor take over earlier — a larger `maxPixels` on the impostor level: lowering it keeps more copies at the source. Bake that impostor with the same `maxPixels`: above its default it shows its top mip magnified, which otherwise keeps the look of the source at the bake's size — foliage denser and darker than the leaves it replaces up close.
- **Impostors cost fill.** Few triangles can still cover the screen many times: atlas sampling, lighting and overlapping cards can dominate even with parallax off. Compare dense individual plants with a patch's baked far level, not just triangle counts. Keep parallax for impostors seen large — without it they ghost (doubled trunks) — and turn it off only for impostors that only ever show small or densely packed, such as a field's plants.
- **Count material groups as well as triangles.** Instancing combines copies of a model, but its separate materials still require separate draws in each pass. Merge compatible parts before creating LOD batches; packing textures alone does not combine draws. Preserve material and shadow behavior, and keep overlapping or thin parts separate if batching changes their appearance. For `bakeMesh`, bake from the authored materials before replacing them with GPU-only atlas materials.
- **Keep the rendering conditions fixed when comparing performance:** viewport, pixel ratio, multisampling, shadows, wind and switch sizes. Disabling an effect can identify its cost, but is not an equivalent-looking optimization. Check moving transitions as well as stationary images; multisampling matters especially for thin twigs and grass.
- **Judge changes by completed frame time.** Fewer draws, triangles or buffer bindings can still cost more if culling becomes coarser or preparation, vertex work or shading becomes heavier. Merged shadow casters can process parts that were previously skipped. Atlases can increase texture memory; preserve resolution and mip quality in the comparison. Measure CPU work and GPU completion separately; overlapping GPU pass durations do not add up to frame time. Recheck the original setup after each experiment to catch background-load drift. Compare images after the same movement history: streamed instance slots and cached shadows can differ even when the final camera pose is identical.
- **Stream into existing batches:** reuse nearby regions' slots and change only the matrices or colours that actually changed. Rebuilding batches or rewriting the whole crowd during flight adds preparation and upload work even when few instances draw.
- **Check the first flight as well as a warmed repeat.** Preparing the starting view does not prepare every later level and shadow variant. Measure first-use shader preparation and streaming separately from steady-state throughput. Any startup warmup needs its own loading-time and appearance checks, including simulation and streaming state, the first visible frame and later transitions. Free flight can still reveal new variants. Measure rendering separately from an overlay that counts every instance; count queries and temporary objects can cause periodic CPU and garbage-collection stalls.

## Shadows

- **Levels are chosen from the viewing camera,** and every shadow map draws those same levels, including a finer fallback while an impostor loads. During a fade both levels cast, dithered as they draw, so the object casts one shadow.
- **Casters narrower than a texel** of a directional light's shadow map draw nothing into it, so coarse cascades skip small casters by themselves.
- **Shadow setups on the light or renderer reach every level**; impostors cast and receive at the surface they resolve. A per-material setup must run on the level meshes' materials after the `Lod` is built: the material you passed in is no longer drawn.
- **Open models leak light** (eaves, window reveals, single walls): three casts with back faces only. Set `shadowSide = DoubleSide` on their materials, with about a texel of shadow `bias` against acne.

## Pitfalls

- **Materials are replaced.** A `Lod` draws each mesh with a faded node-material copy of its material; the material you passed in is no longer drawn. Edit the material on the level's mesh after building. `ShaderMaterial`s are refused: write them as node materials.
- **Authored levels are read once,** when the `Lod` is built: arbitrary meshes added or moved later are neither faded nor measured right. Build a new `Lod` instead. `LazyImpostor` is the supported way to defer an impostor level.
- **Skinned meshes are refused,** and animation is ignored.
- **Orthographic cameras** switch by on-screen size too, but swap levels at once.
- **Several cameras:** each is measured at the viewport height it last drew the `Lod` at; a camera's first frame assumes a typical screen. An `InstancedLod` holds one selection at a time: a render nested in another (a reflection, a `CubeCamera`) that sees it replaces the selection the outer render draws, so keep it off the layers such cameras see. Renders one after the other are fine.
- **Many `Lod`s appearing at once hitch** while three sets up each mesh's material; draw crowds with `InstancedLod`.
- **Lines, points and sprites** in a level draw but do not fade. Raycasts hit the source only, whatever level shows.
- **Canvas alpha:** impostor edges use alpha-to-coverage, which leaves fractional alpha in the frame, so the page shows through: create the renderer with `alpha: false`.

- **Impostor layout `"hemi"`** covers views from the horizon up only: right for upright trees, rocks and buildings, wrong for anything seen from below.
- **`.glts` URLs need a registered loader:** `manager.addHandler(/\.glts(?:[?#]|$)/i, new GLTSLoader(manager))`. Inside a `.glts` script, register the contextual `gltsLoader` on the contextual `loadingManager` instead. Share the host's package through GLTS when using `instanceof`; separately loaded package copies have different constructors.
- **Baking a mesh is slow and CPU-bound** on the loading thread (it yields between chunks), and each baked level has its own textures in GPU memory. Bake once per model and clone; time and memory grow with `textureSize` squared, so small or only-far objects bake faster at a smaller one.
- **Baked levels read textures on the CPU:** compressed textures (KTX2) fail the bake. Emissive, clearcoat and transmission are not baked; glass bakes opaque in its own colour unless it looks into an interior. Only alpha-tested surfaces cut holes.
- **Specular level** (`ior`, `specularIntensity`, `specularColor`, glTF `KHR_materials_specular`) reaches an impostor only as one average for the whole object, so parts or maps that differ in it reflect alike; baked levels reflect like a plain dielectric, so a source with its specular turned down shows brighter at them.
- **Clones of a built level** made by hand lose the measured error their switch size comes from; clone the whole `Lod` instead.
- **Large worlds** (kilometres to millimetres) z-fight with the default depth buffer. Every level works with the renderer's `reversedDepthBuffer`.

## Interiors

- **Rooms are their own model,** never part of the building's: only rooms given as the interior are left out of the baked exterior and shown through its windows. One baked level per model takes an interior.
- **One direct child per room, filling its box:** walls, floor and ceiling on the box's faces, facing in. Rooms must not overlap; doorways between them, stairwells and several storeys are fine. A room's box should begin at the inside of the wall its windows are in; glass with no room just behind it stays plain glass.
- **The glass must be see-through in the source:** transparent with opacity below 1, or transmissive. Dark but opaque glass gives no windows, and the bake fails when no glass looks into a room.
- **Rooms are lit by the light reaching the window** — ambient, light probes and the environment, not the sun, which the walls would block — so they darken with the scene. For a dimmer room, darken its materials.
- **Lamps glow through emissive (or unlit) materials.** Lights in an interior are refused: wherever the source draws they would be scene lights, recompiling every lit material at each switch.
- **Furniture against a wall looks right;** things standing free in the room flatten onto the walls behind them.
- **Calling `bakeMesh` yourself:** pass the interior and put it inside the source, so the source shows the real rooms; the bake leaves it out of the exterior either way.
