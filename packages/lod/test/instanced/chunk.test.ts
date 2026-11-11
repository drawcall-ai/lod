import {
  Box3,
  BoxGeometry,
  Color,
  InstancedBufferAttribute,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
  Vector3,
} from "three/webgpu";
import { describe, expect, it } from "vitest";
import { InstancedLod } from "../../src/instanced/index.js";
import { instanceColor, instanceMatrix } from "../instances.js";
import { pool } from "../renderer.js";
import { box } from "../box.js";

const lod = () => new InstancedLod([{ object: box() }], pool);
const gpuMatrices = () => new StorageInstancedBufferAttribute(new Float32Array(4 * 16), 16);
const bounds = { originBox: new Box3(new Vector3(-1, 0, -1), new Vector3(1, 0, 1)), minScale: 1, maxScale: 2 };

describe("InstancedLodChunk", () => {
  it("refuses parameters it cannot draw", () => {
    const target = lod();
    const matrices = instanceMatrix([new Matrix4(), new Matrix4()]);
    expect(() => target.addChunk({ instanceMatrix: new InstancedBufferAttribute(new Float32Array(9), 3) })).toThrow(/16 floats/);
    expect(() => target.addChunk({ instanceMatrix: matrices, start: 1, count: 2 })).toThrow(/passes the 2 instances/);
    expect(() => target.addChunk({ instanceMatrix: matrices, instanceColor: instanceColor([new Color()]) })).toThrow(/fewer instances/);
    expect(() => target.addChunk({ instanceMatrix: matrices, instanceColor: new InstancedBufferAttribute(new Uint8Array(6), 3, true) })).toThrow(
      /holds floats/,
    );
    expect(() => target.addChunk({ instanceMatrix: matrices, instanceColor: new StorageInstancedBufferAttribute(new Float32Array(8), 4) })).toThrow(
      /another kind/,
    );
    expect(() => target.addChunk({ instanceMatrix: matrices, ...bounds })).toThrow(/measured from its instances/);
    const counts = new StorageBufferAttribute(new Uint32Array(1), 1);
    expect(() => target.addChunk({ instanceMatrix: matrices, instanceCount: counts })).toThrow(/only a GPU chunk/);
    expect(() => target.addChunk({ instanceMatrix: gpuMatrices() })).toThrow(/needs its originBox, minScale and maxScale/);
    expect(() => target.addChunk({ instanceMatrix: gpuMatrices(), ...bounds, minScale: 3 })).toThrow(/0 < minScale <= maxScale/);
    expect(() => target.addChunk({ instanceMatrix: gpuMatrices(), ...bounds, instanceCount: counts, instanceCountIndex: 1 })).toThrow(/passes the end/);
    expect(() => new InstancedLod([], pool).addChunk({ instanceMatrix: matrices })).toThrow(/levels before chunks/);
    expect([...target.chunks]).toEqual([]);
    target.dispose();
  });

  it("reads and writes a CPU chunk's instances in its range of its attributes", () => {
    const target = lod();
    const chunk = target.addChunk({
      instanceMatrix: instanceMatrix([1, 2, 3].map((x) => new Matrix4().makeTranslation(x, 0, 0))),
      instanceColor: instanceColor([new Color(1, 0, 0), new Color(0, 1, 0), new Color(0, 0, 1)]),
      start: 1,
      count: 2,
    });
    expect(chunk.getMatrixAt(0, new Matrix4()).elements[12]).toBe(2);
    chunk.setMatrixAt(1, new Matrix4().makeTranslation(9, 0, 0));
    expect(chunk.instanceMatrix.array[2 * 16 + 12]).toBe(9);
    expect(chunk.getColorAt(1, new Color()).getHex()).toBe(0x0000ff);
    chunk.setColorAt(0, new Color(1, 1, 0));
    expect(chunk.getColorAt(0, new Color()).getHex()).toBe(0xffff00);
    expect(() => chunk.getMatrixAt(2, new Matrix4())).toThrow(/not an instance of the chunk's 2/);
    const plain = target.addChunk({ instanceMatrix: instanceMatrix([new Matrix4()]) });
    expect(plain.getColorAt(0, new Color()).getHex()).toBe(0xffffff);
    expect(() => plain.setColorAt(0, new Color())).toThrow(/give the chunk an instanceColor/);
    target.dispose();
  });

  it("measures a CPU chunk's origins and scales, instances at scale 0 left out", () => {
    const coarse = new Mesh(new BoxGeometry(2, 10, 2), new MeshBasicMaterial());
    coarse.position.y = 5;
    const target = new InstancedLod([{ object: box() }, { object: coarse }], pool);
    const chunk = target.addChunk({
      instanceMatrix: instanceMatrix([
        new Matrix4().makeTranslation(-5, 0, 0),
        new Matrix4().makeScale(2, 2, 2).setPosition(5, 0, 0),
        new Matrix4().makeScale(0, 0, 0).setPosition(100, 0, 0),
      ]),
    });
    expect(chunk.originBox).toEqual(new Box3(new Vector3(-5, 0, 0), new Vector3(5, 0, 0)));
    expect([chunk.minScale, chunk.maxScale]).toEqual([1, 2]);
    // The tall level reaches 10 up from an origin: twice that at scale 2.
    expect(chunk.boundingBox.containsBox(new Box3(new Vector3(-6, -20, -2), new Vector3(7, 20, 2)))).toBe(true);
    target.dispose();
  });

  it("refuses the CPU methods of a GPU chunk, whose instances live on the GPU", () => {
    const target = lod();
    const chunk = target.addChunk({ instanceMatrix: gpuMatrices(), ...bounds });
    expect(chunk.originBox).toEqual(bounds.originBox);
    const gpu = /a GPU chunk's instances live on the GPU/;
    expect(() => chunk.getMatrixAt(0, new Matrix4())).toThrow(gpu);
    expect(() => chunk.setMatrixAt(0, new Matrix4())).toThrow(gpu);
    expect(() => chunk.getColorAt(0, new Color())).toThrow(gpu);
    expect(() => chunk.setColorAt(0, new Color())).toThrow(gpu);
    expect(() => chunk.getLevelAt(0, new PerspectiveCamera())).toThrow(gpu);
    expect(() => target.clone()).toThrow(/cannot be copied/);
    target.dispose();
  });
});
