# @drawcall/impostor

Octahedral impostors for Three.js. Bake any `Object3D` into an impostor in memory, draw
thousands of them as one `InstancedMesh` lit by your scene, and save one as a
self-contained `.glts` file.

```sh
npm install @drawcall/impostor three
```

```ts
import { ImpostorMesh, bakeImpostor } from "@drawcall/impostor";

const impostor = await bakeImpostor(tree, { renderer }); // plain data, nothing written to disk
const forest = new ImpostorMesh(impostor, 10_000); // a standard InstancedMesh
for (let i = 0; i < 10_000; i++) forest.setMatrixAt(i, placements[i]); // ordinary model matrices
scene.add(forest);
```

Or bake files from the command line, no code:

```sh
npx @drawcall/impostor-cli tree.glb                     # → tree.impostor.glts
npx @drawcall/impostor-cli rock.glb --layout hemi       # upright-only objects: ~45% less memory
npx @drawcall/impostor-cli assets/*.glb --resolution 64 # far-only use: about a third of the file size
```

## How it works

`bakeImpostor` renders the object from a grid of directions on the whole sphere
(or, with `hemi`, the upper hemisphere) and packs the views into one atlas with three RGBA8 layers, plus
`emissive` when something emits light, the same layout Godot's and Amplify's impostor
bakers use:

| Layer         | RGB                                       | A        |
| ------------- | ----------------------------------------- | -------- |
| `base`        | base colour (sRGB)                        | coverage |
| `normalDepth` | object-space normal                       | depth    |
| `orm`         | occlusion, roughness, metalness (glTF)    | front-facing share (two-sided) |
| `emissive`    | emissive colour (sRGB), only when needed  | –        |

`ImpostorMesh` draws one camera-facing card per instance. Per pixel, it intersects the
view ray with the three nearest baked views, walks each to its baked depth (parallax),
blends them by coverage and agreement, and hands the result to `MeshStandardMaterial`.
So impostors are lit by your sun, environment and fog, take instance colours, cast
shadows from directional, spot and point lights shaped by the baked surface depth.
(`pixelDepth: true` also writes that depth in the main view, for exact intersections
with the ground and each other, at the cost of early depth rejection.) Received shadows are looked up at the
reconstructed surface, so a tree's sunlit side stays lit.

Two things to know:

- **Canvas alpha.** Alpha-to-coverage writes fractional alpha, and WebGL has no
  alpha-to-one switch, so on a transparent canvas impostor edges let the page show
  through. Render with an opaque `scene.background`, or create the renderer with
  `alpha: false`.
- **Hide the real object past the band.** `fadeObject` fades only the colour; the real
  mesh keeps casting its full shadow (and costing draw time) wherever it is drawn. Hide
  it beyond the band with a distance check or `THREE.LOD`; inside the band both cast,
  which reads as one slightly denser shadow.

## API

### Bake

```ts
const impostor = await bakeImpostor(object, {
  layout: "full", // default: any orientation; "hemi" for upright-only objects (~45% less memory)
  resolution: 128, // pixels per view, rounded down to a power of two: sharp up to about this size on screen
  renderer, // optional: reuse yours (state is restored, also across the bake's yields)
});
```

Rarely needed: `frames` (views per atlas side), `emissive` (force the layer on or off)
and `supersample` (samples per atlas pixel side); see `BakeOptions`.

The object is baked in its own space; its own transform is ignored. Any mesh,
skinned mesh, instanced mesh or material three can draw works; non-standard
materials bake as rough dielectrics.

### Render

```ts
const mesh = new ImpostorMesh(impostor, count, {
  fadeBand: [0.06, 0.09], // hand-off band, see below
});
mesh.setMatrixAt(i, matrix); // the source object's model matrix; identity = where it was baked
mesh.setColorAt(i, tint);
mesh.castShadow = true;
```

Further options, each documented on `ImpostorMeshOptions`: `alphaTest`, `parallax`,
`tolerance`, `lodBias` and `pixelDepth`. Meshes of the same impostor share its textures. `isImpostorMesh` is `true` on every
mesh, including ones loaded through `.glts` (where `instanceof` cannot work).

### Hand-off to real geometry

Real and impostor dither into each other over a band measured in screen size
(subtense = bounding diameter ÷ distance), so one band suits every species: a 16 m pine
and a 1.5 m bush swap at the same size on screen.

```ts
const mesh = new ImpostorMesh(impostor, count, { fadeBand: [0.06, 0.09] });
fadeObject(nearTree, impostor, mesh.fadeBand); // faded copies of its materials, same band
mesh.fadeBand.set(0.05, 0.08); // moves both sides at runtime
```

`fadeMaterial(material, impostor, band, toRoot)` patches a single material in place
instead; `toRoot` maps its mesh's space into the baked object's.

### Save and load

```ts
const bytes = encodeImpostor(impostor); // one KTX2 file: layers + metadata, zlib-compressed
const again = decodeImpostor(bytes); // synchronous; also accepts base64
const source = writeImpostorGlts(impostor); // a self-contained .glts script
```

A `.glts` loads with `@drawcall/glts`: `loadAsync(url)` gives one impostor,
`loadInstancesAsync(url, n)` gives `n` in one draw call.

### Command line

```sh
npx @drawcall/impostor-cli <input...> [--layout full|hemi] [--resolution 64|128|256|512] [--out file]
```

Each `.glb` or `.gltf` input (separate files, Draco and meshopt are fine) becomes
`<name>.impostor.glts` next to it (`--out` for one input). `--layout` and `--resolution`
are the bake options above. It runs in plain Node, no browser: WebGL2 comes from
[webgl-node](https://github.com/monteslu/webgl-node) on the system's OpenGL ES driver,
the GPU or, on machines without one, Mesa's software driver (Linux:
`apt install libegl1 libgles2 libegl-mesa0 libgl1-mesa-dri`). Files that fail are
reported and skipped; the exit code is 1 if any failed. `.glts` scenes cannot be loaded
in Node; bake those in the browser with `bakeImpostor`.

## Quality and cost

Measured in `examples/lab` against 4×-supersampled renders of the real geometry
(Apple M2 Pro, 12 × 128 px hemi atlas): see the lab for the numbers and images
per subject. 100 000 trees draw in about 6.6 ms GPU time against 215 ms for the real
geometry (350 M triangles).

## Workspace

```sh
pnpm install
pnpm check # build, typecheck, unit tests
pnpm lab # side-by-side viewer: ?subject=tree|pine|dead|knot|pbr|lamp|...
cd examples/lab && npx tsx scripts/eval.ts # quality report + images in .artifacts/eval
```

The lab's scripts render on the real GPU in headless Chromium: `eval.ts` (quality per
subject, size and angle), `probe.ts` (coverage and flicker), `handoff.ts`,
`shadows.ts` and `glts-e2e.ts` (round trip through the real `.glts` loader).

## Agent skill

The package ships `skills/impostor/SKILL.md` for coding agents.
