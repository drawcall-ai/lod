---
name: lod
description: Use @drawcall/lod for cached, progressively loaded levels of detail in three.js WebGPURenderer scenes. Covers model and procedural assets, mesh simplification, baked meshes, impostors, instanced crowds, wind and interior mapping; not WebGLRenderer or skinned animation.
---

# Level of detail with @drawcall/lod

## Start with the loader

Use `LodLoader` for model files and procedural sources. A warm load fetches enough to draw a coarse representation. Finer representations, including the original source, are fetched and decoded as the camera needs them. Keep rendering while they load. A source-only ladder loads its source eagerly; to defer that source too, compose the result of `loadLevelsAsync` with an eager fallback you already have.

Choose levels from the asset's silhouette, materials and expected viewing range. Alpha-tested leaf cards often work best as source → impostor; simplifying the cards can destroy their shape. Dense foliage geometry may benefit from simplification first. Hard-surface props often suit source → simplified → impostor. Detailed structures can use source → baked shell → impostor, with interiors supplied separately for windows. Add an empty final level when the object should disappear at distance.

This example creates a crowd with independent placements and colour variation. `positions` contains positions in the crowd's space, and `scene` is the application's scene.

```ts
import { Color, Matrix4 } from "three/webgpu";
import { InstancedLod, LodLoader, Wind } from "@drawcall/lod";

const loader = new LodLoader();
const asset = await loader.loadAsync({
  url: "/tree.glb",
  levels: [
    { type: "impostor", layout: "hemi", maxPixels: 120, draw: { parallax: 2 } },
    { type: "empty", maxPixels: 4 },
  ],
});
const trees = new InstancedLod(asset, positions.length);

const matrix = new Matrix4();
const color = new Color();
positions.forEach((position, index) => {
  trees.setMatrixAt(index, matrix.makeTranslation(position));
  trees.setColorAt(index, color.setHSL(0.25, 0.15, 0.8 + (index % 5) * 0.025));
});
scene.add(trees);

const wind = new Wind();
wind.apply(trees, { amplitude: 0.3 });
// Set wind.time from the application's clock before rendering each frame.
```

Configure a loading manager for asset formats and compression before passing it to `LodLoader`. For GLTS assets, follow the [GLTS skill](https://github.com/drawcall-ai/glts/blob/main/packages/glts/skills/glts/SKILL.md), including contextual loaders and shared package instances.

Prefer passing a GLTS URL from the host when the full source should stay unloaded in an overview. The loader tracks that script's dependencies without executing the script on warm loads.

When a factory selects nodes or variants from a model file, mark it `reference: true` and include the file and selection in its key. The selected original supplies the source level and the materials shared by simplified levels. Its factory runs when a mesh level is demanded; an overview using impostor, baked or empty levels does not need it. Put simplification in a derived mesh level so warm loads reuse the computed geometry.

```ts
const plant = await loader.loadAsync({
  source: async () => selectVariant(await sharedModel(), variant),
  reference: true,
  key: { model: { url: "/plants.glb" }, variant: { value: variant } },
  levels: [{ type: "impostor", layout: "hemi", maxPixels: 120 }],
});
```

## Cache procedural inputs honestly

Put expensive source construction inside the procedural request's factory. Supply its dependencies without constructing the source: include parameters, generator code, helper packages and textures that can change the result. A cache hit must not need the factory to discover its key.

In this example, `makeHouse` constructs the full house and `shape` contains its generation parameters.

```ts
const house = await loader.loadAsync({
  source: async () => makeHouse(shape),
  material: (name, data) => houseMaterial(name, data),
  key: {
    generator: { path: "src/assets/house.ts" },
    shape: { value: shape },
    wallTexture: { path: "public/textures/wall.png" },
  },
  levels: [
    { type: "mesh", ratio: 0.3, maxPixels: 400 },
    { type: "impostor", layout: "hemi", maxPixels: 100 },
  ],
});
scene.add(house);
```

Follow the [vitecache skill](https://github.com/drawcall-ai/vitecache/blob/main/packages/vitecache/skills/vitecache/SKILL.md) to configure the host and include generated cache files in deployment. Match the loader's cache location to the application's URL base independently of asset paths. A cache miss builds the requested representations once. Warm loads fetch cached geometry and baked representations; mesh levels resolve their materials when demanded. Measure those two cases separately.

Supply a material resolver for every procedural mesh material. Give each material a stable name and put its reconstruction inputs in `material.userData`; keep shared materials and textures in that resolver. External textures stay original asset inputs. Regenerate cheap generated textures there, or cache their raw pixels separately when generation is expensive. Include material inputs in the request key when they affect baked representations. Use `restore` for effects or shadow settings that apply after loading each level, including lazy arrivals. Keep heavy geometry generation inside source factories.

```ts
const house = await loader.loadAsync({
  source: async () => makeHouse(shape),
  key: houseInputs,
  material: (name, data) => houseMaterial(name, data),
  levels: [
    { type: "baked", low: async () => makeShell(shape), maxPixels: 400 },
    { type: "impostor", layout: "hemi", maxPixels: 100 },
  ],
});
```

Use an authored level factory when a generated representation does not suit the asset. For example, a `mesh` level can construct a low-detail grass clump; its factory runs on a cache miss, and subsequent loads decode the saved geometry. Include every factory's inputs in the request key. Keep source, shell and interior geometry in the same coordinate system.

## Assemble levels you already have

Use `Lod` for independently placed objects and `InstancedLod` for repeated objects with per-instance matrices and colours. Pass levels in finest-to-coarsest order. An empty object can be a deliberate culled level, but a ladder needs drawable bounds and at least one eager level.

Use `LazyLevel` for any representation whose data is deferred, including the source. Its factory returns the drawing object: for a cached impostor, decode the atlas and return an `ImpostorMesh` with the intended draw settings. Provide bounds in the level's own space and a transition height before loading. Keep these bounds consistent with the returned object, including its children.

Here, `loadDetailedMesh` loads the detailed object, `sourceBox` describes its local bounds, and `coarseMesh` is already available.

```ts
import { LazyLevel, Lod } from "@drawcall/lod";

const detail = new LazyLevel(loadDetailedMesh, {
  maxPixels: Infinity,
  box: sourceBox,
});
const object = new Lod([detail, coarseMesh]);
scene.add(object);
```

A missing level uses the nearest installed finer representation, or the nearest coarser one if none is finer. Requests follow the visible view and begin ahead of the transition. Clones share loading work. Keep a factory's inputs alive until it finishes.

For direct preparation and storage outside `LodLoader`, combine `simplify`, `bakeMesh`, or `bakeImpostor` with the corresponding codecs and drawing objects. Use `ImpostorMesh` directly when copies stay distant throughout their lifetime. For external detail systems, combine an empty near level with a coarse representation and use `levelOf` or level visibility to decide where to supply detail.

Load an asset once and build spatial crowds from its `Lod` or its levels, each with its own instance count, placements and colours. `loadLevelsAsync` supplies levels when an application assembles its own ladder. Clones and crowds share geometry, materials, textures and deferred loads. Dispose shared resources only after every copy has stopped drawing; disposal does not count references.

Apply a shared `Wind` after assembling a LOD and before rendering; arriving levels inherit the effect. Apply it separately to nested LODs and independently managed batches. Clone a `Lod` for independently placed copies, or use an `InstancedLod` when many copies make separate objects too expensive. Plan the lifetime of shared geometry, materials and textures together.

Seed the camera with `setViewportHeight` before preparing its first view, and refresh that height after resizing views whose levels may all be culled. Compile the initial scene with the actual camera and renderer before revealing it. Continue drawing while finer levels load so preparation can use the same rendering context.

## Prepare assets that survive transitions

Keep sources, simplified geometry, low shells and interiors in a consistent coordinate system. A ground-level pivot helps upright repeated assets. Use instance colour variation when it can replace separately baked variants.

Author foliage with alpha-tested cutouts and colour beyond the visible texture edges. Inspect the source at distance before baking: dark transparent texels can darken small mips and every derived representation. Match visual effects across representations so foliage does not change lighting at a transition.

Match a low shell to the source's occupied shape. Preserve important silhouette features and remove faces that will never be seen. Generate shell and source from the same parameters when possible. Keep rooms separate while authoring, with their boundaries just behind windows and furnishings near visible walls; include rooms in the detailed source when they should appear in the near view too.

For dense cover, combine near individuals with a baked distant patch. Jitter position and rotation to avoid aligned gaps, preserve continuity across tile borders, and use side walls only on exposed boundaries. An empty far level can stop drawing individuals once the patch carries their appearance.

## Tune the complete scene

Tune transitions in the intended viewport with `Lod.debug`, then inspect motion through them. Use `Lod.quality` for a scene-wide adjustment and individual thresholds for particular assets. Give an impostor bake the intended screen size at its handover, then inspect its coverage and colour from several angles.

Group nearby copies into spatial regions. Broad batches can lose useful culling, while tiny batches spend too much time submitting draws. Reuse instance slots and update changed matrices or colours instead of rebuilding whole crowds. Count material groups as well as triangles; an atlas alone does not combine draws.

Judge impostors by covered screen area and overlap as well as triangle count. Compare individual cards with baked patches for dense cover, and inspect parallax and mip quality during transitions.

Compare cold startup, warm startup and first traversal under the same camera movement, viewport, shadows, wind and thresholds. Keep expensive diagnostic overlays outside measurements. A warm repeat does not reveal first-use work, and fewer draws can still lose to worse culling, shading or memory costs.
