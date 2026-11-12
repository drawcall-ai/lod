/** Shape of public/assets/manifest.json, which scripts/fetch-assets.ts writes for the credits. Paths are relative to public/assets/. */
export interface Credit {
  name: string;
  authors: string[];
  license: "CC0-1.0";
  source: string;
}

export interface Manifest {
  /** Each variant is an independent GLB at `models/<id>/<variant>.glb`. */
  models: Record<string, { bytes: number; triangles: number; bounds: number[][]; variants: string[]; credit: Credit }>;
  /** Each set's maps are at `textures/<id>/diff.webp`, `nor.webp` and `arm.webp`. */
  textures: Record<string, { bytes: number; credit: Credit }>;
  /** At `hdri/sky.hdr`. */
  hdri: { credit: Credit };
}

/**
 * Whether `value` has the manifest's three sections. Entries are not checked one by one:
 * the file comes from scripts/fetch-assets.ts, and a missing file or an old one is what goes wrong.
 */
export function isManifest(value: unknown): value is Manifest {
  return isRecord(value) && isRecord(value.models) && isRecord(value.textures) && isRecord(value.hdri);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
