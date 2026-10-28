import * as THREE from "three/webgpu";
import type { Wind } from "@drawcall/lod";

/** Exact far representations remain visible until their complete family is ready. */
export interface Family {
  readonly object: THREE.Object3D;
  readonly ready: boolean;
  readonly loading: boolean;
  load(): Promise<void>;
  needs(camera: THREE.Camera): boolean;
  onReady: () => void;
  applyWind(wind: Wind): void;
}

export class Stream implements Family {
  readonly object = new THREE.Group();
  ready = false;
  loading = false;
  onReady = () => {};
  private pending: Promise<void> | undefined;
  private wind: Wind | undefined;

  constructor(
    name: string,
    far: THREE.Object3D[],
    private readonly detail: () => Promise<THREE.Object3D[]>,
    readonly needs: (camera: THREE.Camera) => boolean,
    private readonly sway?: (root: THREE.Object3D, wind: Wind) => void,
    private readonly retire?: (old: THREE.Object3D[]) => void,
  ) {
    this.object.name = name;
    if (far.length) this.object.add(...far);
  }

  applyWind(wind: Wind): void {
    this.wind = wind;
    this.sway?.(this.object, wind);
  }

  load(): Promise<void> {
    this.pending ??= this.install();
    return this.pending;
  }

  private async install(): Promise<void> {
    this.loading = true;
    try {
      const objects = await this.detail();
      const previous = [...this.object.children];
      this.object.clear();
      if (objects.length) this.object.add(...objects);
      this.object.updateWorldMatrix(true, true);
      if (this.wind) this.sway?.(this.object, this.wind);
      this.ready = true;
      this.onReady();
      this.retire?.(previous.filter((object) => !objects.includes(object)));
    } finally {
      this.loading = false;
    }
  }
}

/** Conservative detail demand, including offscreen objects that can cast into the view. */
export function needed(camera: THREE.Camera, centre: THREE.Vector3, radius: number, pixels: number, height: number): boolean {
  const scale = (camera.projectionMatrix.elements[5] ?? 1) * height;
  if (camera instanceof THREE.OrthographicCamera) return radius * scale >= pixels;
  eye.setFromMatrixPosition(camera.matrixWorld);
  return (radius * scale) / Math.max(eye.distanceTo(centre) - radius, 1e-6) >= pixels;
}

const eye = new THREE.Vector3();
