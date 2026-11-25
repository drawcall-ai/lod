import { LoaderUtils } from "three/webgpu";

const absolute = /^[a-z][a-z\d+.-]*:/i;
/**
 * An origin no URL has: paths parse against it where there is no document to resolve them against, and Node loads
 * load the app's public files at it, as a page of the app loads them from its own, through a manager that maps its URLs
 * to the files.
 */
export const placeholderOrigin = "https://lod.invalid";

/** Resolve a relative asset path without changing absolute URLs or root-relative paths. */
export function loaderPathURL(url: string, base: string): string {
  return absolute.test(url) || url.startsWith("/") ? url : LoaderUtils.resolveURL(url, base);
}

/** What relative URLs resolve against: the page, else an origin no URL has. */
const page = (): string => (typeof document === "undefined" ? placeholderOrigin : document.baseURI);

/** The URL the app is served at: the directory holding `basePath`, the URL it serves its cache at. */
export function appBase(basePath: string): string {
  return new URL("..", new URL(basePath, page())).href;
}

/**
 * `url` as a path below `base`, the URL the app is served at, such as `/tree/model.glts`, when the app serves it, so
 * that what is stored for it does not depend on where the app is deployed; any other URL, absolute.
 */
export function publicPath(url: string, base: string): string {
  const resolved = new URL(url, page());
  const root = new URL(base, page());
  if (resolved.origin !== root.origin || !resolved.pathname.startsWith(root.pathname)) return resolved.href;
  return `/${resolved.pathname.slice(root.pathname.length)}${resolved.search}`;
}

const urlPath = (url: string): string => url.replace(/[?#].*$/s, "");

export function assetPath(url: string): { path: string; extension: string } {
  const path = urlPath(url);
  const extension = /\.(glb|gltf|glts)$/i.exec(path)?.[1]?.toLowerCase();
  if (!extension) throw new Error(`CachedLodLoader: cannot load "${url}": expected a .glb, .gltf or .glts file`);
  return { path, extension };
}

/**
 * `value`, a baked level's low or interior URL, resolved against `source`, the ladder's source URL, the way `source` is
 * written: a relative source gives a relative URL, which the loading manager then resolves as it resolves the source,
 * such as a GLTS script's against the script.
 */
export function sourceRelativeURL(value: string, source: string): string {
  const path = urlPath(source);
  return /^[?#]/.test(value) ? path + value : loaderPathURL(value, LoaderUtils.extractUrlBase(path));
}
