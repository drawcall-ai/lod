/**
 * How a Lod or InstancedLod takes wind: it refuses it once it has rendered or prepares levels, whose shaders would then
 * build in a frame; else it pads its setup-only culling and casters, while the levels it draws hold their rest bounds.
 */
export const WIND = Symbol("wind");

export interface WindTarget {
  [WIND](padding: number, slope: number, baseY: number): void;
}
