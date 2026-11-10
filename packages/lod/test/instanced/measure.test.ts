import { StorageBufferAttribute } from "three/webgpu";
import { Fn, code, instanceIndex, storage, vec3, wgslFn } from "three/tsl";
import { d, tgpu } from "typegpu";
import { describe, expect, it } from "vitest";
import { MAX_SURVIVOR_SCALE, cullScale, originHash } from "../../src/instanced/measure.js";
import { GPU_TIMEOUT, renderer } from "../renderer.js";

// originHash in WGSL, through toTsl as update.ts runs cullScale.
const library = code(tgpu.resolve({ template: `fn testOriginHashOf(origin: vec3f) -> f32 { return originHash(origin); }`, externals: { originHash } }));
const hash = wgslFn(`fn testOriginHash(origin: vec3f) -> f32 { return testOriginHashOf(origin); }`, [library]);

describe("originHash", () => {
  it("hashes an origin's bits the same on the CPU and the GPU", { timeout: GPU_TIMEOUT }, async () => {
    // Origins on a grid, fine and coarse, signed zero and large values among them.
    const origins = new Float32Array(
      Array.from({ length: 4096 }, (_, i) => [((i % 64) - 32) * 0.37, Math.floor(i / 64) * 1.5 - 40, i % 3 === 0 ? -0 : (i * 1e3) % 7919]).flat(),
    );
    const n = origins.length / 3;
    const input = storage(new StorageBufferAttribute(origins, 1), "float", origins.length).toReadOnly();
    const result = new StorageBufferAttribute(new Float32Array(n), 1);
    const out = storage(result, "float", n);
    const shader = Fn(() => {
      const i = instanceIndex.mul(3);
      out.element(instanceIndex).assign(hash({ origin: vec3(input.element(i), input.element(i.add(1)), input.element(i.add(2))) }));
    })().compute(n);
    await renderer.computeAsync(shader);
    const gpu = new Float32Array(await renderer.getArrayBufferAsync(result));
    const cpu = Array.from({ length: n }, (_, i) => originHash(d.vec3f(origins[i * 3] ?? 0, origins[i * 3 + 1] ?? 0, origins[i * 3 + 2] ?? 0)));
    expect(Array.from(gpu)).toEqual(cpu);
    // Spread over [0, 1).
    const buckets = new Array<number>(8).fill(0);
    for (const value of cpu) {
      const bucket = Math.floor(value * 8);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const count of buckets) expect(count).toBeGreaterThan(n / 8 / 2);
  });
});

// cullScale's thinning and survivors' growth are tested where the GPU runs them, against these CPU answers (see
// cull.test.ts); only the cap is not reached there.
describe("cullScale", () => {
  it("grows survivors no more than MAX_SURVIVOR_SCALE", () => {
    const survivor = Array.from({ length: 5000 }, (_, i) => d.vec3f(i, 1, 0)).find((each) => cullScale(each, 19.99, 10, 20, 0) > 0);
    if (!survivor) throw new Error("no survivor near far");
    expect(cullScale(survivor, 19.99, 10, 20, 1)).toBe(MAX_SURVIVOR_SCALE);
  });
});
