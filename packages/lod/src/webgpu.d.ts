// WebGPU's types, for the code that drives a device itself (see blocks/). Not emitted, so the published types need none.
/// <reference types="@webgpu/types" />

// The part of @drawcall/webgpu this package uses, which ships no types.
declare module "@drawcall/webgpu" {
  export interface Canvas {
    dispose(): Promise<void>;
  }
  export function createCanvas(width: number, height: number): Promise<Canvas>;
  /** The GPU when the system has one, else the bundled CPU renderer. */
  export function requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
}
