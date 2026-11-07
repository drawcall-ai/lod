import {
  CircleGeometry,
  CustomBlending,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  SrcColorFactor,
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
  ZeroFactor,
  type Camera,
  type Object3D,
} from "three/webgpu";
import {
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  instanceIndex,
  max,
  modelWorldMatrix,
  positionGeometry,
  storage,
  uniform,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import { instanceGroup, isOrthographic, maxScale } from "../tsl.js";
import type { Selection } from "./select.js";

// A soft shadow under each instance where it meets the ground, drawn from the contact
// slots the selection fills alongside the levels' (see kernel.ts): one more indirect draw
// of the same selection, so a contact shows exactly when its instance does.
//
// Each contact is a disc in its instance's base plane (the plane y = 0 of the instance's
// own space, through its origin), darkest at the origin and clear at its rim, that
// multiplies what is already drawn beneath it. A disc of a level instance on sloped ground
// sinks into it on the uphill side; each point of the disc is drawn as far towards the
// eye as the ground could rise there on a slope of up to `SLOPE`, along its line of sight,
// so it keeps its place on screen and passes the depth test where it would have sunk.

/**
 * A soft contact shadow under each instance an InstancedLod draws: a disc around its origin in its base plane, darkest
 * at the origin. It darkens whatever opaque surface is drawn beneath it, so ground needs no shader of its own.
 */
export interface InstancedContact {
  /** The disc's radius, in an instance's own units: it scales with the instance, > 0. */
  radius: number;
  /** How much the disc darkens at the instance's origin, in [0, 1]. */
  strength: number;
  /** World distance from the viewing camera within which instances have a contact; they fade out over `CONTACT_FADE` of it. */
  distance: number;
}

/** Throws unless `contact` is a valid contact. */
export function checkContact(contact: InstancedContact): void {
  if (!(contact.radius > 0) || !Number.isFinite(contact.radius))
    throw new RangeError(`InstancedLod: contact radius must be finite and > 0, got ${contact.radius}`);
  if (!(contact.strength >= 0 && contact.strength <= 1)) throw new RangeError(`InstancedLod: contact strength must be in [0, 1], got ${contact.strength}`);
  if (!(contact.distance >= 0) || !Number.isFinite(contact.distance))
    throw new RangeError(`InstancedLod: contact distance must be finite and >= 0, got ${contact.distance}`);
}

/** The steepest ground, as rise over run, under which no part of a level disc sinks. */
const SLOPE = 0.3;
/** How far towards the eye even the disc's centre is drawn, as a fraction of its radius, against z-fighting with the ground. */
const LIFT = 0.02;

/** The unit disc every contact draws, in the plane y = 0, facing +y, its centre a vertex of its own. */
const disc = new CircleGeometry(1, 24).rotateX(-Math.PI / 2);
const discIndex = disc.index;
if (!discIndex) throw new Error("InstancedLod: the contact disc must be indexed");
/** The indices of one contact's disc. */
export const CONTACT_INDICES = discIndex.count;

/** The contacts of one Selection's instances. */
export class ContactMesh extends Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial> {
  /** The contact these discs draw, set by their InstancedLod before each view. */
  contact: InstancedContact = { radius: 1, strength: 0, distance: 0 };

  constructor(readonly selection: Selection) {
    const geometry = new InstancedBufferGeometry();
    geometry.index = discIndex;
    geometry.setAttribute("position", disc.getAttribute("position"));
    geometry.instanceCount = selection.capacity;
    super(geometry, material);
    this.name = "contact";
    // The selection decides what draws; the discs never cast or take shadows.
    this.frustumCulled = false;
    this.castShadow = false;
    this.receiveShadow = false;
  }

  /** Draw from `camera`'s contact slots. */
  aim(camera: Camera): void {
    const { args } = this.selection.view(camera);
    this.geometry.setIndirect(args.attribute, args.offset + this.selection.contactOffset);
  }

  /** Follow the selection to a new capacity. */
  rebind(): void {
    this.geometry.instanceCount = this.selection.capacity;
  }

  /** Frees its geometry; the disc's buffers and the material are shared. */
  dispose(): void {
    this.removeFromParent();
    this.geometry.dispose();
  }
}

const contactOf = (object: Object3D | null) => (object instanceof ContactMesh ? object : null);
const noSlots = new StorageBufferAttribute(new Uint32Array(1), 1);
const noFades = new StorageBufferAttribute(new Float32Array(1), 1);
const noMatrices = new StorageInstancedBufferAttribute(new Float32Array(16), 16);

const indices = storage(noSlots, "uint", 0)
  .setName("lodContactSlots")
  .setGroup(instanceGroup)
  .toReadOnly()
  .onObjectUpdate(({ object, camera }) => (camera && contactOf(object)?.selection.view(camera).indices) || noSlots);
const strengths = storage(noFades, "float", 0)
  .setName("lodContactStrengths")
  .setGroup(instanceGroup)
  .toReadOnly()
  .onObjectUpdate(({ object, camera }) => (camera && contactOf(object)?.selection.view(camera).fades) || noFades);
const matrices = storage(noMatrices, "mat4", 0)
  .setName("lodContactMatrices")
  .setGroup(instanceGroup)
  .toReadOnly()
  .onObjectUpdate(({ object }) => contactOf(object)?.selection.drawn ?? noMatrices);
const radius = uniform(1).onObjectUpdate(({ object }) => contactOf(object)?.contact.radius ?? 1);
const strength = uniform(0).onObjectUpdate(({ object }) => contactOf(object)?.contact.strength ?? 0);

/** Shared by every ContactMesh: what differs per crowd is read while it renders. */
const material = discMaterial();

function discMaterial(): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  const matrix = modelWorldMatrix.mul(matrices.element(indices.element(instanceIndex))).toVar();
  // From the disc's centre, 0, to its rim, 1.
  const out = positionGeometry.xz.length();
  const view = cameraViewMatrix.mul(matrix.mul(vec4(positionGeometry.mul(radius), 1))).toVar();
  const lift = radius.mul(maxScale(matrix)).mul(out.mul(SLOPE).add(LIFT));
  const toward = isOrthographic(cameraProjectionMatrix).select(
    vec4(view.xy, view.z.add(lift), 1),
    vec4(view.xyz.mul(max(float(1).sub(lift.div(view.xyz.length())), 0)), 1),
  );
  material.vertexNode = cameraProjectionMatrix.mul(toward);
  const fade = varying(strengths.element(instanceIndex)).setInterpolation("flat");
  const falloff = max(float(1).sub(varying(out)), 0).pow(2);
  material.colorNode = vec3(float(1).sub(strength.mul(fade).mul(falloff)));
  // What is drawn beneath, times the colour.
  material.blending = CustomBlending;
  material.blendSrc = ZeroFactor;
  material.blendDst = SrcColorFactor;
  material.blendSrcAlpha = ZeroFactor;
  material.blendDstAlpha = OneFactor;
  material.transparent = true;
  material.depthWrite = false;
  material.toneMapped = false;
  material.fog = false;
  return material;
}
