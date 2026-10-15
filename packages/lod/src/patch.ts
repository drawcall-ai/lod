/** One shader edit: replace `anchor` in a stage's source. */
export type Edit = [stage: "vertex" | "fragment", anchor: string, replacement: string];

const missing = (search: string) => new Error(`@drawcall/lod: shader chunk "${search}" not found`);

/**
 * `source.replace(search, replacement)` for shader chunks that fails loudly when the
 * anchor is gone (a three update, a user's onBeforeCompile) instead of rendering
 * garbage. The replacement is inserted literally: `$` in GLSL is never a pattern.
 */
export function replaceOrThrow(source: string, search: string, replacement: string): string {
  if (!source.includes(search)) throw missing(search);
  return source.replace(search, () => replacement);
}

/** Applies `edits` in order to a shader about to compile. */
export function applyEdits(shader: { vertexShader: string; fragmentShader: string }, edits: Edit[]): void {
  for (const [stage, anchor, replacement] of edits)
    if (stage === "vertex") shader.vertexShader = replaceOrThrow(shader.vertexShader, anchor, replacement);
    else shader.fragmentShader = replaceOrThrow(shader.fragmentShader, anchor, replacement);
}
