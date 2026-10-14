import * as THREE from "three";
import { ImpostorMesh, boxCentre, fadeMaterial, boundingRadius, type Impostor } from "@drawcall/impostor";
import { WORLD_SIZE, height, mulberry32, noise2 } from "./world.js";

// One species = one baked impostor drawn for every instance (a single ImpostorMesh),
// plus the source's sub-meshes as InstancedMeshes that only hold the instances near
// enough to be in or past the hand-off band. The near lists are rebuilt from a spatial
// grid when the camera has moved far enough, never by scanning all instances.

export interface SpeciesSource {
  name: string;
  /** the object that was baked, in its own space */
  root: THREE.Object3D;
  impostor: Impostor;
  /** relative abundance */
  weight: number;
}

interface Part {
  mesh: THREE.InstancedMesh;
  /** sub-mesh space to baked-root space */
  toRoot: THREE.Matrix4;
  materials: THREE.Material[];
}

export interface Species {
  name: string;
  impostor: Impostor;
  far: ImpostorMesh;
  parts: Part[];
  /** instance transforms, 16 floats each, column-major */
  matrices: Float32Array;
  /** bounding-centre world position and bounding diameter per instance */
  centres: Float32Array;
  diameters: Float32Array;
  maxDiameter: number;
  count: number;
  near: number;
}

export type Mode = "hybrid" | "impostor" | "real";

export const REAL_RADIUS = 250;
const GRID_CELL = 20;
const REBUILD_DISTANCE = 5;

export class Forest {
  readonly group = new THREE.Group();
  readonly species: Species[] = [];
  /** one band shared by every faded real material; the ImpostorMeshes are kept in sync */
  readonly band: THREE.Vector2;
  private mode: Mode = "hybrid";
  private tint = false;
  private readonly last = new THREE.Vector3(Infinity, Infinity, Infinity);
  // Grid of instances, compressed rows: cell c holds items[start[c] .. start[c + 1]).
  private readonly cells: number;
  private readonly start: Uint32Array;
  private readonly items: Uint32Array; // species << 24 | index

  constructor(sources: SpeciesSource[], total: number, readonly fade: [number, number], seed = 1) {
    this.band = new THREE.Vector2(...fade);
    const placed = scatter(sources, total, seed);
    sources.forEach((source, s) => this.species.push(this.createSpecies(source, placed[s]!)));

    this.cells = Math.ceil(WORLD_SIZE / GRID_CELL);
    const counts = new Uint32Array(this.cells * this.cells + 1);
    const cellOf = (sp: Species, i: number) => this.cell(sp.matrices[i * 16 + 12]!, sp.matrices[i * 16 + 14]!);
    for (const sp of this.species) for (let i = 0; i < sp.count; i++) counts[cellOf(sp, i) + 1]!++;
    for (let c = 0; c < counts.length - 1; c++) counts[c + 1]! += counts[c]!;
    this.start = counts.slice();
    this.items = new Uint32Array(counts[counts.length - 1]!);
    const fill = counts.slice();
    this.species.forEach((sp, s) => {
      for (let i = 0; i < sp.count; i++) this.items[fill[cellOf(sp, i)]!++] = (s << 24) | i;
    });
  }

  get total(): number {
    return this.species.reduce((n, s) => n + s.count, 0);
  }

  get nearCount(): number {
    return this.species.reduce((n, s) => n + s.near, 0);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    const handoff = mode === "hybrid";
    // band (0, 0) turns the dither off: in "real" mode the real meshes draw fully.
    this.band.set(...(handoff ? this.fade : ([0, 0] as [number, number])));
    for (const sp of this.species) {
      sp.far.visible = mode !== "real";
      sp.far.fadeBand.copy(this.band);
      for (const part of sp.parts) part.mesh.visible = mode !== "impostor";
    }
    this.last.set(Infinity, Infinity, Infinity);
  }

  /** Tint impostors red and real meshes blue, to see where the hand-off happens. */
  setTint(on: boolean): void {
    this.tint = on;
    for (const sp of this.species) {
      sp.far.material.color.set(on ? 0xff6060 : 0xffffff);
      for (const part of sp.parts)
        for (const m of part.materials) {
          const standard = m as THREE.MeshStandardMaterial;
          if (standard.emissive) standard.emissive.set(on ? 0x0a2a8a : 0x000000);
        }
    }
  }

  get tinted(): boolean {
    return this.tint;
  }

  /** Rebuild the near lists when the camera moved more than REBUILD_DISTANCE; returns whether it did. */
  update(camera: THREE.Vector3, force = false): boolean {
    if (!force && camera.distanceToSquared(this.last) < REBUILD_DISTANCE * REBUILD_DISTANCE) return false;
    this.last.copy(camera);
    if (this.mode === "impostor") {
      for (const sp of this.species) {
        sp.near = 0;
        for (const part of sp.parts) part.mesh.count = 0;
      }
      return true;
    }
    // Per species: the instance needs its real mesh while its subtense can exceed the
    // band's lower edge before the next rebuild, i.e. distance < diameter / fade[0]
    // plus the rebuild distance and a little slack.
    const slack = REBUILD_DISTANCE + 1;
    const reach = (diameter: number) => (this.mode === "real" ? REAL_RADIUS : diameter / this.fade[0] + slack);
    const maxReach = Math.max(...this.species.map((sp) => reach(sp.maxDiameter)));
    const lists = this.species.map(() => [] as number[]);
    const c0x = Math.max(0, this.cellAxis(camera.x - maxReach));
    const c1x = Math.min(this.cells - 1, this.cellAxis(camera.x + maxReach));
    const c0z = Math.max(0, this.cellAxis(camera.z - maxReach));
    const c1z = Math.min(this.cells - 1, this.cellAxis(camera.z + maxReach));
    for (let cz = c0z; cz <= c1z; cz++)
      for (let cx = c0x; cx <= c1x; cx++) {
        const c = cz * this.cells + cx;
        for (let k = this.start[c]!; k < this.start[c + 1]!; k++) {
          const item = this.items[k]!;
          const s = item >>> 24;
          const i = item & 0xffffff;
          const sp = this.species[s]!;
          const dx = sp.centres[i * 3]! - camera.x;
          const dy = sp.centres[i * 3 + 1]! - camera.y;
          const dz = sp.centres[i * 3 + 2]! - camera.z;
          const r = reach(sp.diameters[i]!);
          if (dx * dx + dy * dy + dz * dz < r * r) lists[s]!.push(i);
        }
      }
    const instance = new THREE.Matrix4();
    const out = new THREE.Matrix4();
    this.species.forEach((sp, s) => {
      const list = lists[s]!;
      sp.near = list.length;
      for (const part of sp.parts) {
        if (part.mesh.instanceMatrix.count < list.length) this.grow(part, list.length);
        const array = part.mesh.instanceMatrix.array as Float32Array;
        list.forEach((i, j) => {
          instance.fromArray(sp.matrices, i * 16);
          out.multiplyMatrices(instance, part.toRoot);
          out.toArray(array, j * 16);
        });
        part.mesh.count = list.length;
        part.mesh.instanceMatrix.clearUpdateRanges();
        part.mesh.instanceMatrix.addUpdateRange(0, list.length * 16);
        part.mesh.instanceMatrix.needsUpdate = true;
      }
    });
    return true;
  }

  private grow(part: Part, needed: number): void {
    const capacity = Math.max(needed, part.mesh.instanceMatrix.count * 2);
    const old = part.mesh;
    const mesh = new THREE.InstancedMesh(old.geometry, old.material, capacity);
    copySettings(old, mesh);
    this.group.remove(old);
    old.dispose();
    this.group.add(mesh);
    part.mesh = mesh;
  }

  private cellAxis(v: number): number {
    return Math.floor((v + WORLD_SIZE / 2) / GRID_CELL);
  }

  private cell(x: number, z: number): number {
    const cx = Math.min(this.cells - 1, Math.max(0, this.cellAxis(x)));
    const cz = Math.min(this.cells - 1, Math.max(0, this.cellAxis(z)));
    return cz * this.cells + cx;
  }

  private createSpecies(source: SpeciesSource, transforms: THREE.Matrix4[]): Species {
    const count = transforms.length;
    const matrices = new Float32Array(count * 16);
    const centres = new Float32Array(count * 3);
    const diameters = new Float32Array(count);
    const centre = new THREE.Vector3(...boxCentre(source.impostor.box));
    const diameter = 2 * boundingRadius(source.impostor.box);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    transforms.forEach((m, i) => {
      m.toArray(matrices, i * 16);
      p.copy(centre).applyMatrix4(m).toArray(centres, i * 3);
      m.decompose(p, q, s);
      diameters[i] = diameter * Math.max(s.x, s.y, s.z);
    });

    const far = new ImpostorMesh(source.impostor, count, { fadeBand: this.fade });
    far.name = `${source.name}-impostors`;
    far.instanceMatrix.array.set(matrices);
    far.instanceMatrix.needsUpdate = true;
    far.castShadow = true;
    // Received shadows are looked up at the reconstructed surface, so sunlit sides stay lit.
    far.receiveShadow = true;
    // One draw for the whole forest: culling the union sphere would never cull anything.
    far.frustumCulled = false;
    this.group.add(far);

    // The real parts: one InstancedMesh per sub-mesh of the baked root, with its own
    // faded copy of each material (fadeMaterial bakes toRoot into the material, and
    // refuses to patch a material twice).
    const parts: Part[] = [];
    source.root.updateWorldMatrix(true, true);
    const rootInverse = source.root.matrixWorld.clone().invert();
    source.root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const toRoot = rootInverse.clone().multiply(mesh.matrixWorld);
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const materials = list.map((m) => {
        const copy = m.clone();
        fadeMaterial(copy, source.impostor, this.band, toRoot);
        return copy;
      });
      const instanced = new THREE.InstancedMesh(mesh.geometry, Array.isArray(mesh.material) ? materials : materials[0]!, 256);
      instanced.name = `${source.name}-${mesh.name}-real`;
      instanced.count = 0;
      instanced.castShadow = true;
      instanced.receiveShadow = true;
      instanced.frustumCulled = false;
      instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(instanced);
      parts.push({
        mesh: instanced,
        toRoot,
        materials,
      });
    });
    const maxDiameter = diameters.reduce((a, b) => Math.max(a, b), 0);
    return { name: source.name, impostor: source.impostor, far, parts, matrices, centres, diameters, maxDiameter, count, near: 0 };
  }
}

function copySettings(from: THREE.InstancedMesh, to: THREE.InstancedMesh): void {
  to.name = from.name;
  to.castShadow = from.castShadow;
  to.receiveShadow = from.receiveShadow;
  to.frustumCulled = from.frustumCulled;
  to.visible = from.visible;
  to.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
}

/**
 * Deterministic placement: a jittered grid over the world, thinned by a clustered
 * density field (stands of trees, glades, a clearing at the origin), each point given a
 * species by weight, with pines dominating in some patches and broadleaf in others.
 */
function scatter(sources: SpeciesSource[], total: number, seed: number): THREE.Matrix4[][] {
  const random = mulberry32(seed);
  const margin = 40;
  const span = WORLD_SIZE - 2 * margin;
  // Candidate count so that accepted ~ total at the field's mean acceptance (~0.77).
  const spacing = Math.sqrt((span * span * 0.77) / total);
  const side = Math.floor(span / spacing);
  const out = sources.map(() => [] as THREE.Matrix4[]);
  const weights = sources.map((s) => s.weight);
  const up = new THREE.Vector3(0, 1, 0);
  for (let gz = 0; gz < side; gz++)
    for (let gx = 0; gx < side; gx++) {
      const x = -span / 2 + (gx + random()) * spacing;
      const z = -span / 2 + (gz + random()) * spacing;
      const roll = random();
      const yaw = random() * Math.PI * 2;
      const scale = 0.8 + random() * 0.5;
      const pick = random();
      const clustered = noise2(x / 90, z / 90) * 0.65 + noise2(x / 23 + 7, z / 23 - 3) * 0.35;
      let density = THREE.MathUtils.smoothstep(clustered, 0.18, 0.55) * 0.95 + 0.05;
      // A clearing around the origin, where the camera starts.
      const fromOrigin = Math.hypot(x - 20, z + 10);
      density *= THREE.MathUtils.smoothstep(fromOrigin, 28, 50);
      if (roll > density) continue;
      // Pines dominate where this field is high, broadleaf where it is low.
      const pineness = noise2(x / 160 - 11, z / 160 + 5);
      const w = weights.map((v, i) => v * (sources[i]!.name === "pine" ? 0.4 + 1.6 * pineness : sources[i]!.name === "tree" ? 1.8 - 1.6 * pineness : 1));
      const sum = w.reduce((a, b) => a + b, 0);
      let k = 0;
      for (let acc = w[0]! / sum; pick > acc && k < w.length - 1; acc += w[++k]! / sum);
      // Roots reach ~0.24 below the pivot; sink a little more so slopes never show a gap.
      const y = height(x, z) - 0.08 * scale;
      out[k]!.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(x, y, z),
          new THREE.Quaternion().setFromAxisAngle(up, yaw),
          new THREE.Vector3(scale, scale, scale),
        ),
      );
    }
  return out;
}
