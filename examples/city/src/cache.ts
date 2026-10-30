import { CacheEntry, type Dependencies } from "vitecache";

/**
 * Host computations have no running GLTS source; track their code directories and declared runtime packages.
 * Globbed on use, so that Node tests can import the cached-value readers below without Vite.
 */
export function hostEntry(version: string, inputs: Dependencies): CacheEntry {
  const files = Object.keys(import.meta.glob(["./world/**/*.ts", "./render/**/*.ts", "../public/content/**/*.ts"]))
    .map((path) => (path.startsWith("../") ? path.slice(3) : `src/${path.slice(2)}`))
    .sort();
  const packages = Object.values(import.meta.glob<Record<string, string>>("../package.json", { eager: true, import: "dependencies" }))
    .flatMap(Object.keys)
    .sort();
  const source: Dependencies = {
    ...Object.fromEntries(files.map((path, index) => [`code:${index}`, { path }])),
    ...Object.fromEntries(packages.map((name) => [`package:${name}`, { package: name }])),
  };
  return new CacheEntry({ version, dependencies: { ...source, ...inputs } });
}

export function cachedRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid cached object");
  return Object.fromEntries(Object.entries(value));
}

export function cachedNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid cached number");
  return value;
}

export function cachedNumbers(value: unknown, count: number): number[] {
  if (!Array.isArray(value) || value.length !== count) throw new Error("Invalid cached dimensions");
  return value.map(cachedNumber);
}
