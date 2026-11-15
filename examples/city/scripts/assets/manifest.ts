/** Shape of public/assets/manifest.json, which scripts/fetch-assets.ts writes for the credits. Paths are relative to public/. */
export interface Credit {
  name: string;
  authors: string[];
  license: "CC0-1.0";
  source: string;
}

export interface Manifest {
  /** Each set's maps are at `assets/textures/<id>/diff.webp`, `nor.webp` and `arm.webp`. */
  textures: Record<string, { bytes: number; credit: Credit }>;
  /** At `assets/hdri/sky.hdr`. */
  hdri: { credit: Credit };
}
