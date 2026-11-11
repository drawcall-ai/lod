import { Box3, Color, Matrix4, PerspectiveCamera, StorageBufferAttribute, StorageInstancedBufferAttribute, Vector3 } from "three/webgpu";
import { Fn, If, atomicAdd, atomicStore, float, instanceIndex, mat4, storage, uint, uniform, vec3 } from "three/tsl";
import { InstancedLod } from "../../../src/instanced/index.js";
import type { InstancedLodChunkParameters } from "../../../src/instanced/chunk.js";
import { PAGE } from "../../../src/instanced/pages/workgroup.js";
import { box } from "../../box.js";
import { renderer, pool } from "../../renderer.js";
import { instanceColor, instanceMatrix } from "../../instances.js";

// The app's side, as a test: a compute pass that writes finished instances, matrices and colours, of the spots it
// picks, and how many it wrote: into the attributes instancedArray(n, "mat4"), instancedArray(n, "vec3") and
// attributeArray(n, "uint") make, made here so they hold those types.

export const CAPACITY = 4 * PAGE;
const matrixBuffer = new StorageInstancedBufferAttribute(new Float32Array(CAPACITY * 16), 16);
const colorBuffer = new StorageInstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
const countBuffer = new StorageBufferAttribute(new Uint32Array(4), 1);
const matrices = storage(matrixBuffer, "mat4", CAPACITY);
const colors = storage(colorBuffer, "vec3", CAPACITY);
const counts = storage(countBuffer, "uint", 4).toAtomic();
const first = uniform(0, "uint");
const total = uniform(0, "uint");
const counter = uniform(0, "uint");
const shift = uniform(0);
/** How the compute pass writes: 0 the picked spots, counted; 1 every spot in its own place, those not picked at scale 0; 2 every spot. */
const mode = uniform(0, "uint");

/** Spot k's scale, colour and position: on a grid ahead of a camera at the origin looking down -z, moved by `by` along x. */
export const spot = (k: number, by = 0) => ({
  scale: 1 + (k % 4) * 0.25,
  color: new Color((k % 3) * 0.5, 1, 0.5),
  position: new Vector3((k % 8) * 3 - 10.5 + by, 0, -(5 + Math.floor(k / 8) * 2)),
});
/** Whether spot k is one the compute pass picks. */
export const picked = (k: number) => k % 3 === 0;

const pass = Fn(() => {
  const i = instanceIndex;
  If(i.lessThan(total), () => {
    const k = first.add(i);
    const s = float(k.mod(4)).mul(0.25).add(1);
    const x = float(k.mod(8)).mul(3).sub(10.5).add(shift);
    const z = float(k.div(8)).mul(2).add(5).negate();
    const matrix = mat4(s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, 0, z, 1);
    const color = vec3(float(k.mod(3)).mul(0.5), 1, 0.5);
    const chosen = k.mod(3).equal(0);
    If(mode.equal(0), () => {
      If(chosen, () => {
        const slot = atomicAdd(counts.element(counter), uint(1));
        matrices.element(slot).assign(matrix);
        colors.element(slot).assign(color);
      });
    }).Else(() => {
      matrices.element(i).assign(chosen.or(mode.equal(2)).select(matrix, mat4(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)));
      colors.element(i).assign(color);
    });
  });
})().compute(CAPACITY);
const clear = Fn(() => {
  atomicStore(counts.element(instanceIndex), uint(0));
})().compute(4);

/** Write spots `from` to `from + n` on the GPU, as `mode` says, the picked ones counted into counter `index`. */
export function produce(from: number, n: number, index: number, { by = 0, write = 0 } = {}): void {
  first.value = from;
  total.value = n;
  counter.value = index;
  shift.value = by;
  mode.value = write;
  void renderer.compute(clear);
  void renderer.compute(pass);
}

/** The GPU chunk `produce` wrote: `n` spots, of picked ones counted into counter `index`, or in place. */
export function gpuChunk(n: number, index: number, inPlace = false): InstancedLodChunkParameters {
  return {
    instanceMatrix: matrixBuffer,
    instanceColor: colorBuffer,
    count: n,
    ...(inPlace ? {} : { instanceCount: countBuffer, instanceCountIndex: index }),
    originBox: new Box3(new Vector3(-11, 0, -600), new Vector3(11, 1, -4)),
    minScale: 1,
    maxScale: 1.75,
  };
}

/** The same picked spots from the CPU. */
export function cpuChunk(from: number, n: number, by = 0): InstancedLodChunkParameters {
  const spots = Array.from({ length: n }, (_, i) => from + i)
    .filter(picked)
    .map((k) => spot(k, by));
  return {
    instanceMatrix: instanceMatrix(spots.map(({ scale, position }) => new Matrix4().makeScale(scale, scale, scale).setPosition(position))),
    instanceColor: instanceColor(spots.map(({ color }) => color)),
  };
}

/** An InstancedLod of two boxes, the second drawn below 6 px, drawn with `on`. */
export function instancedLod(on = pool): InstancedLod {
  const lod = new InstancedLod([{ object: box() }, { object: box() }], on);
  lod.levels.forEach((level, i) => (level.maxPixels = [Infinity, 6][i] ?? level.maxPixels));
  return lod;
}

/** The camera the tests draw with: at the origin, looking down -z, where the spots lie. */
export const camera = new PerspectiveCamera(60, 1, 0.1, 1e4);
