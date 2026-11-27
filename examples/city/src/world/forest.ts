/** A round patch of forest floor: centre x, z, radius and the phase of its ragged edge and clearings, see `forestEdge`. */
export interface Forest {
  x: number;
  z: number;
  radius: number;
  phase: number;
}

/** The forest radius along `angle` in the x/z plane, including its lobes and ragged edge. */
export function forestEdge(radius: number, angle: number, phase: number): number {
  const stretch = 1 + 0.28 * Math.cos(2 * (angle - phase));
  const lobes =
    0.16 * Math.sin(3 * angle + phase) +
    0.09 * Math.sin(5 * angle + 2.3 * phase) +
    0.05 * Math.sin(11 * angle + 3 * phase) +
    0.025 * Math.sin(23 * angle + 5 * phase);
  return radius * stretch * (1 + lobes);
}

/** The forest's two clearings: centre x, z (relative to the forest's centre) and radius. */
export function forestClearings(radius: number, phase: number): { x: number; z: number; radius: number }[] {
  return [phase + 1, phase + 3.7].map((a, k) => ({
    x: Math.cos(a) * radius * (0.35 + 0.15 * k),
    z: Math.sin(a) * radius * (0.35 + 0.15 * k),
    radius: radius * (0.12 + 0.06 * k),
  }));
}
