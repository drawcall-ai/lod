import { BoxGeometry, Color, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { InstancedLod } from "../src/instanced/index.js";
import { GPU_TIMEOUT, render } from "./gpu.js";

describe("instance fades", { timeout: GPU_TIMEOUT }, () => {
  it("preserves coverage and instance colors when neighbouring levels split the pixels", async () => {
    const box = () => new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    const lod = new InstancedLod([box(), box()], 2);
    const coarse = lod.levels[1];
    if (!coarse) throw new Error("Missing coarse level");
    coarse.maxPixels = 40;
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const distance = (2 * Math.sqrt(3) * 64) / (2 * Math.tan(Math.PI / 6) * 38);
    lod.setMatrixAt(0, new Matrix4().makeTranslation(-1.2, 0, -distance));
    lod.setMatrixAt(1, new Matrix4().makeTranslation(1.2, 0, -distance));
    lod.setColorAt(0, new Color(1, 0, 0));
    lod.setColorAt(1, new Color(0, 1, 0));
    const scene = new Scene().add(lod);
    try {
      // The first render establishes the viewport; both instances then lie in the fade.
      await render(scene, camera);
      const faded = await render(scene, camera);
      lod.forceLevel = 0;
      expect(await render(scene, camera)).toEqual(faded);
      expect(faded.some((value, i) => i % 4 === 0 && value > 0)).toBe(true);
      expect(faded.some((value, i) => i % 4 === 1 && value > 0)).toBe(true);

      // The coarser level starts at a nonzero slot; changed colors follow selection.
      lod.setColorAt(0, new Color(0, 0, 1));
      lod.setColorAt(1, new Color(1, 0, 0));
      const changed = await render(scene, camera);
      lod.forceLevel = 1;
      expect(await render(scene, camera)).toEqual(changed);
      lod.forceLevel = null;
      expect(await render(scene, camera)).toEqual(changed);
    } finally {
      lod.dispose();
    }
  });
});
