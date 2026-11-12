import { type Box3, BufferGeometry, type Camera, type Color, IndirectStorageBufferAttribute, type Layers, Matrix4, Mesh, type Object3D, type Sphere } from "three/webgpu";
import { setFadeSource, type DrawnInstances, type InstanceSlots } from "../levels/fade.js";
import { levelMaterial } from "../levels/material.js";
import { impostorInstances, type ImpostorMesh } from "../impostor/mesh/index.js";
import { isImpostorMesh, isInstancedMesh, isLOD, isLine, isMesh, isPoints, isSprite, rejectSkinned } from "../three.js";
import { DRAW_BYTES, type IndirectDraw } from "./rows.js";

// The meshes that draw a Lod's level: one plain three Mesh per mesh and material group of its object, or an
// ImpostorMesh for an impostor, each drawing every instance in its level's list for a camera with one indirect draw.

const IDENTITY = new Matrix4();
/** One indirect draw of nothing: what a level mesh draws before its Lod's first sort for a camera. */
const NOTHING = new IndirectStorageBufferAttribute(new Uint32Array(DRAW_BYTES / 4), 1);

/** A mesh of a level's object and one of its material groups, placed in the instance's space. */
export interface Part {
  template: Mesh;
  placement: Matrix4;
  group: number;
  draw: IndirectDraw;
}

/** What every level mesh of one Lod draws from. */
export interface MeshInputs {
  /** The instances, which a mesh made later draws too. */
  readonly instances: DrawnInstances;
  /**
   * Around every instance, in the Lod's space: what its meshes are culled by, and their box, which three's
   * Box3.setFromObject reads.
   */
  readonly bounds: Sphere;
  readonly box: Box3;
  /** Per camera, the instances in each level's list and where its indirect draws lie. */
  readonly slots: (camera: Camera) => InstanceSlots | null;
  /** One instance's bounding radius in its own space, which shadow casters are cut off at. */
  readonly radius: number;
  /** The Lod's layers, which its meshes are on. */
  readonly layers: Layers;
  /**
   * Where `camera`'s indirect draws lie as `renderer` draws a mesh for it, its lists sorted: the camera's due sort runs
   * now; null before the Lod's first sort for it. Never throws: three is rendering.
   */
  readonly drawFor: (renderer: unknown, camera: Camera) => InstanceSlots["args"] | null;
}

/** `object`'s meshes and material groups, placed once in the instance's space, for level `level`. */
export function partsOf(object: Object3D, level: number): Part[] {
  rejectSkinned(object, "Lod");
  object.updateWorldMatrix(true, true);
  const outside = object.parent ? object.parent.matrixWorld.clone().invert() : new Matrix4();
  const found: Part[] = [];
  object.traverse((node) => {
    if (isLOD(node)) throw new Error(`Lod: levels cannot contain a LOD ("${node.name}")`);
    if (isInstancedMesh(node) && !isImpostorMesh(node)) throw new Error(`Lod: levels cannot contain an InstancedMesh ("${node.name}")`);
    if (isLine(node) || isPoints(node) || isSprite(node)) throw new Error(`Lod: levels draw meshes, not the line, points or sprite "${node.name}"`);
    if (!isMesh(node)) return;
    const placement = outside.clone().multiply(node.matrixWorld);
    ranges(node).forEach((range, group) => found.push({ template: node, placement, group, draw: { level, ...range } }));
  });
  return found;
}

/** The index (or vertex) ranges `mesh` draws, clipped to its draw range, in group order, empty draws included. */
function ranges(mesh: Mesh): Array<{ count: number; start: number; indexed: boolean }> {
  const { geometry } = mesh;
  const indexed = geometry.index !== null;
  const total = geometry.index?.count ?? geometry.getAttribute("position").count;
  const groups = Array.isArray(mesh.material) ? geometry.groups : [{ start: 0, count: total }];
  return groups.map(({ start, count }) => {
    const first = Math.min(total, Math.max(0, start, geometry.drawRange.start));
    const end = Math.min(total, start + count, geometry.drawRange.start + geometry.drawRange.count);
    return { count: Math.max(0, end - first), start: first, indexed };
  });
}

/** A level's meshes, which draw once their indirect draws lie among a camera's (see `drawFrom`). */
export interface LevelMeshes {
  readonly meshes: Mesh[];
  /** The meshes' indirect draws, in order. */
  readonly draws: IndirectDraw[];
  /** Draw from the camera's draw `first` on, where `draws` were appended (see `InstanceSlots.args`). */
  drawFrom(first: number): void;
}

/** The meshes drawing `parts`, tinted by `tint`. */
export function levelMeshes(parts: readonly Part[], tint: Color, inputs: MeshInputs): LevelMeshes {
  let first: number | null = null;
  const offset = (i: number) => (first === null ? null : (first + i) * DRAW_BYTES);
  return {
    meshes: parts.map((part, i) => levelMesh(part, () => offset(i), tint, inputs)),
    draws: parts.map((part) => part.draw),
    drawFrom: (start) => void (first = start),
  };
}

/** Release `mesh`, which may never have been added. */
export function freeMesh(mesh: Mesh): void {
  // ImpostorMesh.dispose also destroys its instance buffers, which are the Lod's.
  if (isImpostorMesh(mesh)) mesh.material.release();
  mesh.geometry.dispose();
}

/** Point every mesh of `meshes` at `instances`, which changed: survivors scale or no longer do, or the attributes were replaced. */
export function drawInstances(meshes: readonly Mesh[], instances: DrawnInstances): void {
  for (const mesh of meshes) {
    if (isImpostorMesh(mesh)) mesh.instanceMatrix = instances.matrices;
    Object.assign(mesh, { instanceColor: instances.colors });
  }
}

/**
 * Material group `group` of `template` drawn for every instance in level `level`'s list, from byte `offset()` of a
 * camera's draws, once there is one, on the Lod's layers. Only the Lod's raycast hits its instances.
 */
function levelMesh({ template, placement, group }: Part, offset: () => number | null, tint: Color, inputs: MeshInputs): Mesh {
  const { instances, bounds, box, slots, radius, layers, drawFor } = inputs;
  // An impostor card is placed in the shader; any other mesh draws its geometry moved into the instance's space, so
  // the instance matrix is all it needs.
  const mesh = isImpostorMesh(template) ? card(template, placement, inputs) : plain(template, placement, group, instances);
  setFadeSource(mesh, {
    slots,
    radius,
    tint,
    level: isImpostorMesh(template) ? undefined : { instances, space: placement.clone().invert() },
  });
  mesh.name = template.name;
  mesh.castShadow = template.castShadow;
  mesh.receiveShadow = template.receiveShadow;
  mesh.layers = layers;
  mesh.raycast = () => {};
  if (!isImpostorMesh(mesh)) mesh.geometry.boundingSphere = bounds;
  mesh.geometry.boundingBox = box;
  const previous = mesh.onBeforeRender;
  // Each camera draws the instances in its own lists. A level compiling to join draws nothing yet: its pipelines do not
  // depend on the indirect draw.
  mesh.onBeforeRender = (renderer, scene, camera, geometry, material, drawn) => {
    previous.call(mesh, renderer, scene, camera, geometry, material, drawn);
    const start = offset();
    if (start === null) return;
    const args = drawFor(renderer, camera);
    if (args) mesh.geometry.setIndirect(args.attribute, args.offset + start);
    else mesh.geometry.setIndirect(NOTHING, 0);
  };
  return mesh;
}

/**
 * A plain mesh drawing `template`'s geometry moved by `placement`, with a geometry of its own, which its draws point
 * at their camera's indirect draws, over the moved one's buffers.
 */
function plain(template: Mesh, placement: Matrix4, group: number, instances: DrawnInstances): Mesh {
  const moved = placed(template.geometry, placement);
  const geometry = new BufferGeometry();
  geometry.index = moved.index;
  for (const [name, attribute] of Object.entries(moved.attributes)) geometry.setAttribute(name, attribute);
  geometry.morphAttributes = moved.morphAttributes;
  // three's NodeMaterial multiplies a draw's colour by the varying vInstanceColor wherever its object has an
  // instanceColor; placeInstances (see fade.ts) writes it.
  return Object.assign(new Mesh(geometry, groupMaterial(template, group)), { instanceColor: instances.colors });
}

/** An impostor's cards for the instances in a level's list. */
function card(template: ImpostorMesh, placement: Matrix4, { instances, bounds }: MeshInputs): ImpostorMesh {
  const mesh = impostorInstances(template, 0, placement);
  // Indirect draws give the count. Three otherwise keys a card's shader by its count, one per object.
  mesh.count = 1;
  mesh.instanceMatrix = instances.matrices;
  mesh.instanceColor = instances.colors;
  mesh.boundingSphere = bounds;
  return mesh;
}

/** The level material of `mesh`'s material group `group`. */
function groupMaterial(mesh: Mesh, group: number) {
  if (!Array.isArray(mesh.material)) return levelMaterial(mesh.material);
  const index = mesh.geometry.groups[group]?.materialIndex ?? 0;
  const material = mesh.material[index];
  if (!material) throw new Error(`Lod: "${mesh.name}" has no material ${index}`);
  return levelMaterial(material);
}

/**
 * Placed copies of geometries, shared by every Lod drawing the same mesh the same way: a side table, as three's
 * BufferGeometry has no room for a package's state.
 */
const copies = new WeakMap<BufferGeometry, Array<{ placement: Matrix4; geometry: BufferGeometry }>>();

/** `geometry` moved by `placement`: itself for the identity, else a copy made once. */
function placed(geometry: BufferGeometry, placement: Matrix4): BufferGeometry {
  if (placement.equals(IDENTITY)) return geometry;
  const known = copies.get(geometry) ?? [];
  copies.set(geometry, known);
  const hit = known.find((entry) => entry.placement.equals(placement));
  if (hit) return hit.geometry;
  const copy = geometry.clone();
  const box = copy.boundingBox;
  const sphere = copy.boundingSphere;
  // applyMatrix4 otherwise recomputes both bounds by walking the transformed vertices.
  copy.boundingBox = null;
  copy.boundingSphere = null;
  // Translations leave normals and tangents unchanged; scanning them stalls large source arrivals.
  if (placement.clone().setPosition(0, 0, 0).equals(IDENTITY)) {
    const position = copy.getAttribute("position");
    if (position) {
      position.applyMatrix4(placement);
      position.needsUpdate = true;
    }
  } else copy.applyMatrix4(placement);
  copy.boundingBox = box?.applyMatrix4(placement) ?? null;
  copy.boundingSphere = sphere?.applyMatrix4(placement) ?? null;
  geometry.addEventListener("dispose", () => copy.dispose());
  known.push({ placement: placement.clone(), geometry: copy });
  return copy;
}
