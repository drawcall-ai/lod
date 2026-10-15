// n8ao ships no type declarations; this covers the part the viewer uses.
declare module "n8ao" {
  import type { Camera, Scene } from "three";
  import { Pass } from "three/addons/postprocessing/Pass.js";

  /** Renders the scene and applies screen-space ambient occlusion (replaces a RenderPass). */
  export class N8AOPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: {
      aoRadius: number;
      distanceFalloff: number;
      intensity: number;
      gammaCorrection: boolean;
    };
  }
}
