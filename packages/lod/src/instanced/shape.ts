import { Box3, Sphere, Vector3 } from "three/webgpu";
import { levelBox, measureLevels } from "../levels/bounds.js";
import type { LodLevel } from "../levels/index.js";

/** One instance of a Lod as its levels measure it, in its own space: what heights, bounds and fades are measured by. */
export class InstanceShape {
  /** The source's sphere, which heights are measured by. */
  readonly source = new Sphere();
  /** Around every level, unloaded ones included. */
  readonly rest = new Sphere();
  /** The source's radius in its own space, which default thresholds are measured from. */
  readonly ownRadius: number = 0;
  /** The source's radius padded for sway, where fades and shadow casters are cut off (see `wind`). */
  fadeRadius = 0;
  /** The diagonal of every level's box: how much a cluster's box shows of its instances' scale. */
  readonly extent: number = 0;
  /** Every level's box. */
  private readonly envelope = new Box3();
  /** How far levels sway beyond `rest`, relative to it. */
  private sway = 0;

  /** The shape of `inputs`, the levels given; none without levels. */
  constructor(inputs: readonly LodLevel[]) {
    if (inputs.length === 0) return;
    const { own, placed } = measureLevels(inputs, "Lod");
    this.ownRadius = own.radius;
    this.source.copy(placed);
    this.rest.copy(placed);
    this.fadeRadius = placed.radius;
    for (const input of inputs) this.envelope.union(levelBox(input));
    // Metadata includes unloaded levels, so later arrivals cannot pass the envelope.
    if (this.envelope.isEmpty()) return;
    this.extent = this.envelope.getSize(new Vector3()).length();
    const { center } = this.rest;
    const { min, max } = this.envelope;
    this.rest.radius = Math.max(
      this.rest.radius,
      Math.hypot(
        Math.max(Math.abs(min.x - center.x), Math.abs(max.x - center.x)),
        Math.max(Math.abs(min.y - center.y), Math.abs(max.y - center.y)),
        Math.max(Math.abs(min.z - center.z), Math.abs(max.z - center.z)),
      ),
    );
  }

  /** The radius around the source's centre that every level and its sway stay within. */
  get reach(): number {
    return this.rest.radius * (1 + this.sway);
  }

  /** How far from the instance's origin every level and its sway reach. */
  get originReach(): number {
    return this.rest.center.length() + this.reach;
  }

  /** Sway as wind of `slope` above `baseY` moves it, the source's fade radius padded by `padding`. */
  wind(padding: number, slope: number, baseY: number): void {
    this.fadeRadius = this.source.radius + padding;
    // The wind's shape comes from the source, but taller or offset levels sway farther.
    const reach = slope * Math.max(Math.abs(this.envelope.min.y - baseY), Math.abs(this.envelope.max.y - baseY));
    this.sway = this.rest.radius > 0 ? reach / this.rest.radius : 0;
  }
}
