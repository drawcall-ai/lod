import type { Renderer } from "three/webgpu";
import type { Residency } from "../../residency.js";
import type { Pages } from "./index.js";

/**
 * Renders a change of chunks rests for before the GPU's progress is read back: a stream changes chunks for many frames,
 * and every read is a submission of its own.
 */
const REST = 4;

/**
 * Holds an InstancedLod's item from a change of its GPU chunks until the GPU shows every chunk taken in, so that a host
 * waiting for its manager sees them drawn. A chunk the pool lacks pages for is the crowd's error, reported on the manager.
 */
export class Intake {
  private rest = 0;
  private reading = false;

  constructor(
    private readonly pages: Pages,
    private readonly residency: Residency,
  ) {}

  changed(): void {
    this.rest = REST;
    this.residency.taking = true;
    this.residency.sync();
  }

  /** A render reached the crowd, having taken the chunks' changes in. */
  rendered(renderer: Renderer): void {
    if (!this.residency.taking || this.reading) return;
    if (this.rest > 0) {
      this.rest--;
      return;
    }
    this.reading = true;
    this.pages.drained(renderer).then(
      (taken) => {
        this.reading = false;
        if (!taken || this.rest > 0) {
          this.rest = REST;
          return;
        }
        this.residency.taking = false;
        this.residency.sync();
      },
      (error: unknown) => this.residency.report(error),
    );
  }
}
