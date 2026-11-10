/**
 * Renders a change of an InstancedLod's chunks rests for before their status is read back (see `ChunkWait`): chunks
 * change for many frames while an app loads them in, and every read is a submission of its own.
 */
const CHUNK_REST = 4;

/**
 * Whether an InstancedLod's chunks wait to be shown taken in on the GPU: from a change until, a few renders later, a
 * read of their status shows each taken in, so that its manager holds its item until a host sees them drawn.
 */
export class ChunkWait {
  /** While chunks wait, the renders left before their status is read, and whether a read is under way. */
  private rest: { renders: number; reading: boolean } | null = null;

  constructor(
    /** Whether the GPU shows every chunk taken in, read back; it throws if a chunk lacks room. */
    private readonly read: () => Promise<boolean>,
    /** Called once a read shows every chunk taken in. */
    private readonly taken: () => void,
    /** Called with what a read throws. */
    private readonly failed: (error: unknown) => void,
  ) {}

  /** Whether chunks wait to be shown taken in. */
  get waiting(): boolean {
    return this.rest !== null;
  }

  /** The chunks were added or removed: wait for them again. */
  changed(): void {
    if (this.rest) this.rest.renders = CHUNK_REST;
    else this.rest = { renders: CHUNK_REST, reading: false };
  }

  /** A render updated the InstancedLod: read the chunks' status once their change has rested. */
  render(): void {
    const { rest } = this;
    if (!rest || rest.reading) return;
    if (rest.renders > 0) {
      rest.renders--;
      return;
    }
    rest.reading = true;
    this.read().then(
      (taken) => {
        rest.reading = false;
        if (this.rest !== rest) return;
        if (!taken || rest.renders > 0) {
          rest.renders = CHUNK_REST;
          return;
        }
        this.rest = null;
        this.taken();
      },
      (error: unknown) => this.failed(error),
    );
  }
}
