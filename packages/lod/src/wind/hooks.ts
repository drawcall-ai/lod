/** Setup-only culling and caster padding; selection and fades keep their rest bounds. */
export const WIND_BOUNDS = Symbol("wind bounds");

export interface WindBounds {
  [WIND_BOUNDS](padding: number, slope: number, baseY: number): void;
}
