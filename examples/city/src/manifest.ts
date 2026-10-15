/** Shape of assets/manifest.json, written by scripts/fetch-assets.ts. Paths are relative to assets/. */
export interface Credit {
  name: string;
  authors: string[];
  license: "CC0-1.0";
  source: string;
}

export interface Manifest {
  /** `variants` names the top-level nodes: Poly Haven lays several variants of a plant side by side. */
  models: Record<string, { file: string; bytes: number; triangles: number; bounds: number[][]; variants: string[]; credit: Credit }>;
  /** `size` is the real-world width and height in metres that one repeat of the texture covers. */
  textures: Record<string, { diff: string; nor: string; arm: string; size: number[]; bytes: number; credit: Credit }>;
  hdri: { file: string; credit: Credit };
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
