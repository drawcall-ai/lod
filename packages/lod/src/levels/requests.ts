import type { Camera, Renderer, Scene } from "three/webgpu";
import { busy, inShadowMap } from "./renderer.js";
import type { CameraRenders } from "./cameras.js";

/** A camera's last request, the round it was made in and, a shadow map's, the renderer's frame. */
interface Request {
  levels: number;
  round: number;
  frame: number | null;
}

/**
 * What the cameras rendering a Lod asked of it: per camera the levels it wants, and whether it still renders the Lod.
 * The renderer's updates of the Lod are counted in rounds: a round ends when a camera updates it a second time, so a
 * round holds one update by each camera that renders it once a frame, whatever their order. Shadow maps do not count.
 */
export class CameraRequests {
  /** The frame a camera, not a shadow map's, last updated the Lod in. */
  cameraFrame: number | null = null;
  /** The cameras still rendering the Lod (see `fresh`), and what they asked for. */
  private readonly requests = new Map<Camera, Request>();
  private round = 0;
  /** The cameras that updated the Lod in the round under way. */
  private readonly inRound = new Set<Camera>();

  constructor(
    /** The renderer drawing the Lod. */
    private readonly renderer: Renderer,
    /** What renders told of the cameras that drew the Lod. */
    private readonly seen: CameraRenders,
  ) {}

  /**
   * `camera`, a shadow map's when `shadow`, rendering `scene`, wants the levels of the bits `wanted`: note it, drop the
   * cameras that stopped rendering the Lod, and answer the renderer's frame.
   */
  set(scene: Scene, camera: Camera, wanted: number, shadow: boolean): number {
    this.see(scene, camera);
    for (const [other, request] of this.requests) if (!this.fresh(other, request)) this.requests.delete(other);
    let request = this.requests.get(camera);
    if (!request) this.requests.set(camera, (request = { levels: 0, round: this.round, frame: null }));
    request.round = this.round;
    const frame = this.renderer.info.frame;
    request.frame = shadow ? frame : null;
    if (!shadow) this.cameraFrame = frame;
    request.levels = wanted;
    return frame;
  }

  /** Note what a render of `scene` with `camera` tells: nothing outside the renderer's renders. */
  private see(scene: Scene, camera: Camera): void {
    const { renderer } = this;
    if (!busy(renderer)) return;
    this.seen.note(renderer, scene, camera);
    if (inShadowMap(scene)) return;
    if (this.inRound.has(camera)) {
      this.round++;
      this.inRound.clear();
    }
    this.inRound.add(camera);
  }

  /** The cameras still rendering the Lod. */
  cameras(): Camera[] {
    return [...this.requests].flatMap(([camera, request]) => (this.fresh(camera, request) ? [camera] : []));
  }

  /**
   * The bits of the levels wanted by the cameras still rendering the Lod (see `rendering`): each camera that renders
   * the scene once a frame counts, whatever their order, and one that stopped rendering it drops out.
   */
  needed(): number {
    let bits = 0;
    for (const [camera, request] of this.requests) if (this.fresh(camera, request)) bits |= request.levels;
    return bits;
  }

  /**
   * Whether `camera` still renders the Lod: it updated it in the current or last round, or it is a shadow map's whose
   * target is not disposed (see `fresh`).
   */
  rendering(camera: Camera): boolean {
    const request = this.requests.get(camera);
    return request !== undefined && this.fresh(camera, request);
  }

  /**
   * Whether `camera`'s `request` still counts: made in the current or last round, or a shadow map's while its map's
   * target is not disposed, as the scene's cameras draw what its last update filled however seldom it is redrawn
   * (three redraws a map whose `autoUpdate` is off only when asked). A shadow map's made this frame counts too, before
   * a render notes its target: three draws a map at most once a frame, so a camera rendered again in the frame draws
   * the map the update filled.
   */
  private fresh(camera: Camera, request: Request): boolean {
    if (request.round >= this.round - 1) return true;
    if (request.frame === null) return false;
    return request.frame === this.renderer.info.frame || this.seen.drawsShadowMap(camera);
  }
}
