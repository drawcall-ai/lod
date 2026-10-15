// webgl-node ships no types; this declares the one entry point the tests use. Its canvas is
// a stand-in that three's WebGLRenderer accepts alongside the context.
declare module "webgl-node" {
  export function createWebGL2Context(width: number, height: number): { canvas: HTMLCanvasElement; gl: WebGL2RenderingContext };
}
