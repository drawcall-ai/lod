/**
 * How an owner takes wind: it refuses it once it has rendered or prepares levels, whose shaders would then build in a
 * frame; else it pads its setup-only culling and casters, while selection and fades keep their rest bounds.
 */
export const WIND = Symbol("wind");

export interface WindOwner {
  [WIND](padding: number, slope: number, baseY: number): void;
}
