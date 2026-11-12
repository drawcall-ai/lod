/** Shape of public/assets/manifest.json, which scripts/fetch-assets.ts writes for the credits. Paths are relative to public/. */
export interface Credit {
  name: string;
  authors: string[];
  license: "CC0-1.0";
  source: string;
}

export interface Manifest {
  /** Each variant is an independent GLB at `models/<id>/<variant>.glb`. */
  models: Record<string, { bytes: number; triangles: number; bounds: number[][]; variants: string[]; credit: Credit }>;
  /** Each set's maps are at `<folder>/textures/<id>/diff.webp`, `nor.webp` and `arm.webp`, in every folder that draws it. */
  textures: Record<string, { bytes: number; credit: Credit }>;
  /** At `assets/hdri/sky.hdr`. */
  hdri: { credit: Credit };
}
