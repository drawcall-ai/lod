---
name: lod
description: Use @drawcall/lod to give three.js objects levels of detail — load a model and get a simplified mesh, a baked low-poly mesh or an octahedral impostor that switch by on-screen size with a dithered fade, or switch your own levels — including crowds of instances, vegetation swaying in wind, buildings whose windows show the rooms behind them (interior mapping), shadows over large worlds, and preparing models that bake into good impostors. Use when a WebGLRenderer scene has many or large objects seen from far away; not for WebGPURenderer, skinned animation, or glass objects.
---

# Level of detail with @drawcall/lod

## Which part to reach for

- **A model file → `LodLoader`.** It loads the model and builds the cheaper levels at
  load time; the result is a `Lod` you add to the scene. Nothing else to drive: three's
  renderer updates every `Lod` while it renders.
- **Many copies of one object → `InstancedLod`** (`loadInstancesAsync`, or built from
  levels): every copy switches and fades on its own, with one draw per level and mesh.
- **Levels you already have → `new Lod([source, ...levels])`**: any `Object3D` per level,
  another `Lod` included, detailed to cheap. Levels made by this package know how far off
  they are and pick their own switch size; hand-made ones need a `maxPixels`.
- **Only ever far away, never switching → an `ImpostorMesh`** from `bakeImpostor`: one
  instanced draw for thousands of copies.

Which levels to build, by asset:

- **Foliage** — trees, bushes, grass, plants, anything of alpha-tested leaf cards → an
  impostor only (the loader's default). A simplified level in between tears the cards
  apart. A scan that models every leaf in many triangles is different: draw it from its
  own `simplify` copy (around a quarter of the triangles keeps the leaves' shape; far
  fewer smears them) and use that as the source.
- **Hard-surface props** — rocks, vehicles, furniture → simplified, then impostor.
  Low-poly props need no levels: an impostor costs more than they do.
- **Buildings** → baked (experimental), then impostor. The baked level is one low mesh
  carrying the source's colour, normals and roughness in its own textures, so window
  frames, gutters and doors survive as texture, onto a low shell you give it (see
  "Impostor-ready assets").
- **Buildings you can see into** → the same, plus an `interior`: the rooms as a model of
  their own. Up close the real rooms show through the real glass; the baked level shows
  each room through its windows by interior mapping — a picture of the room that shifts
  with the view, at no geometry cost.
- **Dense patches of plants** (a block of corn, a patch of grass) → the plants as an
  `InstancedLod` (source, impostor, then an empty level so far plants draw nothing), and
  one `bakeMesh` of a patch's plants onto a canopy as the far level of the patches
  (see "Impostor-ready assets").

```ts
import { Lod, LodLoader, bakeMesh } from "@drawcall/lod";

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

// A patch: its plants up close, one mesh baked from all of them further away.
const plants = await loader.parseInstancesAsync(plant, places.length);
places.forEach((place, i) => plants.setMatrixAt(i, place));
scene.add(new Lod([plants, await bakeMesh(plants, { low: shell })]));

Lod.debug = true; // tint levels to see where each draws
```

## How the parts combine

- **Vegetation in wind:** build and bake the resting asset first, then apply one `Wind`
  to the completed `Lod` or `InstancedLod`. Update its time before rendering. This keeps
  source, simplified, baked and impostor levels together during transitions; share the
  same breeze across plants. Apply to individual plants or their instance batches,
  rather than a whole forest hierarchy. Broad sway moves the whole plant; it does not
  animate individual branches or leaves. Independent objects attached to a plant need
  to follow its motion too.

- **Switching is by on-screen height in CSS pixels:** a high-density screen picks the
  levels a standard one does and pays for its extra pixels in fill only. `Lod.quality`
  scales every measurement: below 1, cheaper levels take over sooner — the global
  performance knob (set it to the pixel ratio to switch by device pixels).
- **Near a switch both levels draw** and split the pixels with a dither, so nothing pops.
  Elsewhere only one level is visible: hidden levels cost nothing and cast no shadow.
  Each level's switch size must stay far enough below the previous one's for one fade to
  end before the next begins; the `Lod` throws otherwise.
- **Nested `Lod`s** switch their own levels; the parent hands over to and from them
  without the dither, and a hidden parent level hides everything inside.
- **Clone instead of loading twice:** loading builds and bakes every time; `clone()`
  shares geometry and textures. For hundreds of copies use `InstancedLod`, as a `Lod` per
  copy costs draws per copy.
- **`InstancedLod` sorts on the CPU** when the camera or a matrix moved. Keep its own
  transform uniformly scaled (instances may scale any way). Its levels are templates,
  not scene objects; they cannot hold nested `Lod`s or InstancedMeshes. Each level is
  culled by the bounds of the instances it draws, in the view and in every shadow map,
  but the cheapest level spans nearly the whole crowd: over a large area, one
  `InstancedLod` per region lets regions out of view skip their draws.
- **Hierarchies on top** (a field whose plants exist only near the camera): level 0 may
  be an empty `Object3D`, and the `Lod` measures by the first level that draws. Draw the
  detail yourself where level 0 shows: `levelOf` on an `InstancedLod`, `visible` on a
  `Lod`'s level. `Lod.fade` is the share of a level's `maxPixels` its fade spans.
- **Saving results:** only impostors can be saved and loaded again (`encodeImpostor`,
  `decodeImpostor` → `ImpostorMesh`); simplified and baked levels are built at load time.
  A package update that bakes differently refuses older files ("unsupported version"):
  bake them again, and empty any cache of them.
- **`dispose()` frees everything,** the source included. Clones share geometry and
  textures: dispose only once no clone draws any more.

## Impostor-ready assets

- **Units and pivot:** Y up, metres, origin at the ground under the object, so instance
  matrices place it standing. Vary copies cheaply with per-instance colour
  (`setColorAt`): every variant model costs its own levels and bakes.
- **Foliage leaves are alpha-tested** (glTF `MASK`, never `BLEND`), the alpha in the base
  colour texture, and the colour bled out into the transparent texels: black there
  darkens every mip, so the source darkens with distance and its bakes with it.
- **Custom lighting is not baked.** Impostors and baked levels keep the surface (colour,
  normal, roughness) and light it as a standard material: lighting changed in
  `onBeforeCompile`, such as leaves glowing in back light, is lost, and such foliage
  reads darker once its impostor shows, worst against the light. Give the impostor the
  same lighting: once the `Lod` or `InstancedLod` is built, wrap the `onBeforeCompile` of
  each `ImpostorMesh` under it (call the one it has first, extend `customProgramCacheKey`)
  and insert your code before `void main()`. Its shader defines `IMPOSTOR_LIT`; its
  normal is an average whose length says how far the leaves under it agree, so light by
  `impostorCosine(normal, direction)` where you would clamp `dot(normal, direction)`.
- **Alpha changed in `onBeforeCompile`** (a boost that keeps distant leaves from thinning
  out) never reaches shadow maps: three casts with its own depth material, while an
  impostor casts the coverage it shows, so the shade in and under the object changes as
  its impostor takes over. Once the `Lod` or `InstancedLod` is built, give each mesh
  under it that draws such a material a `customDepthMaterial` (`customDistanceMaterial`
  for point lights) with the same change; three hands it the drawn material's `map` and
  alpha test. The level meshes do not keep one set on the source. A mesh has one depth
  material for all its groups, so such leaves need a mesh of their own.
- **Jitter dense plantings** in position and rotation. Bakes and impostor views look
  along parallel rays: plants on a grid leave straight gaps there that no perspective
  view of the real plants shows.
- **A building's low shell** is geometry only, generated from the same parameters as the
  building and in its space. Parts it leaves out (a chimney) show only as texture and
  lower the level's switch size. Close it where the source is closed (a floor for a
  floor); leave out faces nobody sees, which take texture space from those that are
  seen. Make glass see-through and the rooms their own model (see "Interiors").
- **A canopy for a patch of plants** sits at the leaf tops, with side walls only on the
  outer edge of the whole field: inner walls show as a cliff where plants hand over.
  Rays that find no leaf at the top bake the leaves further down, so the canopy needs
  nothing under it. Whatever stands above the leaves (tassels, flowers) covers far more
  of a top-down bake than of any view across the field: bake the canopy from plants
  with fewer of them. Lay out the patch so rows run on across its borders, then copies
  tile without seams. Switch the plants on top per plant, by their own distance, not
  per patch: the hand-over then follows a smooth contour around the camera instead of
  patch edges.

## Performance

- **Tune switch sizes on a standard screen.** They are in CSS pixels, so the choice holds
  on a high-density one; size anything of your own that reacts to on-screen size (how
  far plants exist, how many) in CSS pixels too, or a high-density screen multiplies it.
- **A heavy source decides the frame** wherever many copies show it at once (inside a
  forest). Lighten the source first, then let its impostor take over earlier — a larger
  `maxPixels` on the impostor level: lowering it keeps more copies at the source. Bake
  that impostor with the same `maxPixels`: above its default it shows its top mip
  magnified, which otherwise keeps the look of the source at the bake's size — foliage
  denser and darker than the leaves it replaces up close.
- **Impostors cost fill.** Every pixel of a card runs the shader, and the depth-parallax
  walk is most of it. Keep parallax for impostors seen large — without it they ghost
  (doubled trunks) — and turn it off only for impostors that only ever show small or
  densely packed, such as a field's plants.
- **On high-density screens** multisampling costs a large share of the frame. Two samples
  keep most of the quality; none makes thin geometry (twigs, grass) crawl in motion,
  while impostors fall back to a dithered edge that holds up. The canvas's `antialias`
  takes the browser's sample count: to choose it, render into a target with `samples`.

## Shadows

- **Levels are chosen once, from the viewing camera,** and every shadow map draws the
  same ones: far cascades see impostors and baked levels, never the sources. During a
  fade the finer level casts alone: an impostor taking over casts once it is gone.
- **Casters narrower than a texel** of a directional light's shadow map draw nothing into
  it (a `Lod` by its whole object, an `InstancedLod` level by its largest instance), so
  coarse cascades skip small crowds by themselves.
- **Cascaded or custom shadows: patch three's `ShaderChunk`s,** not single materials.
  Changed chunks reach every faded copy and every impostor, whenever they were built, as
  long as the patch runs before those materials first compile. Impostors light from the
  surface they resolve, so a patch that computes shadow coordinates from
  `geometryPosition` works for them unchanged. A per-material setup (three's `CSM` addon)
  must run on the level meshes' materials after the `Lod` is built: the material you
  passed in is no longer drawn.
- **Open models leak light** (eaves, window reveals, single walls): three casts with back
  faces only. Set `shadowSide = DoubleSide` on their materials, with about a texel of
  shadow `bias` against acne.
- **Under reversed depth,** three's PCF shadows darken everything beyond the shadow
  camera's `far`: set it to reach past everything that receives shadows.

## Pitfalls

- **Materials are replaced.** A `Lod` draws each mesh with its own faded copy of the
  material; the material you passed in is no longer drawn. Edit the material on the
  level's mesh after building. Custom `ShaderMaterial`s need three's standard chunks.
- **Levels are read once,** when the `Lod` is built: meshes added or moved later are
  neither faded nor measured right. Build a new `Lod` instead.
- **Skinned meshes are refused,** and animation is ignored.
- **Orthographic cameras** switch by on-screen size too, but swap levels at once.
- **Several cameras:** each is measured at the viewport height it last drew the `Lod`
  at; a camera's first frame assumes a typical screen.
- **Many `Lod`s appearing at once hitch** while three sets up each mesh's material; draw
  crowds with `InstancedLod`.
- **Lines, points and sprites** in a level draw but do not fade. Raycasts hit the source
  only, whatever level shows.
- **Canvas alpha:** impostor edges use alpha-to-coverage, which leaves fractional alpha
  in the canvas, so the page shows through, even with `alpha: false` in Chrome. Force
  alpha to 1 after each frame with a pass that keeps the colour. Do not do it with raw GL
  and `renderer.resetState()`: the reset turns off reversed depth.

  ```ts
  import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

  const opaque = new FullScreenQuad(
    new THREE.MeshBasicMaterial({
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.OneFactor, // colour stays
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.ZeroFactor, // alpha becomes 1
      depthTest: false,
      depthWrite: false,
    }),
  );

  renderer.render(scene, camera);
  renderer.autoClear = false;
  opaque.render(renderer);
  renderer.autoClear = true;
  ```

- **Impostor layout `"hemi"`** covers views from the horizon up only: right for upright
  trees, rocks and buildings, wrong for anything seen from below.
- **`.glts` models need a registered loader:** `manager.addHandler(/\.glts$/i, new
GLTSLoader(manager))`. Inside a `.glts` script, register the contextual `gltsLoader` on
  the contextual `loadingManager` instead, and check `object.isImpostorMesh`, never
  `instanceof`: a script has its own copy of the package.
- **Baking a mesh is slow and CPU-bound** on the loading thread (it yields between
  chunks), and each baked level has its own textures in GPU memory. Bake once per model
  and clone; time and memory grow with `textureSize` squared, so small or only-far
  objects bake faster at a smaller one.
- **Baked levels read textures on the CPU:** compressed textures (KTX2) fail the bake.
  Emissive, clearcoat and transmission are not baked; glass bakes opaque in its own
  colour unless it looks into an interior. Only alpha-tested surfaces cut holes.
- **Specular level** (`ior`, `specularIntensity`, `specularColor`, glTF
  `KHR_materials_specular`) reaches an impostor only as one average for the whole object,
  so parts or maps that differ in it reflect alike; baked levels reflect like a plain
  dielectric, so a source with its specular turned down shows brighter at them.
- **Clones of a built level** made by hand lose the measured error their switch size
  comes from; clone the whole `Lod` instead.
- **Large worlds** (kilometres to millimetres) z-fight with the default depth buffer.
  Every level works with three's `reversedDepthBuffer` or `logarithmicDepthBuffer`.
  Reversed depth only gains precision in a float depth buffer, which the canvas does not
  have: render into a target with a `FloatType` `DepthTexture`.

## Interiors

- **Rooms are their own model,** never part of the building's: only rooms given as the
  interior are left out of the baked exterior and shown through its windows. One baked
  level per model takes an interior.
- **One direct child per room, filling its box:** walls, floor and ceiling on the box's
  faces, facing in. Rooms must not overlap; doorways between them, stairwells and
  several storeys are fine. A room's box should begin at the inside of
  the wall its windows are in; glass with no room just behind it stays plain glass.
- **The glass must be see-through in the source:** transparent with opacity below 1, or
  transmissive. Dark but opaque glass gives no windows, and the bake fails when no glass
  looks into a room.
- **Rooms are lit by the light reaching the window** — ambient, light probes and the
  environment, not the sun, which the walls would block — so they darken with the scene.
  For a dimmer room, darken its materials.
- **Lamps glow through emissive (or unlit) materials.** Lights in an interior are
  refused: wherever the source draws they would be scene lights, recompiling every lit
  material at each switch.
- **Furniture against a wall looks right;** things standing free in the room flatten
  onto the walls behind them.
- **Calling `bakeMesh` yourself:** pass the interior and put it inside the source, so the
  source shows the real rooms; the bake leaves it out of the exterior either way.
