/**
 * Whether this runs in Node, as the vitecache plugin builds levels there. Work there stays on the calling thread: the
 * Worker @drawcall/webgpu installs runs no module workers and ends with its canvas, which a later load outlives.
 */
export const inNode = typeof process !== "undefined" && process.versions?.node !== undefined;
