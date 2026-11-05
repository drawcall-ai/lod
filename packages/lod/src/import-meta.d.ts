// What the package reads of the env Vite defines on `import.meta`; see env.ts.
interface ImportMeta {
  readonly env?: { readonly PROD?: boolean; readonly SSR?: boolean };
}
