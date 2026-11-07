import { at } from "../at.js";

interface Run {
  start: number;
  count: number;
}

/**
 * Contiguous runs of `capacity` places, taken first-fit and given back whole. Runs never move, so what holds one keeps
 * its places for as long as it holds it.
 */
export class Runs {
  /** Free runs, in order, adjacent ones merged. */
  private free: Run[];

  constructor(public capacity = 0) {
    this.free = capacity > 0 ? [{ start: 0, count: capacity }] : [];
  }

  /** One past the last taken place. */
  get end(): number {
    const last = this.free.at(-1);
    return last && last.start + last.count === this.capacity ? last.start : this.capacity;
  }

  /** The start of `count` free places, now taken, or null when no run is long enough. */
  take(count: number): number | null {
    if (count === 0) return 0;
    const index = this.free.findIndex((range) => range.count >= count);
    if (index < 0) return null;
    const range = at(this.free, index);
    const start = range.start;
    range.start += count;
    range.count -= count;
    if (range.count === 0) this.free.splice(index, 1);
    return start;
  }

  /** Free the `count` places from `start`, which `take` returned. */
  give(start: number, count: number): void {
    if (count === 0) return;
    let index = this.free.findIndex((range) => range.start > start);
    if (index < 0) index = this.free.length;
    this.free.splice(index, 0, { start, count });
    const next = this.free[index + 1];
    if (next && start + count === next.start) {
      at(this.free, index).count += next.count;
      this.free.splice(index + 1, 1);
    }
    const previous = this.free[index - 1];
    if (previous && previous.start + previous.count === start) {
      previous.count += at(this.free, index).count;
      this.free.splice(index, 1);
    }
  }

  /** Change the capacity to `capacity`, which must not cut a taken run. */
  resize(capacity: number): void {
    if (capacity < this.end) throw new Error(`Runs: capacity ${capacity} cuts a taken run ending at ${this.end}`);
    const end = this.end;
    if (end < this.capacity) this.free.pop();
    this.capacity = capacity;
    if (end < capacity) this.free.push({ start: end, count: capacity - end });
  }
}
