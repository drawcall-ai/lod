/**
 * Whether this runs in Node, as the vitecache plugin builds levels there. The Worker @drawcall/webgpu installs there
 * runs no module workers and ends with its canvas, which a later load outlives: work runs in Node's worker threads or
 * on the calling thread.
 */
export const inNode = typeof process !== "undefined" && process.versions?.node !== undefined;

/** A module Node has and browsers do not, imported by a name bundlers do not see, so that they keep it out of pages. */
export function nodeOnly<T>(name: string): Promise<T> {
  return import(/* @vite-ignore */ name);
}
