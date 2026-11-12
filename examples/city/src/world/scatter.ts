import type { GLTSInstances, GLTSLoader } from "@drawcall/glts";
import { Lod, type LodCluster } from "@drawcall/lod";
import * as THREE from "three/webgpu";
import { envelope } from "./bounds.ts";
import type { Spot } from "./plan.ts";

/** A copy of an asset: where it stands, and its colour, white without. */
export interface Copy {
  matrix: THREE.Matrix4;
  color?: THREE.Color;
}

/** Instances of an asset that a part of the world writes itself: `count` of its node's, from `start`. */
export interface Range {
  node: GLTSInstances;
  start: number;
  count: number;
}

/** Edge of the square regions placed copies are clustered by, so that whole regions out of view are culled. */
const REGION = 1000;

/** An asset scattered over the world: its node of instances, the Lod in it, and what takes its instances. */
interface Scattered {
  node: GLTSInstances;
  lod: Lod;
  /** Runs of copies placed, each from its first instance, sorted by region. */
  placed: { start: number; copies: Copy[] }[];
  size: number;
  /** Whether the ranges taken are written by a compute pass, on the GPU, or on the CPU; undefined while none is taken. */
  computed: boolean | undefined;
  sealed: boolean;
}

/**
 * Glts assets drawn at many places, each through one node of instances however many parts of the world place it, so
 * that they share its levels: parts place copies and take ranges to write themselves until `seal`, which gives every
 * node its instances, the copies clustered by region.
 */
export class Scatter extends THREE.Group {
  private readonly assets = new Map<string, Promise<Scattered>>();

  constructor(private readonly loader: GLTSLoader) {
    super();
  }

  /** The Lod drawing `url`, an asset holding one: its levels to measure and tune. Loads the asset the first time. */
  async lod(url: string): Promise<Lod> {
    return (await this.asset(url)).lod;
  }

  /** The Lod of every asset. */
  async lods(): Promise<Lod[]> {
    return (await Promise.all(this.assets.values())).map(({ lod }) => lod);
  }

  /** Place `copies` of `url`. */
  async place(url: string, copies: readonly Copy[]): Promise<void> {
    const asset = await this.open(url);
    const keys = new Map(copies.map((copy) => [copy, regionOf(copy)]));
    const sorted = [...copies].sort((a, b) => (keys.get(a) ?? "").localeCompare(keys.get(b) ?? ""));
    asset.placed.push({ start: asset.size, copies: sorted });
    asset.size += copies.length;
  }

  /** Take `count` instances of `url` to write after `seal`: by a compute pass if `computed`, else on the CPU. */
  async take(url: string, count: number, computed: boolean): Promise<Range> {
    const asset = await this.open(url);
    if (asset.computed === !computed) throw new Error(`Scatter: ${url}'s instances would be written on both the CPU and the GPU`);
    asset.computed = computed;
    const range = { node: asset.node, start: asset.size, count };
    asset.size += count;
    return range;
  }

  /**
   * Give every asset its instances: the copies placed, a cluster per region of them, and the ranges taken, which draw
   * only in the clusters their writers add to the node's. Instances a compute pass writes live in storage attributes,
   * where a colour takes 4 floats.
   */
  async seal(): Promise<void> {
    for (const asset of await Promise.all(this.assets.values())) {
      const { node, lod, size, placed } = asset;
      const computed = asset.computed ?? false;
      asset.sealed = true;
      const stride = computed ? 4 : 3;
      const matrices = new Float32Array(size * 16);
      const colors = new Float32Array(size * stride).fill(1);
      const clusters: LodCluster[] = [];
      const box = envelope(lod.levels);
      for (const { start, copies } of placed) {
        copies.forEach(({ matrix, color }, i) => {
          matrix.toArray(matrices, (start + i) * 16);
          color?.toArray(colors, (start + i) * stride);
        });
        clusters.push(...regions(start, copies, box, computed));
      }
      node.instanceMatrix = computed ? new THREE.StorageInstancedBufferAttribute(matrices, 16) : new THREE.InstancedBufferAttribute(matrices, 16);
      if (computed) node.instanceColor = new THREE.StorageInstancedBufferAttribute(colors, 4);
      else if (placed.some(({ copies }) => copies.some(({ color }) => color))) node.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      node.count = size;
      node.clusters = clusters;
    }
  }

  /** `url`'s asset, while it takes copies and ranges. */
  private async open(url: string): Promise<Scattered> {
    const asset = await this.asset(url);
    if (asset.sealed) throw new Error(`Scatter: ${url} is sealed`);
    return asset;
  }

  private asset(url: string): Promise<Scattered> {
    let asset = this.assets.get(url);
    if (!asset) {
      // one instance until `seal` gives the node its own
      asset = this.loader.loadInstancesAsync(url, 1).then((node) => {
        this.add(node);
        return { node, lod: lodOf(node), placed: [], size: 0, computed: undefined, sealed: false };
      });
      this.assets.set(url, asset);
    }
    return asset;
  }
}

const position = new THREE.Vector3();

/** The region `copy` stands in. */
function regionOf(copy: Copy): string {
  position.setFromMatrixPosition(copy.matrix);
  return `${Math.floor(position.x / REGION)},${Math.floor(position.z / REGION)}`;
}

/**
 * A cluster per region of `copies`, sorted by region, from instance `start`: bounded by `box`, every level's, at each
 * copy, and, where `scaled`, by the scales of their matrices, which a Lod measures itself of CPU matrices only.
 */
function regions(start: number, copies: readonly Copy[], box: THREE.Box3, scaled: boolean): LodCluster[] {
  const clusters: LodCluster[] = [];
  let last: string | undefined;
  for (const [i, copy] of copies.entries()) {
    const region = regionOf(copy);
    const scale = copy.matrix.getMaxScaleOnAxis();
    let cluster = clusters.at(-1);
    if (!cluster || region !== last) {
      cluster = { start: start + i, count: 0, boundingBox: new THREE.Box3() };
      if (scaled) cluster.minScale = cluster.maxScale = scale;
      clusters.push(cluster);
      last = region;
    }
    cluster.count++;
    cluster.boundingBox.union(at.copy(box).applyMatrix4(copy.matrix));
    if (cluster.minScale !== undefined) cluster.minScale = Math.min(cluster.minScale, scale);
    if (cluster.maxScale !== undefined) cluster.maxScale = Math.max(cluster.maxScale, scale);
  }
  return clusters;
}

const at = new THREE.Box3();

/** The Lod an asset's node draws with: the one Lod among its objects. */
export function lodOf(node: THREE.Object3D): Lod {
  const lods: Lod[] = [];
  node.traverse((object) => {
    if (object instanceof Lod) lods.push(object);
  });
  const [lod] = lods;
  if (!lod || lods.length > 1) throw new Error(`${node.name || "An asset"} holds ${lods.length} Lods, not one`);
  return lod;
}

/** Copies standing at `spots`: on the ground, turned and scaled; coloured by `color` when given. */
export function copiesAt(spots: readonly Spot[], color?: (spot: Spot, index: number) => THREE.Color): Copy[] {
  return spots.map((spot, index) => ({
    matrix: new THREE.Matrix4().compose(
      new THREE.Vector3(spot.x, spot.y, spot.z),
      new THREE.Quaternion().setFromAxisAngle(UP, spot.angle),
      new THREE.Vector3().setScalar(spot.scale),
    ),
    color: color?.(spot, index),
  }));
}

const UP = new THREE.Vector3(0, 1, 0);
