import * as THREE from "three/webgpu";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { must } from "./must.js";

// What every lab page needs: a WebGPU renderer, the models in public/, the GPU's name for
// reports, and read-back pixels as images for the scripts to save.

/** A GLTFLoader for public/models, Draco decoder from public/draco. */
export function gltfLoader(manager?: THREE.LoadingManager): GLTFLoader {
  return new GLTFLoader(manager).setDRACOLoader(new DRACOLoader(manager).setDecoderPath("/draco/"));
}

/** A WebGPU renderer of `size` pixels on the page, initialised, timing its passes when `timed`. */
export async function gpuRenderer(size: number, options: { antialias?: boolean; timed?: boolean } = {}): Promise<THREE.WebGPURenderer> {
  const renderer = new THREE.WebGPURenderer({ antialias: options.antialias ?? true, powerPreference: "high-performance", trackTimestamp: options.timed ?? false });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size);
  document.body.append(renderer.domElement);
  await renderer.init();
  return renderer;
}

/**
 * Start a new frame of `renderer`: one tick of its animation loop. three renders each
 * shadow map once a frame per camera, and a frame advances only in that loop: renders
 * driven by hand, as the lab's are, would otherwise all see the first one's shadows.
 */
export function nextFrame(renderer: THREE.WebGPURenderer): Promise<void> {
  return new Promise((resolve) =>
    renderer.setAnimationLoop(() => {
      renderer.setAnimationLoop(null);
      resolve();
    }),
  );
}

/** The GPU behind the page's WebGPU adapter, as the browser reports it. */
export async function gpuName(): Promise<string> {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return "no WebGPU adapter";
  const { vendor, architecture, description } = adapter.info;
  return [vendor, architecture, description].filter(Boolean).join(" ");
}

export const context2d = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => must(canvas.getContext("2d"), "2D canvas context");

/** RGBA8 `pixels` (rows bottom-up, as the package reads them back) on a canvas, top row first. */
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
