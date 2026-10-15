import { Mesh, PerspectiveCamera, PlaneGeometry, Scene, WebGLRenderer, type Material, type WebGLProgramParametersWithUniforms } from "three";
import { createWebGL2Context } from "webgl-node";

const { canvas, gl } = createWebGL2Context(64, 64);
/** A real WebGL2 renderer in Node (webgl-node): the GPU, or Mesa's llvmpipe on machines without one. */
export const renderer = new WebGLRenderer({ canvas, context: gl });

/** Time for tests that bake or render: slow on a software renderer or a busy machine. */
export const GPU_TIMEOUT = 120_000;

/** The shader three compiles for `material`, after every patch on it. */
export function compile(material: Material): WebGLProgramParametersWithUniforms {
  let captured: WebGLProgramParametersWithUniforms | undefined;
  const patched = material.onBeforeCompile;
  material.onBeforeCompile = (shader, three) => {
    patched.call(material, shader, three);
    captured = shader;
  };
  try {
    renderer.compile(new Scene().add(new Mesh(new PlaneGeometry(), material)), new PerspectiveCamera());
  } finally {
    material.onBeforeCompile = patched;
  }
  if (!captured) throw new Error("three did not compile the material");
  return captured;
}
