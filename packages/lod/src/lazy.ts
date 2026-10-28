import { Frustum, Matrix4, Object3D, Sphere, type Camera, type Object3DEventMap } from "three/webgpu";
import { ImpostorMesh, type ImpostorMeshOptions } from "./impostor/mesh/index.js";
import { validateImpostor, type Impostor } from "./impostor/impostor.js";
import { isLazyImpostor, sameClass } from "./three.js";

export interface LazyImpostorOptions {
  /** The switch height must be known before the atlas has loaded. */
  maxPixels: number;
  draw?: ImpostorMeshOptions;
}

export interface LazyImpostorEventMap extends Object3DEventMap {
  error: { error: unknown };
}

export interface LevelsEventMap extends Object3DEventMap {
  levelschange: {};
}

interface Shared {
  factory: (() => Promise<Impostor>) | undefined;
  status: "idle" | "loading" | "ready" | "error";
  value: Impostor | undefined;
  error: unknown;
  promise: Promise<Impostor> | undefined;
  attempt: number;
  reported: number;
  users: Set<LazyImpostor>;
}

interface Record {
  shared: Shared;
  mesh: ImpostorMesh | undefined;
  owners: number;
  disposed: boolean;
}

/**
 * An impostor level whose atlas is loaded only when a viewing camera may need it.
 * Put it after an eager source in Lod or InstancedLod. Until ready, the nearest
 * ready finer level draws instead. The factory can decode cached data or bake it;
 * it runs once across clones and concurrent requests. It does not upload textures.
 */
export class LazyImpostor extends Object3D<LazyImpostorEventMap> {
  readonly isLazyImpostor = true;
  readonly options: LazyImpostorOptions;
  private readonly state: Record;

  constructor(load: () => Promise<Impostor>, options: LazyImpostorOptions) {
    super();
    if (!(options.maxPixels > 0) || !Number.isFinite(options.maxPixels)) throw new Error("LazyImpostor: maxPixels must be finite and > 0");
    this.options = { maxPixels: options.maxPixels, draw: { ...options.draw } };
    this.state = {
      shared: { factory: load, status: "idle", value: undefined, error: undefined, promise: undefined, attempt: 0, reported: -1, users: new Set([this]) },
      mesh: undefined,
      owners: 0,
      disposed: false,
    };
  }

  get maxPixels(): number {
    return this.options.maxPixels;
  }
  get status(): Shared["status"] | "disposed" {
    const state = this.state;
    return state.disposed ? "disposed" : state.shared.status;
  }
  get error(): unknown {
    return this.state.shared.error;
  }
  get impostor(): Impostor | undefined {
    return this.state.shared.value;
  }

  /** Prefetch atlas data, or explicitly retry a failed request. Errors reject. */
  load(): Promise<Impostor> {
    const state = this.state,
      shared = state.shared;
    if (state.disposed) return Promise.reject(new Error("LazyImpostor: already disposed"));
    if (shared.status === "ready" && shared.value) return Promise.resolve(shared.value);
    if (shared.status === "loading" && shared.promise) return shared.promise;
    const factory = shared.factory;
    if (!factory) return Promise.reject(new Error("LazyImpostor: its source has been released"));
    const attempt = ++shared.attempt;
    shared.status = "loading";
    shared.error = undefined;
    shared.promise = Promise.resolve()
      .then(factory)
      .then((value) => {
        validateImpostor(value);
        if (shared.attempt !== attempt || shared.users.size === 0) throw new Error("LazyImpostor: disposed before loading completed");
        shared.value = value;
        shared.status = "ready";
        return value;
      })
      .catch((error: unknown) => {
        if (shared.attempt === attempt && shared.users.size > 0) {
          shared.status = "error";
          shared.error = error;
          for (const lazy of shared.users) lazy.dispatchEvent({ type: "error", error });
        }
        throw error;
      });
    return shared.promise;
  }

  override copy(source: LazyImpostor): this {
    const own = this.state,
      from = source.state;
    if (own.mesh || own.owners || own.disposed || from.disposed) throw new Error("LazyImpostor.copy: use an unused target and a live source");
    own.shared.users.delete(this);
    own.shared = from.shared;
    own.shared.users.add(this);
    this.options.maxPixels = source.maxPixels;
    this.options.draw = { ...source.options.draw };
    super.copy(source, false);
    return this;
  }

  override clone(): this {
    const factory = this.state.shared.factory;
    if (this.state.disposed || !factory) throw new Error("LazyImpostor.clone: already disposed");
    const clone = new LazyImpostor(factory, this.options).copy(this);
    if (!sameClass(this, clone)) throw new Error("LazyImpostor.clone: a subclass must override clone");
    return clone;
  }

  /** @internal LOD ownership; several crowds can share a template. */
  retain(): void {
    if (this.state.disposed) throw new Error("LazyImpostor: a disposed level cannot be reused");
    this.state.owners++;
  }

  /** @internal Release a LOD's ownership of this template. */
  release(): void {
    if (this.state.owners < 1) throw new Error("LazyImpostor: no owner to release");
    if (--this.state.owners === 0) this.dispose();
  }

  /** @internal The card has been installed, not merely decoded. */
  get available(): boolean {
    return this.state.mesh !== undefined;
  }

  /** @internal Install this descriptor's card before its LOD attaches draw hooks. */
  materialize(): void {
    const state = this.state;
    if (state.disposed || state.mesh || !state.shared.value) return;
    const mesh = new ImpostorMesh(state.shared.value, 1, this.options.draw);
    mesh.castShadow = this.castShadow;
    mesh.receiveShadow = this.receiveShadow;
    this.add(mesh);
    state.mesh = mesh;
  }

  /** @internal Demand starts one request, with one visible report on failure. */
  request(): void {
    const { shared, disposed } = this.state;
    if (disposed || shared.status !== "idle") return;
    const promise = this.load(),
      attempt = shared.attempt;
    void promise.catch((error: unknown) => {
      if (shared.users.size === 0 || shared.reported === attempt) return;
      shared.reported = attempt;
      console.error(error);
    });
  }

  /** Stops demand and releases this template's card. Pending work cannot install it. */
  dispose(): void {
    const state = this.state;
    if (state.disposed) return;
    state.disposed = true;
    if (state.mesh) {
      this.remove(state.mesh);
      state.mesh.dispose();
      state.mesh = undefined;
    }
    state.shared.users.delete(this);
    if (state.shared.users.size === 0) {
      state.shared.attempt++;
      state.shared.value = undefined;
      state.shared.promise = undefined;
      // Factories often retain an authored source or a CPU-only geometry snapshot.
      state.shared.factory = undefined;
    }
  }
}

export function available(object: Object3D): boolean {
  return !isLazyImpostor(object) || object.available;
}

/** Each logical level's nearest available finer level; eager empty levels still cull. */
export function fallbacks(objects: readonly Object3D[]): number[] {
  let ready = 0;
  return objects.map((object, index) => (available(object) ? (ready = index) : ready));
}

const views = new WeakMap<Camera, { projection: Matrix4; world: Matrix4; frustum: Frustum }>();
const projectionView = new Matrix4(),
  worldSphere = new Sphere();

/** Demand only from the viewing frustum; lazy shadow work uses the ready fallback. */
export function inView(camera: Camera, root: Matrix4, sphere: Sphere): boolean {
  if (sphere.isEmpty()) return false;
  let cached = views.get(camera);
  if (!cached) {
    cached = { projection: new Matrix4().makeScale(0, 0, 0), world: new Matrix4(), frustum: new Frustum() };
    views.set(camera, cached);
  }
  if (!cached.projection.equals(camera.projectionMatrix) || !cached.world.equals(camera.matrixWorld)) {
    cached.projection.copy(camera.projectionMatrix);
    cached.world.copy(camera.matrixWorld);
    projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    cached.frustum.setFromProjectionMatrix(projectionView, camera.coordinateSystem, camera.reversedDepth);
  }
  worldSphere.copy(sphere).applyMatrix4(root);
  return cached.frustum.intersectsSphere(worldSphere);
}
