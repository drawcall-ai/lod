// Where the package runs, which decides what a load builds.

/**
 * Whether this runs in a production server-side build (`import.meta.env.PROD` and `SSR`), which precomputes assets
 * into the deployed cache: every level is built and saved, and a level that cannot be saved fails the build.
 */
export const warmup = import.meta.env?.PROD === true && import.meta.env?.SSR === true;
