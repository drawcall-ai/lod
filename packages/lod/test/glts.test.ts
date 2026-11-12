import { GLTSLoader } from "@drawcall/glts";
import { Box3, Color, LoadingManager, Matrix4, PerspectiveCamera, Scene, Vector3 } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { Lod } from "../src/lod.js";
import { GPU_TIMEOUT, eventually, render } from "./renderer.js";

/** A .glts asset that draws a box with a Lod of its own. */
const SCRIPT = `
  import { onDispose, scene } from "@drawcall/glts";
  import { BoxGeometry, Mesh, MeshBasicMaterial } from "three/webgpu";
  import { Lod } from "@drawcall/lod";
  const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  const lod = new Lod([{ object: mesh }]);
  scene.add(lod);
  onDispose(() => {
    lod.dispose();
    mesh.geometry.dispose();
    mesh.material.dispose();
  });
`;

it("draws the instances a glts host loads its .glts asset with", { timeout: GPU_TIMEOUT }, async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(SCRIPT));
  const loader = new GLTSLoader(new LoadingManager(), { modules: { "@drawcall/lod": { Lod } } });
  try {
    const host = await loader.loadInstancesAsync("https://assets.test/lod.glts", 2);
    host.setMatrixAt(0, new Matrix4().makeTranslation(-2, 0, 0)).setMatrixAt(1, new Matrix4().makeTranslation(2, 0, 0));
    host.setColorAt(1, new Color(1, 0, 0));
    host.clusters = [{ start: 0, count: 2, boundingBox: new Box3(new Vector3(-3, -1, -1), new Vector3(3, 1, 1)) }];
    const scene = new Scene().add(host);
    scene.updateMatrixWorld();
    const [lod, ...others] = host.getObjectsByProperty("isLod", true);
    if (!(lod instanceof Lod) || others.length > 0) throw new Error("expected the asset's one Lod");
    expect(lod.instanceMatrix).toBe(host.instanceMatrix);
    expect(lod.count).toBe(2);
    expect(lod.instanceColor).toBe(host.instanceColor);
    expect(lod.getColorAt(1, new Color())).toEqual(new Color(1, 0, 0));
    expect(lod.clusters).toBe(host.clusters);
    host.computeBoundingBox();
    expect(lod.boundingBox?.containsPoint(new Vector3(-2, 0, 0))).toBe(true);
    expect(lod.boundingBox?.containsPoint(new Vector3(2, 0, 0))).toBe(true);
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.z = 8;
    await eventually(async () => {
      await render(scene, camera);
      expect(lod.getLevelAt(1, camera)).toBe(0);
    });
  } finally {
    loader.dispose();
    fetch.mockRestore();
  }
});
