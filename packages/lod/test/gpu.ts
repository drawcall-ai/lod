import { RenderTarget, WebGPURenderer, type Camera, type Scene } from "three/webgpu";
import { readBytes } from "../src/renderer.js";

/** A WebGPU renderer in the test browser, initialised, its canvas 64 px on the page. */
export const renderer = new WebGPURenderer({ antialias: false });
renderer.setSize(64, 64);
renderer.setClearColor(0x000000, 0);
document.body.append(renderer.domElement);
await renderer.init();

/** Time for tests that bake or render: slow on a software adapter or a busy machine. */
export const GPU_TIMEOUT = 120_000;

/** `scene` from `camera` on a `size` px square target, cleared transparent: RGBA bytes, rows bottom-up. */
export async function render(scene: Scene, camera: Camera, size = 64): Promise<Uint8Array> {
  const target = new RenderTarget(size, size);
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const pixels = await readBytes(renderer, target, 0);
  target.dispose();
  return pixels;
}

/** Follow normal frame updates until this owner reports the actual installation. */
export function nextLevel(owner: import("../src/lod.js").Lod | import("../src/instanced/index.js").InstancedLod, camera: Camera): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame = 0;
    const clear = () => {
      cancelAnimationFrame(frame);
      owner.removeEventListener("levelschange", changed);
      owner.removeEventListener("levelserror", failed);
    };
    const changed = () => {
      clear();
      resolve();
    };
    const failed = ({ error }: { error: unknown }) => {
      clear();
      reject(error);
    };
    const update = () => {
      owner.update(camera);
      frame = requestAnimationFrame(update);
    };
    owner.addEventListener("levelschange", changed);
    owner.addEventListener("levelserror", failed);
    frame = requestAnimationFrame(update);
  });
}
