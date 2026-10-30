import * as THREE from "three/webgpu";
import { MonotoneCurve } from "./curve.ts";

/** A pose of the tour: looking at `target` from `distance` metres, from the direction `heading` (radians about y) and `pitch` above the horizon. */
export interface Key {
  name: string;
  time: number;
  target: THREE.Vector3;
  distance: number;
  heading: number;
  pitch: number;
}

/**
 * The scripted flight: through keyed poses, every channel on a monotone curve over time.
 * The distance runs on a log scale, so a zoom from kilometres to millimetres takes as
 * long per factor of ten at either end.
 */
export class Tour {
  readonly duration: number;
  private readonly channels: [MonotoneCurve, MonotoneCurve, MonotoneCurve, MonotoneCurve, MonotoneCurve, MonotoneCurve];
  private readonly target = new THREE.Vector3();

  constructor(readonly keys: Key[]) {
    const last = keys[keys.length - 1];
    if (!last) throw new Error("a tour needs keys");
    this.duration = last.time;
    const times = keys.map((k) => k.time);
    const channel = (value: (k: Key) => number) => new MonotoneCurve(times, keys.map(value));
    this.channels = [
      channel((k) => k.target.x),
      channel((k) => k.target.y),
      channel((k) => k.target.z),
      channel((k) => Math.log(k.distance)),
      channel((k) => k.heading),
      channel((k) => k.pitch),
    ];
  }

  /** Puts `camera` where the tour is at `time` seconds; returns the distance to what it looks at. */
  pose(time: number, camera: THREE.Camera): number {
    const [x, y, z, zoom, turn, tilt] = this.channels;
    const distance = Math.exp(zoom.at(time));
    const heading = turn.at(time);
    const pitch = tilt.at(time);
    const target = this.target.set(x.at(time), y.at(time), z.at(time));
    camera.position
      .set(Math.cos(pitch) * Math.cos(heading), Math.sin(pitch), Math.cos(pitch) * Math.sin(heading))
      .multiplyScalar(distance)
      .add(target);
    camera.lookAt(target);
    return distance;
  }
}
