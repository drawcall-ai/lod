// What a simplified level is asked for: read by the loader, which keys levels by it without loading the simplifier.

export interface SimplifyOptions {
  /** share of each mesh's triangles that remains, in (0, 1]; default 0.5 */
  ratio?: number;
  /**
   * Largest screen height of this level, in CSS pixels. Finite and with `ratio` below 1, the tessellation inside the
   * remaining foliage cards simplifies to one pixel's error at that height, outlines kept; the cards of a geometry with
   * attributes beyond position, normal and uv, which the error does not measure, keep theirs.
   */
  maxPixels?: number;
}

/** The error, relative to each mesh's size, to which the inside of foliage cards simplifies: 0 keeps them as they are. */
export function cardError({ ratio = 0.5, maxPixels = Infinity }: SimplifyOptions): number {
  return ratio < 1 ? Math.min(1, 1 / maxPixels) : 0;
}
