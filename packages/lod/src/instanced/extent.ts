import { Box3, Sphere } from "three/webgpu";
import { at } from "../at.js";
import { levelBox, measureLevels } from "../bounds.js";
import type { LodLevel } from "../levels.js";

/** Where an InstancedLod's levels reach: around one instance, and per level in the crowd's space. */
export class Extent {
  /** Bounding sphere of the source in an instance's space, which LOD selection measures. */
  readonly source = new Sphere();
  /** Around every placed level in an instance's space, unloaded ones included. */
  readonly rest = new Sphere();
  /** Per level, what its meshes are culled by: the crowd's bounds, or less where its instances must be near the camera. */
  readonly reaches: Sphere[] = [];
  private readonly envelope = new Box3();
  /** Source-radius padding for the shadow caster cutoff; culling pads every level separately. */
  private padding = 0;

  /** Measure `inputs`; returns the source's own radius. */
  measure(inputs: readonly LodLevel[]): number {
    const { own, placed } = measureLevels(inputs, "InstancedLod");
    this.source.copy(placed);
    for (const input of inputs) {
      this.reaches.push(new Sphere());
      this.envelope.union(levelBox(input));
    }
    // Metadata includes unloaded levels, so later arrivals cannot enlarge this envelope.
    this.rest.copy(placed);
    if (this.envelope.isEmpty()) return own.radius;
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
    return own.radius;
  }

  /** Source radius padded for the level shaders' shadow caster cutoff. */
  get drawRadius(): number {
    return this.source.radius * (1 + this.padding);
  }

  /** Take the wind's bounds; returns how far, relative to `rest`, levels sway. */
  wind(padding: number, slope: number, baseY: number): number {
    this.padding = padding / this.source.radius;
    // The wind shape comes from the source, but taller/offset levels can sway farther.
    const reach = slope * Math.max(Math.abs(this.envelope.min.y - baseY), Math.abs(this.envelope.max.y - baseY));
    return this.rest.radius > 0 ? reach / this.rest.radius : 0;
  }

  /** Move each level's reach to the level that draws in its place: its fallback, and during a handover also its previous one. */
  reroute(fallback: readonly number[], previous: readonly number[], progress: number): void {
    const { reaches } = this;
    for (let i = reaches.length - 1; i >= 0; i--) {
      const reach = at(reaches, i);
      const target = at(fallback, i);
      const before = progress < 1 ? at(previous, i) : -1;
      if (before >= 0 && before !== target) at(reaches, before).union(reach);
      if (target === i) continue;
      if (target >= 0) at(reaches, target).union(reach);
      reach.makeEmpty();
    }
  }
}
