import type { Texture } from "three/webgpu";
import * as pixels from "./pixels.ts";
import { HouseAtlas } from "../content/house/atlas/material.ts";
import { TextureArray } from "../content/house/atlas/textures.ts";
import { textureFile, texturesReady, type Surface } from "../content/materials.ts";
import { bundle, file } from "./cache.ts";
import { number, record } from "./data.ts";

const arrays = new Map<string, Promise<TextureArray>>();

/** Variants share pixel payloads and GPU arrays; only their material rows differ. */
export async function houseAtlas(surfaces: readonly Surface[], build = false): Promise<HouseAtlas> {
  const channels = ["map", "normalMap", "roughnessMap"] as const;
  const shared = await Promise.all(
    channels.map((channel) => {
      const maps = [
        ...new Map(
          surfaces.flatMap((material) => {
            const map = material[channel];
            return map ? [[path(map), map] as const] : [];
          }),
        ).entries(),
      ].sort(([a], [b]) => a.localeCompare(b));
      const sources = maps.map(([, map]) => map),
        first = sources[0];
      if (!first) throw new Error(`House atlas ${channel} has no images`);
      const settings = {
        format: first.format,
        type: first.type,
        colorSpace: first.colorSpace,
        wrapS: first.wrapS,
        wrapT: first.wrapT,
        minFilter: first.minFilter,
        magFilter: first.magFilter,
        anisotropy: first.anisotropy,
        premultiplyAlpha: first.premultiplyAlpha,
        flipY: first.flipY,
      };
      const dependencies = {
        ...Object.fromEntries(maps.map(([path], index) => [`image:${index}`, { path }])),
        settings: { value: settings },
        codec: { path: "src/content/house/atlas/textures.ts" },
        cache: { path: "src/world/house-atlas.ts" },
      };
      const key = JSON.stringify(dependencies);
      let pending = arrays.get(key);
      if (!pending) {
        pending = (async () => {
          let made: TextureArray | undefined;
          const files = await bundle("house-array@1", dependencies, async () => {
            if (!build) throw new Error(`Missing cached house texture array ${channel}`);
            await texturesReady(surfaces);
            made = new TextureArray(sources, `house ${channel}`, undefined, path);
            const { width, height, depth, data } = made.pixels;
            return {
              metadata: new TextEncoder().encode(JSON.stringify({ width, height, depth })),
              pixels: await pixels.encode(data),
            };
          });
          if (made) return made;
          const data = record(JSON.parse(new TextDecoder().decode(file(files, "metadata"))));
          const width = dimension(data.width),
            height = dimension(data.height),
            depth = dimension(data.depth);
          return new TextureArray(
            sources,
            `house ${channel}`,
            {
              width,
              height,
              depth,
              data: await pixels.decode(file(files, "pixels"), width * height * depth * 4),
            },
            path,
          );
        })();
        arrays.set(key, pending);
      }
      return pending;
    }),
  );
  return new HouseAtlas(surfaces, shared);
}

function path(texture: Texture): string {
  const file = textureFile(texture);
  if (!file) throw new Error(`House atlas texture ${texture.name} has no source file`);
  return file;
}

function dimension(value: unknown): number {
  const size = number(value);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid house texture array dimension");
  return size;
}
