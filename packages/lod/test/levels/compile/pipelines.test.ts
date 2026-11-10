import { expect, it, vi } from "vitest";
import { atDepth } from "../../../src/levels/compile/pipelines.js";
import { renderer } from "../../renderer.js";

it("gives a compile's own render context alone the depth it compiles for, failing on a three that takes none", async () => {
  const contexts = Reflect.get(renderer, "_renderContexts");
  const get = vi.spyOn(contexts, "get");
  try {
    // The compile's own context, then one a render it starts takes, as a scene's onBeforeRender may render elsewhere.
    await atDepth(renderer, 1, async () => {
      contexts.get(null, null);
      contexts.get(null, null, 0);
    });
    expect(get.mock.calls).toEqual([
      [null, null, 1],
      [null, null, 0],
    ]);
    expect(contexts.get).toBe(get);
    await atDepth(renderer, 0, async () => expect(contexts.get).toBe(get));
    // A three whose compile takes no context as it starts fails loudly.
    expect(() => atDepth(renderer, 1, async () => {})).toThrow(/r186/);
    expect(contexts.get).toBe(get);
    // On a lost device it compiles nothing, and that is all.
    Reflect.set(renderer, "_isDeviceLost", true);
    await atDepth(renderer, 1, async () => {});
  } finally {
    Reflect.set(renderer, "_isDeviceLost", false);
    vi.restoreAllMocks();
  }
});
