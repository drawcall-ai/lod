import { BoxGeometry, Mesh, MeshBasicMaterial } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { InstancedLod } from "../src/instanced/index.js";
import { LodGpu } from "../src/gpu.js";
import { Lod } from "../src/lod.js";
import { renderer } from "./renderer.js";

describe("LodGpu", () => {
  it("refuses to draw a Lod or an InstancedLod once disposed", () => {
    const disposed = new LodGpu(renderer);
    disposed.dispose();
    const levels = () => [{ object: new Mesh(new BoxGeometry(), new MeshBasicMaterial()) }];
    expect(() => new Lod(levels(), disposed)).toThrow("LodGpu: disposed");
    expect(() => new InstancedLod(levels(), disposed)).toThrow("LodGpu: disposed");
  });
});
