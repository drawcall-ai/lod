import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { must } from "./must.js";

// What every lab page needs: the models in public/, the GPU's name for reports, and
// read-back pixels as images for the scripts to save.

/** A GLTFLoader for public/models, Draco decoder from public/draco. */
export function gltfLoader(manager?: THREE.LoadingManager): GLTFLoader {
  return new GLTFLoader(manager).setDRACOLoader(new DRACOLoader(manager).setDecoderPath("/draco/"));
}

/** The GPU behind `gl`, as the browser reports it. */
export function gpuName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
}

export const context2d = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => must(canvas.getContext("2d"), "2D canvas context");

/** RGBA8 `pixels` read back from WebGL (rows bottom-up) on a canvas, top row first. */
export function glCanvas(pixels: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const image = new ImageData(width, height);
  for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
  context2d(canvas).putImageData(image, 0, 0);
  return canvas;
}

/** `pixels` (see glCanvas) as a PNG data URL. */
export const png = (pixels: Uint8Array, width: number, height: number): string => glCanvas(pixels, width, height).toDataURL("image/png");
