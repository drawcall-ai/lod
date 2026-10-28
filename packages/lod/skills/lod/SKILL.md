---
name: lod
description: Use @drawcall/lod to choose and combine mesh simplification, baked meshes, impostors, instanced levels of detail, wind and interior mapping in three.js WebGPURenderer scenes. Covers asset preparation, caching, deferred loading and tuning large static scenes; not WebGLRenderer or skinned animation.
---

# Level of detail with @drawcall/lod

## Choose the representation

Start with the asset's silhouette, materials and expected viewing range. Add a level only when it saves enough work to justify its transition and memory cost.

- Use `LodLoader` for model files and generated GLTS assets. Use `Lod` when combining levels you already have, including hierarchies managed by other LODs.
- Use `InstancedLod` for repeated objects that need individual transitions. For objects that stay distant throughout their lifetime, combine `bakeImpostor` with `ImpostorMesh` directly.
- For alpha-tested leaf cards, try source → impostor. Simplifying the cards usually destroys their shape. For foliage made from dense leaf geometry, simplify the source first and inspect the silhouette before building its levels.
- For hard-surface props, try source → simplified → impostor. A cheap source may need fewer levels, or none.
- For detailed structures, try source → baked mesh → impostor. Supply a low shell when automatic simplification loses important shape; add a separate interior model when rooms must remain visible through windows.
- For dense repeated cover, combine individual near objects with a baked patch for the distance. Use an empty far level to stop drawing the individuals once the patch can carry the appearance.

In an existing scene, this combines an instanced asset with a separately authored baked shell. `positions` contains the instance positions in the batch's space.

```ts
import { LoadingManager, Matrix4 } from "three/webgpu";
import { LodLoader } from "@drawcall/lod";

const loader = new LodLoader(new LoadingManager());
const trees = await loader.loadInstancesAsync({ url: "/tree.glb", levels: [{ type: "impostor", layout: "hemi" }] }, positions.length);
const matrix = new Matrix4();
positions.forEach((position, index) => trees.setMatrixAt(index, matrix.makeTranslation(position)));

const building = await loader.loadAsync({
  url: "/building.glb",
  levels: [
    { type: "baked", low: "/building-low.glb", interior: "/building-rooms.glb" },
    { type: "impostor", layout: "hemi" },
  ],
});
scene.add(trees, building);
```

Configure the loading manager for asset formats and compression before constructing `LodLoader`. For GLTS, follow the [GLTS skill](https://github.com/drawcall-ai/glts/blob/main/packages/glts/skills/glts/SKILL.md), including contextual loaders and shared package instances.

## Assemble the asset before customizing its rendering

Keep an authored source for building levels. Bake from its original materials before replacing them with atlas shaders or other runtime-only materials. If later batching consumes or replaces the geometry, retain a separate bake input until every deferred bake finishes.

Persist expensive derived assets before attaching runtime effects: `bakeMesh` → `encodeBakedMesh` → `Lod` or `InstancedLod` → material customization and wind. For impostors, persist the `bakeImpostor` result with `encodeImpostor`, then construct the drawing objects. On later loads, decode cached results before constructing expensive inputs that the cache makes unnecessary.

Apply material changes to the meshes that the completed LOD actually draws. Reapply visual effects across representations: for example, foliage with custom back lighting needs a corresponding impostor treatment to avoid darkening at the transition. Run the same setup when `levelschange` installs deferred meshes, and refresh any application-owned draw or shadow registries then.

For vegetation, construct the resting LOD, including any deferred levels, before applying a shared `Wind`; deferred impostors inherit it when they arrive. Apply it to each plant or instance batch, then update the shared time before rendering. Keep independently attached objects visually in step with the plant; use another animation system when individual branches or leaves need articulation.

Clone a completed `Lod` when reusing an asset with independent placement; use `InstancedLod` when repetition makes separate objects too expensive. Plan the lifetime of shared assets together so disposing one does not invalidate another user's geometry or textures.

For external detail systems, combine an empty near level with a coarse representation and use `levelOf` or level visibility to decide where to supply detail. A field can then transition individual plants independently while its distant patches remain coarse; switching all plants at a patch boundary produces a visible moving edge.

## Combine persistence with deferred loading

Use `LodLoader` with GLTS for persistent impostor caching. Pass the complete authored asset after its resources have loaded, and add generator packages or other unobserved inputs to its cache dependencies. For procedural assets outside GLTS, compose `cachedImpostor` with explicit inputs that distinguish every asset variant, including parameters, helper code and textures.

Follow the [vitecache skill](https://github.com/drawcall-ai/vitecache/blob/main/packages/vitecache/skills/vitecache/SKILL.md) to configure the host and generate deployment files. Match the LOD cache location to the app's URL base independently of asset paths. Regenerate stored results when their inputs or bake behavior changes.

Use a lazy impostor for assets that the initial view may never need. Choose its transition before loading, retain a usable finer representation, and keep the bake input alive and unchanged. When assembling levels yourself, combine `LazyImpostor` with a cache decode or bake factory. Prefetch an initial view when drawing its fallback would be too expensive; include application streaming updates before deciding what that view needs.

Seed the camera with `setViewportHeight` before preparing its first view, then update the LODs. Refresh that height after resizing a view whose levels are all culled. Preparation should see the same camera, viewport and instance placement as the first visible frame.

Measure a cold start, a warm reload and a first traversal separately. Persistence avoids rebaking; deferral avoids loading unused atlases. Neither replaces source loading or preparation of the representations that will actually draw. Persist baked meshes as well when they dominate startup, and include loading time when judging a warmup strategy.

## Prepare inputs that survive the transition

- Keep source, simplified geometry, low shells and interiors in a consistent coordinate system. For upright repeated assets, a ground-level pivot makes placement and rotation easier. Use instance colour variation when it can replace separately baked variants.
- Author foliage with alpha-tested cutouts and colour beyond the visible texture edges. Inspect the source at distance before baking: dark transparent texels can darken its small mips and every representation derived from them.
- Match a low shell to the source's occupied shape. Close it where the source is closed, preserve important silhouette features, and remove faces that will never be seen so visible surfaces receive the texture space. Generate shell and source from the same parameters when possible.
- Keep rooms separate from the exterior while authoring. Place their boundaries just behind the corresponding windows and favour furnishings near walls. When assembling with `bakeMesh` directly, attach the rooms to the source for the near view as well as supplying them to the bake.
- For repeated ground cover, jitter position and rotation to avoid aligned gaps in baked views. Place a patch's canopy near the tops of the cover and use side walls only at the exposed outer boundary. Avoid interior walls that become cliffs during the transition. Preserve continuity across tile borders, and reduce isolated tall features in the bake input if they dominate the top view while barely contributing from the intended viewing angle.

## Tune the complete scene

Tune transitions in the intended viewport with `Lod.debug`, then inspect motion through them. Use `Lod.quality` for a scene-wide adjustment and individual thresholds to fix specific assets. Keep application-managed detail ranges consistent with LOD's screen-size convention. When an impostor must take over earlier, give its bake the same intended maximum screen size and check coverage and colour at the handover.

Group nearby copies into spatial regions. Compare a few large batches with smaller regions: excessively broad batches lose useful culling, while tiny batches spend too much time submitting draws. Detailed sources and cheap distant impostors may need different region sizes. Reuse streaming slots and update only changed matrices or colours instead of rebuilding whole batches during movement.

Count material groups as well as triangles. Merge compatible parts before instancing when draw submission dominates; a texture atlas alone does not combine draws. Keep parts separate when merging changes thin surfaces, overlap or shadows. Compare atlas memory, resolution and mip quality as well as draw counts, and preserve the authored bake source through the transformation.

Judge impostors by their covered screen area and overlap, not just their triangle count. Compare many individual cards with a baked patch for dense cover. Keep parallax when close impostors show doubled features; consider reducing it only for representations that remain small, then inspect transitions from several angles.

Compare completed frame time under fixed camera movement, viewport, pixel ratio, multisampling, shadows, wind and thresholds. Measure CPU work and GPU completion separately, keep expensive diagnostic overlays outside the measurement, and recheck the baseline to catch background-load drift. Fewer draws can still lose to worse culling, shading or memory costs. Include the first traversal as well as a warm repeat, using the same movement history so streaming and shadow state are comparable.
