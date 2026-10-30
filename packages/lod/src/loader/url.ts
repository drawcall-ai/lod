import { LoaderUtils } from "three/webgpu";

const absolute = /^[a-z][a-z\d+.-]*:/i;
const fallbackBase = "https://lod.invalid";

/** Resolve a relative asset path without changing absolute URLs or root-relative paths. */
export function loaderPathURL(url: string, base: string): string {
  return absolute.test(url) || url.startsWith("/") ? url : LoaderUtils.resolveURL(url, base);
}

export const urlPath = (url: string): string => url.replace(/[?#].*$/s, "");
export const urlQuery = (url: string): string => new URL(url, fallbackBase).search;

export function assetPath(url: string): { path: string; extension: string } {
  const path = urlPath(url);
  const extension = /\.(glb|gltf|glts)$/i.exec(path)?.[1]?.toLowerCase();
  if (!extension) throw new Error(`LodLoader: cannot load "${url}": expected a .glb, .gltf or .glts file`);
  return { path, extension };
}

export function sourceRelativeURL(value: string, source: string): string {
  const base = new URL(source, typeof document === "undefined" ? fallbackBase : document.baseURI);
  const url = new URL(value, base);
  return url.origin === base.origin && !absolute.test(source) ? url.pathname + url.search + url.hash : url.href;
}

/** A same-origin path, as localURL leaves it: vitecache can resolve only these to project files. */
export const isLocal = (url: string): boolean => url.startsWith("/") && !url.startsWith("//");

/** Keep same-origin dependencies portable between development and deployment. */
export function localURL(url: string): string {
  if (typeof location === "undefined" || !/^https?:/i.test(url)) return url;
  const parsed = new URL(url);
  return parsed.origin === location.origin ? parsed.pathname + parsed.search + parsed.hash : url;
}
