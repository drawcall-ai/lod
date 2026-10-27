import { afterEach, describe, expect, it, vi } from "vitest";
import { BoxGeometry, Color, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera } from "three/webgpu";
import { InstancedLod } from "../../src/instanced/index.js";
import { Selection } from "../../src/instanced/select.js";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const crowd = new InstancedLod([new Mesh(new BoxGeometry(), new MeshBasicMaterial())], 1000);
  const camera = new PerspectiveCamera();
  camera.position.z = 10;
  camera.updateMatrixWorld();
  let selection: Selection | undefined;
  vi.spyOn(Selection.prototype, "aim").mockImplementation(function (this: Selection) {
    selection = this;
  });
  crowd.update(camera);
  if (!selection) throw new Error("Selection was not updated");
  selection.matrices.clearUpdateRanges();
  return { crowd, camera, selection };
}

describe("instance source uploads", () => {
  it("uploads sparse matrix edits without uploading intervening instances or colors", () => {
    const { crowd, camera, selection } = setup();
    crowd.setColorAt(0, new Color("red"));
    crowd.update(camera);
    const colors = selection.colors;
    if (!colors) throw new Error("Colors were not created");
    colors.clearUpdateRanges();
    const version = colors.version;
    const matricesVersion = selection.matrices.version;
    crowd.setMatrixAt(4, new Matrix4().makeTranslation(1, 2, 3));
    crowd.setMatrixAt(999, new Matrix4().makeTranslation(4, 5, 6));
    crowd.update(camera);
    expect(selection.matrices.updateRanges).toEqual([
      { start: 64, count: 16 },
      { start: 15984, count: 16 },
    ]);
    expect(selection.matrices.version).toBeGreaterThan(matricesVersion);
    expect(colors.version).toBe(version);
    expect(colors.updateRanges).toEqual([]);
    crowd.dispose();
  });

  it("color-only edits leave matrix versions and spatial bounds unchanged", () => {
    const { crowd, camera, selection } = setup();
    const version = selection.matrices.version;
    const bounds = crowd.bounds.clone();
    crowd.setColorAt(123, new Color("blue"));
    crowd.update(camera);
    expect(selection.matrices.version).toBe(version);
    expect(selection.matrices.updateRanges).toEqual([]);
    expect(crowd.bounds.equals(bounds)).toBe(true);
    crowd.dispose();
  });

  it("retains earlier pending uploads when levelOf measures between edits", () => {
    const { crowd, camera, selection } = setup();
    crowd.setMatrixAt(1, new Matrix4().makeTranslation(1, 0, 0));
    crowd.levelOf(1);
    crowd.setMatrixAt(998, new Matrix4().makeTranslation(2, 0, 0));
    crowd.update(camera);
    expect(selection.matrices.updateRanges).toEqual([
      { start: 16, count: 16 },
      { start: 15968, count: 16 },
    ]);
    crowd.dispose();
  });

  it("unions repeated pending edits across measurements and starts fresh after consumption", () => {
    const { crowd, selection } = setup();
    const matrix = new Matrix4();
    const expected = new Uint8Array(crowd.count);
    let seed = 31;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (let step = 0; step < 120; step++) {
      if (step % 17 === 0) {
        selection.matrices.clearUpdateRanges();
        expected.fill(0);
      }
      const start = Math.floor(random() * crowd.count);
      const end = start + 1 + Math.floor(random() * (crowd.count - start));
      for (let i = start; i < end; i++) crowd.setMatrixAt(i, matrix.makeTranslation(i, step, 0));
      crowd.levelOf(start);
      expected.fill(1, start, end);
      const actual = new Uint8Array(crowd.count);
      let previousEnd = -1;
      for (const range of selection.matrices.updateRanges) {
        expect(range.start).toBeGreaterThan(previousEnd);
        previousEnd = range.start + range.count;
        actual.fill(1, range.start / 16, previousEnd / 16);
      }
      expect(actual).toEqual(expected);
    }
    crowd.dispose();
  });

  it("coalesces left extensions and bridges for matrix and color uploads independently", () => {
    const { crowd, selection } = setup();
    crowd.setColorAt(0, new Color("red"));
    crowd.levelOf(0);
    const colors = selection.colors;
    if (!colors) throw new Error("Colors were not created");
    colors.clearUpdateRanges();
    const matrix = new Matrix4();
    const color = new Color("blue");
    for (const index of [5, 6, 9, 4, 8, 7, 5, 6]) {
      crowd.setMatrixAt(index, matrix);
      crowd.setColorAt(index + 100, color);
      crowd.levelOf(index);
    }
    expect(selection.matrices.updateRanges).toEqual([{ start: 4 * 16, count: 6 * 16 }]);
    expect(colors.updateRanges).toEqual([{ start: 104 * 4, count: 6 * 4 }]);
    crowd.dispose();
  });
});
