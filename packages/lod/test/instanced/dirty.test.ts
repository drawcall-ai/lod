import { describe, expect, it } from "vitest";
import { StorageBufferAttribute } from "three/webgpu";
import { Dirty, upload } from "../../src/instanced/dirty.js";

function runs(dirty: Dirty): number[][] {
  const result: number[][] = [];
  dirty.drain((start, end) => result.push([start, end]));
  return result;
}

describe("dirty instance indices", () => {
  it("deduplicates sparse edits and joins consecutive runs across words", () => {
    const dirty = new Dirty(10000);
    for (const i of [9999, 32, 31, 32, 100, 30, 0, 9998]) dirty.add(i);
    expect(runs(dirty)).toEqual([
      [0, 1],
      [30, 33],
      [100, 101],
      [9998, 10000],
    ]);
    expect(dirty.empty).toBe(true);
    dirty.add(32);
    expect(runs(dirty)).toEqual([[32, 33]]);
  });

  it("marks all indices without including padding or duplicating previous edits", () => {
    for (const count of [0, 1, 31, 32, 33, 64, 65]) {
      const dirty = new Dirty(count);
      if (count) dirty.add(count - 1);
      dirty.all();
      expect(runs(dirty)).toEqual(count ? [[0, count]] : []);
    }
  });
});

it("unions pending uploads across measurements, including left extensions and bridges", () => {
  const attribute = new StorageBufferAttribute(1000, 16);
  for (const index of [5, 6, 9, 4, 8, 7, 5, 6, 998]) upload(attribute, index, index + 1);
  expect(attribute.updateRanges).toEqual([
    { start: 4 * 16, count: 6 * 16 },
    { start: 998 * 16, count: 16 },
  ]);
  attribute.clearUpdateRanges();
  upload(attribute, 1, 2);
  expect(attribute.updateRanges).toEqual([{ start: 16, count: 16 }]);
});
