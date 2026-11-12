import { LoaderUtils } from "three/webgpu";

const absolute = /^[a-z][a-z\d+.-]*:/i;
/**
 * An origin no URL has: paths parse against it where there is no document to resolve them against, and Node loads
 * fetch the app's public files at it, as a page of the app fetches them from its own.
 */
export const placeholderOrigin = "https://lod.invalid";

/** Resolve a relative asset path without changing absolute URLs or root-relative paths. */
export function loaderPathURL(url: string, base: string): string {
  return absolute.test(url) || url.startsWith("/") ? url : LoaderUtils.resolveURL(url, base);
}

/** What relative URLs resolve against: the page, else an origin no URL has. */
const page = (): string => (typeof document === "undefined" ? placeholderOrigin : document.baseURI);

/**
 * `url` as a path below the app's base, such as `/tree/model.glts`, when the app serves it, so that what is stored for
 * it does not depend on where the app is deployed; any other URL, absolute.
 */
export function publicPath(url: string, basePath: string): string {
  const resolved = new URL(url, page());
  // The cache's URL includes the app's base.
  const base = new URL("..", new URL(basePath, page()));
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) return resolved.href;
  return `/${resolved.pathname.slice(base.pathname.length)}${resolved.search}`;
}

const urlPath = (url: string): string => url.replace(/[?#].*$/s, "");

export function assetPath(url: string): { path: string; extension: string } {
  const path = urlPath(url);
  const extension = /\.(glb|gltf|glts)$/i.exec(path)?.[1]?.toLowerCase();
  if (!extension) throw new Error(`CachedLodLoader: cannot load "${url}": expected a .glb, .gltf or .glts file`);
  return { path, extension };
}

export function sourceRelativeURL(value: string, source: string): string {
  const base = new URL(source, typeof document === "undefined" ? placeholderOrigin : document.baseURI);
  const url = new URL(value, base);
  return url.origin === base.origin && !absolute.test(source) ? url.pathname + url.search + url.hash : url.href;
}
