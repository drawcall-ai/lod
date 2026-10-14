---
name: impostor
description: Use @drawcall/impostor to replace distant Three.js objects (trees, rocks, props) with octahedral impostors — baking, instancing, hand-off to real geometry, shadows, and saving as .glts. Use when drawing many copies of a mesh at a distance or exporting an impostor; not for animated or skinned-in-motion objects, transparent glass, or objects always seen up close.
---

# Octahedral impostors with @drawcall/impostor

## The three steps

```ts
import { ImpostorMesh, bakeImpostor, fadeObject, writeImpostorGlts } from "@drawcall/impostor";

const impostor = await bakeImpostor(model, { renderer }); // 1. bake: plain data in memory
const far = new ImpostorMesh(impostor, count, { fadeBand: [0.06, 0.09] }); // 2. render
far.setMatrixAt(i, matrix); // the source object's model matrix; identity = where it was baked
const source = writeImpostorGlts(impostor); // 3. optional: a self-contained .glts
```

## From the command line

`npx @drawcall/impostor-cli model.glb` writes `model.impostor.glts` next to it (also
`.gltf`; `--layout hemi`, `--resolution 64|128|256|512`, `--out file`). It runs in plain
Node via webgl-node (GPU, or Mesa's software driver on GPU-less Linux). `.glts` scenes
cannot be loaded in Node; bake them in the browser with `bakeImpostor`.

## Rules that matter

- **Matrices are the source object's model matrices.** Identity draws it where it was
  baked. Do not offset for the bounding-box centre; the mesh does that.
- **Bake the object at the origin of its own space.** Its own transform is ignored.
  Bake once per species, not per instance; meshes of one impostor share textures.
- **Pick the layout by how it is seen.** `"full"` (default) works from every side,
  including below and for tumbling or rotated instances. `"hemi"` covers only views
  from the horizon up: the same quality for objects that always stand upright (trees,
  rocks, buildings), with about 45% less memory.
- **Hand-off uses the same band on both sides.** `new ImpostorMesh(impostor, count, { fadeBand: [lo, hi] })`, then
  `fadeObject(realCopy, impostor, mesh.fadeBand)` so both share one `Vector2`. The band is in
  subtense (bounding diameter ÷ distance), so one band fits every species. Typical:
  `[0.06, 0.09]`. `fadeObject` replaces the materials with faded copies, so call it
  on the objects used for near geometry, not on a shared source you still render plainly.
  For one material shared across instances, `fadeMaterial(material, impostor, band, toRoot)`
  patches it in place; `toRoot` maps its mesh's space into the baked object's space.
  It fades colour only: hide the real objects past the band (distance check or
  `THREE.LOD`), or their shadows and draw cost stay.
- **Shadows:** set `castShadow = true` on the ImpostorMesh; `receiveShadow = true` looks
  shadows up at the reconstructed surface. Real meshes cast unfaded shadows.
- **Without .glts:** `encodeImpostor(impostor)` gives one KTX2 file, and `decodeImpostor(bytes or base64)`
  reads it back synchronously.
- **Canvas alpha:** alpha-to-coverage leaves fractional alpha; use an opaque
  `scene.background` or `new WebGLRenderer({ alpha: false })`, or edges show the page.
- **MSAA:** silhouettes are best on multisampled targets (`antialias: true` or
  `samples > 0`). Without MSAA a dithered cut-off is used automatically.
- **`.glts` loading:** check `object.isImpostorMesh`, never `instanceof ImpostorMesh`
  (the script loads its own copy of the package).
- **Size:** each layer is `(frames · resolution)²` × 4 bytes: a full 16 × 128 bake with
  three layers is 48 MB raw (64 MB on the GPU with mips), hemi 12 × 128 is 27 MB. The
  impostor stays sharp up to about `resolution` px on screen; `resolution: 64` quarters
  the size for far-only use.

## Not a fit

Moving or animated objects, glass and other blended transparency (baked as coverage),
objects the camera gets close to without real geometry to hand off to, and emissive
values above 1 (clipped).
