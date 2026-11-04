import { describe, expect, it, vi } from "vitest";
import { encodeLayer } from "../../../src/impostor/ktx2/encode.js";

// A worker script that does not load.
vi.mock("../../../src/impostor/ktx2/worker.js", () => ({ url: "/missing-encoder-worker.js" }));

describe("impostor map encoding", () => {
  it("rejects every job, rather than waiting forever, when the worker does not load", async () => {
    const job = { levels: [new Uint8Array(16 * 16 * 4)], size: 16, srgb: false };
    await expect(Promise.all([encodeLayer(job), encodeLayer(job)])).rejects.toThrow(/encoder worker failed/);
    await expect(encodeLayer(job)).rejects.toThrow(/encoder worker failed/);
  });
});
