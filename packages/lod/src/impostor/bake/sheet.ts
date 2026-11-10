import { HalfFloatType, NearestFilter, RenderTarget, Vector2, type Matrix4, type OrthographicCamera, type Renderer, type Scene } from "three/webgpu";
import { at } from "../../at.js";
import { readFloats } from "../../bake.js";
import { nextTask } from "../../task.js";
import type { ImpostorAtlasMip } from "./atlas.js";
import { OUTPUTS, type Output } from "./materials.js";

// Rendering an atlas mip: its frames side by side in sheets, each read back at once.

/** Edge of the largest target frames render into side by side, a sheet, which is read back at once. */
const SHEET = 1024;

/**
 * Colour attachments one target renders: four half-float targets fill the 32 bytes per
 * sample WebGPU guarantees.
 */
const PER_TARGET = 4;

/**
 * Render every frame (`frameCameras`: camera matrices, in atlas order) into `atlas`, at its
 * cell size × `supersample`. Frames render side by side into sheets of up to SHEET square,
 * so that each map is read back once per sheet, into targets of up to PER_TARGET outputs.
 */
export async function bakeMip(
  atlas: ImpostorAtlasMip,
  supersample: number,
  renderer: Renderer,
  scene: Scene,
  camera: OrthographicCamera,
  frameCameras: Matrix4[],
): Promise<void> {
  const { frames, maps } = atlas;
  const side = atlas.cell * supersample;
  const buffer = renderer.getDrawingBufferSize(new Vector2());
  if (buffer.x === side && buffer.y === side)
    throw new Error(`bakeImpostor: the renderer's canvas is ${side} px square, a frame's size: three would draw that frame over the whole sheet`);
  const per = Math.max(1, Math.min(frames, Math.floor(SHEET / side)));
  const width = per * side;
  // one output per map, then the second way to store the normals (see ImpostorAtlasMip), then the specular
  const names: Output[] = OUTPUTS.filter((name) => (name === "emissive" ? maps.includes("emissive") : name !== "specular" || atlas.specular));
  const targets = Array.from({ length: Math.ceil(names.length / PER_TARGET) }, (_, p) => {
    const outputs = names.slice(p * PER_TARGET, (p + 1) * PER_TARGET);
    const target = new RenderTarget(width, width, {
      count: outputs.length,
      type: HalfFloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: true,
    });
    outputs.forEach((name, i) => {
      const texture = target.textures[i];
      if (!texture) throw new Error("bakeImpostor: a render target lacks a texture");
      texture.name = name;
    });
    return target;
  });
  try {
    for (let row0 = 0; row0 < frames; row0 += per)
      for (let col0 = 0; col0 < frames; col0 += per) {
        const sheet: Array<{ col: number; row: number; x: number; y: number }> = [];
        for (let row = row0; row < Math.min(row0 + per, frames); row++)
          for (let col = col0; col < Math.min(col0 + per, frames); col++) sheet.push({ col, row, x: (col - col0) * side, y: (row - row0) * side });
        const placed = sheet.map(({ col, row, x, y }) => ({ matrix: at(frameCameras, row * frames + col), x, y }));
        for (const target of targets) renderSheet(renderer, target, scene, camera, placed, side);
        const pixels = await Promise.all(targets.flatMap((target) => target.textures.map((_, i) => readFloats(renderer, target, i))));
        for (const { col, row, x, y } of sheet) atlas.write(pixels, width, supersample, col, row, x, y);
        // Yield to the page between sheets, so that a long bake does not freeze it.
        await nextTask();
      }
  } finally {
    for (const target of targets) target.dispose();
  }
}

/**
 * Clear `target` and render each frame, its camera at `matrix`, into its `side` square at (x, y), counted from the
 * bottom left as the atlas is.
 */
function renderSheet(
  renderer: Renderer,
  target: RenderTarget,
  scene: Scene,
  camera: OrthographicCamera,
  frames: Array<{ matrix: Matrix4; x: number; y: number }>,
  side: number,
): void {
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  try {
    renderer.clear(true, true, true);
    for (const { matrix, x, y } of frames) {
      // WebGPU counts viewport rows from the top; `readFloats` turns the image over.
      const top = target.height - y - side;
      target.viewport.set(x, top, side, side);
      camera.matrix.copy(matrix);
      camera.updateMatrixWorld(true);
      renderer.render(scene, camera);
    }
  } finally {
    renderer.setRenderTarget(previous);
  }
}
