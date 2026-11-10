// TypeGPU can resolve a 'use gpu' function to WGSL only after its build plugin has transformed it, and an app's bundler
// does not transform dependencies, so the package runs the plugin over dist itself (see src/levels/draw.ts).
//
//   pnpm --filter @drawcall/lod build
//
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { transformAsync, type TransformOptions } from "@babel/core";
import typegpu from "unplugin-typegpu/babel";

type SourceMap = NonNullable<TransformOptions["inputSourceMap"]>;

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** Whether `value` is a source map as tsc writes it. */
function isSourceMap(value: unknown): value is SourceMap {
  if (typeof value !== "object" || value === null) return false;
  if (!("version" in value && "file" in value && "mappings" in value && "sources" in value && "names" in value)) return false;
  const { version, file, mappings, sources, names } = value;
  return typeof version === "number" && typeof file === "string" && typeof mappings === "string" && strings(sources) && strings(names);
}

const dist = new URL("../dist/", import.meta.url).pathname;
for (const entry of await readdir(dist, { recursive: true })) {
  if (!entry.endsWith(".js")) continue;
  const path = join(dist, entry);
  const code = await readFile(path, "utf8");
  if (!code.includes("use gpu")) continue;
  const inputSourceMap: unknown = JSON.parse(await readFile(`${path}.map`, "utf8"));
  if (!isSourceMap(inputSourceMap)) throw new Error(`${entry}.map holds no source map`);
  const result = await transformAsync(code, { filename: path, plugins: [typegpu], inputSourceMap, sourceMaps: true, configFile: false, babelrc: false });
  if (!result?.code || !result.map) throw new Error(`unplugin-typegpu left ${entry} as it was`);
  await writeFile(path, `${result.code.replace(/\n\/\/# sourceMappingURL=.*$/, "")}\n//# sourceMappingURL=${basename(path)}.map\n`);
  await writeFile(`${path}.map`, JSON.stringify(result.map));
}
