import { expect, it, vi } from "vitest";
import { ARGS_BYTES, Args } from "../../src/instanced/args.js";

it("grows without moving live draws, coalesces released slices, and disposes only empty pages", () => {
  const args = new Args(3);
  const a = args.take(new Uint32Array([6, 0, 3, 0, 9]));
  const b = args.take(new Uint32Array(5));
  const c = args.take(new Uint32Array([12, 0, 6, 3, 0]));
  const d = args.take(new Uint32Array(10));
  const disposed = vi.fn();
  a.attribute.addEventListener("dispose", disposed);
  expect([a.attribute, b.attribute]).toEqual([c.attribute, c.attribute]);
  expect([a.offset, b.offset, c.offset]).toEqual([0, ARGS_BYTES, 2 * ARGS_BYTES]);
  expect(d.attribute).not.toBe(a.attribute);
  const version = a.attribute.version;

  b.dispose();
  a.dispose();
  a.dispose();
  const replacement = args.take(new Uint32Array([3, 0, 0, 0, 7, 9, 0, 3, 7, 0]));
  expect(replacement.attribute).toBe(c.attribute);
  expect(replacement.offset).toBe(0);
  expect(c.attribute.version).toBe(version);
  expect(Array.from(c.attribute.array.slice(c.offset / 4, c.offset / 4 + 5))).toEqual([12, 0, 6, 3, 0]);
  expect(disposed).not.toHaveBeenCalled();

  replacement.dispose();
  c.dispose();
  expect(disposed).toHaveBeenCalledTimes(1);
  d.dispose();

  const large = args.take(new Uint32Array(20));
  expect(large.attribute.array.byteLength).toBe(4 * ARGS_BYTES);
  large.dispose();
  expect(() => args.take(new Uint32Array(4))).toThrow(/incomplete draw/);
  expect(() => new Args(Math.ceil((128 * 1024 * 1024) / ARGS_BYTES))).toThrow(/capacity/);
});
