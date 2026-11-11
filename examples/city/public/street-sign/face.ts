const GREEN = [0x0f, 0x6b, 0x3d];
const WHITE = [0xf4, 0xf4, 0xee];
const GRIME = [60, 50, 30];

/**
 * The face's sRGB pixels, `w` × `h` with the first row at the bottom, as a DataTexture reads them: a white rounded
 * border on green, the name in white capitals of FONT centred on it, and grime darkening toward the bottom edge.
 */
export function face(text: string, w: number, h: number): Uint8Array {
  const inset = h * 0.07;
  const line = h * 0.035;
  const radius = h * 0.08;
  const glyphs = [...text.toUpperCase()].map((char) => {
    const glyph = FONT[char];
    if (!glyph) throw new Error(`The sign font has no ${JSON.stringify(char)}`);
    return glyph;
  });
  const columns = glyphs.length * 6 - 1;
  // Pixels per font cell: the capitals fill 56% of the height, narrowed to fit inside the border.
  const cell = Math.min((h * 0.56) / 7, (w - 6 * inset) / columns);
  const left = (w - columns * cell) / 2;
  const top = h * 0.53 - 3.5 * cell;
  const data = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    // Measured from the top, as the face is drawn.
    const y = h - 1 - row + 0.5;
    const grime = (y / h) * 0.12;
    for (let x = 0; x < w; x++) {
      const border = Math.abs(roundedBox(x + 0.5 - w / 2, y - h / 2, w / 2 - inset, h / 2 - inset, radius)) < line / 2;
      const color = border || inked(glyphs, (x + 0.5 - left) / cell, (y - top) / cell) ? WHITE : GREEN;
      const at = (row * w + x) * 4;
      for (let c = 0; c < 3; c++) data[at + c] = Math.round((color[c] ?? 0) * (1 - grime) + (GRIME[c] ?? 0) * grime);
      data[at + 3] = 255;
    }
  }
  return data;
}

/** The signed distance from (x, y) to a box of half size (bx, by) about the origin with corners of `radius`. */
function roundedBox(x: number, y: number, bx: number, by: number, radius: number): number {
  const qx = Math.abs(x) - bx + radius;
  const qy = Math.abs(y) - by + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Whether font cell (column, row) of `glyphs` laid side by side, a blank column between them, is inked. */
function inked(glyphs: readonly string[][], column: number, row: number): boolean {
  if (column < 0 || row < 0 || row >= 7) return false;
  const glyph = glyphs[Math.floor(column / 6)];
  return glyph?.[Math.floor(row)]?.[Math.floor(column % 6)] === "#";
}

/** A 5 × 7 pixel font of capitals, rows from the top. */
const FONT: Record<string, string[]> = {
  A: [" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  B: ["#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "],
  C: [" ### ", "#   #", "#    ", "#    ", "#    ", "#   #", " ### "],
  D: ["#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "],
  E: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"],
  F: ["#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "],
  G: [" ### ", "#   #", "#    ", "# ###", "#   #", "#   #", " ####"],
  H: ["#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"],
  I: [" ### ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "],
  J: ["  ###", "   # ", "   # ", "   # ", "   ##", "   # ", "###  "],
  K: ["#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"],
  L: ["#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"],
  M: ["#   #", "## ##", "# # #", "#   #", "#   #", "#   #", "#   #"],
  N: ["#   #", "##  #", "# # #", "#  ##", "#   #", "#   #", "#   #"],
  O: [" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  P: ["#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "],
  Q: [" ### ", "#   #", "#   #", "#   #", "# # #", "#  # ", " ## #"],
  R: ["#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"],
  S: [" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "],
  T: ["#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "],
  U: ["#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "],
  V: ["#   #", "#   #", "#   #", "#   #", "#   #", " # # ", "  #  "],
  W: ["#   #", "#   #", "#   #", "# # #", "# # #", "# # #", " # # "],
  X: ["#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"],
  Y: ["#   #", "#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "],
  Z: ["#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"],
  " ": ["     ", "     ", "     ", "     ", "     ", "     ", "     "],
  ".": ["     ", "     ", "     ", "     ", "     ", "##   ", "##   "],
};
