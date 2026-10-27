import * as THREE from "three/webgpu";
import { pass } from "three/tsl";

/**
 * The renderer and its frame: the scene is drawn into a multisampled half-float target
 * with a float depth buffer and reversed depth (near 1, far 0), which keeps depth
 * precise from half a millimetre to forty kilometres in one view: a ladybird's legs on
 * a leaf and a house at the horizon, no z-fighting at either end. Tone mapping and sRGB
 * come after, in the output pass to the canvas.
 */
export class Pipeline {
  /**
   * What the last frame drew: the scene pass, its shadow maps and the output pass. three
   * counts an indirect draw (every level of an InstancedLod) at all the instances it has
   * room for, not those the GPU selected.
   */
  readonly drawn = { calls: 0, triangles: 0 };
  /** Sum of GPU pass durations (ms), or null without timers. Passes can overlap, so this is not frame latency. */
  gpuMs: number | null = null;
  private reading: Promise<number | null> | null = null;
  private readonly output: THREE.RenderPipeline;
  private readonly scene: THREE.PassNode;
  private readonly timed: boolean;

  private constructor(
    readonly renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    // 4 samples: WebGPU offers 1 or 4. They keep thin twigs and grass blades whole in
    // motion (without, they break into crawling dashes).
    this.scene = pass(scene, camera, { samples: 4 });
    this.output = new THREE.RenderPipeline(renderer, this.scene);
    this.timed = renderer.hasFeature("timestamp-query");
    // counted over the whole frame: three counts each render call on its own otherwise
    renderer.info.autoReset = false;
  }

  /** A renderer drawing `scene` from `camera`, initialised. */
  static async create(scene: THREE.Scene, camera: THREE.Camera, pixelRatio: number): Promise<Pipeline> {
    const renderer = new THREE.WebGPURenderer({
      // Impostors leave fractional alpha (alpha to coverage) in the frame, which an alpha
      // canvas would let the page show through.
      alpha: false,
      reversedDepthBuffer: true,
      powerPreference: "high-performance",
      trackTimestamp: true,
    });
    await renderer.init();
    renderer.setPixelRatio(pixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // Neutral (Khronos PBR Neutral) keeps hues closest to a photograph here; see viewer.ts
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 0.8;
    return new Pipeline(renderer, scene, camera);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height);
  }

  /** Waits for the submitted frame without reading the whole HDR target. */
  async wait(): Promise<void> {
    await this.renderer.readRenderTargetPixelsAsync(this.scene.renderTarget, 0, 0, 1, 1);
  }

  render(): void {
    const { renderer } = this;
    renderer.info.reset();
    this.output.render();
    this.drawn.calls = renderer.info.render.drawCalls;
    this.drawn.triangles = renderer.info.render.triangles;
  }

  /**
   * The last drawn frame's sum of GPU pass durations, not its elapsed GPU time.
   * Live callers may share an outstanding read;
   * measurements await it before drawing the next frame. Three returns its last value
   * when no new queries exist, so a frame without compute must contribute zero there.
   */
  timing(): Promise<number | null> {
    if (!this.timed) return Promise.resolve(null);
    if (this.reading) return this.reading;
    const { renderer } = this;
    const computed = renderer.info.compute.frameCalls > 0;
    this.reading = Promise.all([
      renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER),
      // Drain any queries from live frames drawn during the previous pending read too.
      renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE),
    ])
      .then(([render, compute]) => (this.gpuMs = (render ?? 0) + (computed ? (compute ?? 0) : 0)))
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }
}
