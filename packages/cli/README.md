# @drawcall/impostor-cli

Bakes `.glb` / `.gltf` models into octahedral impostor `.glts` files with
[@drawcall/impostor](https://github.com/drawcall-ai/impostor), in plain Node: no browser.

```sh
npx @drawcall/impostor-cli tree.glb                     # → tree.impostor.glts
npx @drawcall/impostor-cli rock.glb --layout hemi       # upright-only objects: ~45% less memory
npx @drawcall/impostor-cli assets/*.glb --resolution 64 # far-only use: about a third of the file size
```

```
impostor <input...> [--layout full|hemi] [--resolution 64|128|256|512] [--out file]
```

- `--layout`: `full` (default) works from every side; `hemi` only from the horizon up.
- `--resolution`: pixels per view; the impostor stays sharp up to about this size on screen.
- `--out`: output `.glts` path, for a single input. Otherwise each input becomes
  `<name>.impostor.glts` next to it.

Separate-file glTF, Draco and meshopt inputs are fine. Files that fail are reported and
skipped; the exit code is 1 if any failed. `.glts` scenes cannot be loaded in Node; bake
those in the browser with `bakeImpostor`.

## Requirements

Node 22+. WebGL2 comes from [webgl-node](https://github.com/monteslu/webgl-node) on the
system's OpenGL ES driver: the GPU on macOS and Windows, and on Linux the GPU or, on
machines without one, Mesa's software driver:

```sh
apt install libegl1 libgles2 libegl-mesa0 libgl1-mesa-dri
```

pnpm 10 blocks install scripts by default; allow the native ones with
`pnpm approve-builds` (`native-gles`, `sharp`).
