import * as THREE from "three";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

/**
 * The renderer and its frame: the scene is drawn into a multisampled half-float target
 * with a float depth buffer and reversed depth (near 1, far 0), which keeps depth
 * precise from half a millimetre to forty kilometres in one view: a ladybird's legs on
 * a leaf and a house at the horizon, no z-fighting at either end. Tone mapping and sRGB
 * come after, in an output pass to the canvas.
 */
export class Pipeline {
  readonly renderer: THREE.WebGLRenderer;
  /** What the last frame drew (the scene pass alone, shadows included). */
  readonly drawn = { calls: 0, triangles: 0 };
  private target = new THREE.WebGLRenderTarget(1, 1);
  private readonly output = new OutputPass();
  private readonly timer: GpuTimer | null;

  constructor(options: { preserveDrawingBuffer: boolean; pixelRatio: number }) {
    // Our own context without alpha: impostors leave fractional alpha (alpha to coverage)
    // in the frame, which three's always-alpha canvas would let the page show through.
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      stencil: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: options.preserveDrawingBuffer,
    });
    if (!context) throw new Error("WebGL 2 is needed");
    this.renderer = new THREE.WebGLRenderer({ canvas, context, reversedDepthBuffer: true });
    if (!this.renderer.capabilities.reversedDepthBuffer)
      throw new Error("this browser has no EXT_clip_control: reversed depth is needed to draw kilometres and millimetres in one view");
    this.renderer.setPixelRatio(options.pixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Neutral (Khronos PBR Neutral) keeps hues closest to a photograph here; see viewer.ts
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.8;
    this.output.renderToScreen = true;
    this.timer = GpuTimer.create(context);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** GPU time of the last measured frame (ms), or null where the browser offers no timer. */
  get gpuMs(): number | null {
    return this.timer?.ms ?? null;
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    // a new target rather than setSize, which leaves the depth texture at its old size
    this.target.dispose();
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, { samples: 4, type: THREE.HalfFloatType });
    // reversed depth gains only with a float depth buffer
    this.target.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.FloatType);
  }

  /** The drawing-buffer height the levels are measured against. */
  get height(): number {
    return this.target.height;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const { renderer } = this;
    this.timer?.begin();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    this.drawn.calls = renderer.info.render.calls;
    this.drawn.triangles = renderer.info.render.triangles;
    // to the canvas (renderToScreen): the write buffer goes unused
    this.output.render(renderer, this.target, this.target, 0, false);
    this.timer?.end();
  }
}

/** GPU frame time from EXT_disjoint_timer_query_webgl2, read a few frames late (queries resolve asynchronously). */
class GpuTimer {
  ms: number | null = null;
  private readonly pending: WebGLQuery[] = [];
  private current: WebGLQuery | null = null;

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number },
  ) {}

  static create(gl: WebGL2RenderingContext): GpuTimer | null {
    const ext: unknown = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    if (!ext || typeof ext !== "object" || !("TIME_ELAPSED_EXT" in ext) || !("GPU_DISJOINT_EXT" in ext)) return null;
    const { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT } = ext;
    if (typeof TIME_ELAPSED_EXT !== "number" || typeof GPU_DISJOINT_EXT !== "number") return null;
    return new GpuTimer(gl, { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT });
  }

  begin(): void {
    this.collect();
    if (this.pending.length > 4) return;
    this.current = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.current);
  }

  end(): void {
    if (!this.current) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.current);
    this.current = null;
  }

  private collect(): void {
    const { gl } = this;
    while (this.pending.length > 0) {
      const query = this.pending[0];
      if (!query || !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return;
      this.pending.shift();
      if (!gl.getParameter(this.ext.GPU_DISJOINT_EXT)) this.ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(query);
    }
  }
}
