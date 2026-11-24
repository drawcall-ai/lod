import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  HalfFloatType,
  Mesh,
  NearestFilter,
  NodeMaterial,
  OrthographicCamera,
  RenderTarget,
  Scene,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  Vector4,
  type Box3,
  type Node,
  type Object3D,
  type Renderer,
} from "three/webgpu";
import { Fn, If, Loop, attribute, float, int, ivec2, max, min, mrt, normalize, positionGeometry, textureLoad, uniformArray, uv, vec3, vec4 } from "three/tsl";
import { at } from "../at.js";
import { bakeCopy, readBytes, zeroes } from "../bake.js";
import { boundingBox, showDetail } from "../source/detail.js";
import { tangentFrame } from "../source/frame.js";
import { swapMaterials } from "../impostor/bake/materials.js";
import { nextTask } from "../task.js";
import { windowDepth } from "./interior/rooms.js";
import type { Low } from "./low.js";

/** The baked maps, RGBA8 each, row 0 at v = 0. */
export interface Maps {
  /** sRGB base colour; alpha 255 where the surface is, 0 where it is cut out */
  color: Uint8Array;
  /** tangent-space normal, in the frame three derives from the low mesh's UVs */
  normal: Uint8Array;
  /** R occlusion, G roughness, B metalness */
  orm: Uint8Array;
  /**
   * RG8: R the room behind the nearest window texel + 1 (0 without rooms), G the share of a window texel through which
   * its room shows (0 elsewhere)
   */
  windows: Uint8Array;
}

/** The directions the source is seen from: toward the faces, edges and corners of a cube. */
const VIEWS = (() => {
  const views: Vector3[] = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) views.push(new Vector3(x, y, z).normalize());
  return views;
})();

/** How the views lie side by side in one target: `COLUMNS` across, top row first. */
const COLUMNS = 6;
const ROWS = Math.ceil(VIEWS.length / COLUMNS);

/** Most pixels a view renders across: the target holds every view, in half floats. */
const MAX_VIEW = 512;

/**
 * Project `source`'s surface onto `low`'s texels, `size` square, on `renderer`'s GPU. The source is rendered unlit with
 * its own materials (see `swapMaterials`) from each of `VIEWS`, orthographically; each texel takes what the view
 * facing its normal best sees there, from a view that sees the source at the texel or behind it: nothing of the
 * source in front of the low surface by more than `reach`. Over an open source such as a canopy of leaves, a texel
 * between them takes the leaves lower down that a viewer sees through the gap. A texel no view sees anything at is open:
 * cut out if `cutout`, as the source shows nothing there either, else (an opaque low mesh cannot show a hole) coloured
 * like its neighbours. Texels no surface was baked into are filled from their neighbours, so filtering and mips do not
 * pull in black at chart edges.
 *
 * With room `boxes`, a texel whose surface is glass is a window into the room behind it (see `windowDepth`).
 */
export async function project(
  source: Object3D,
  low: Low,
  size: number,
  texelSize: number,
  reach: number,
  cutout: boolean,
  boxes: readonly Box3[] | null,
  renderer: Renderer,
): Promise<Maps> {
  const copy = await bakeCopy(source);
  const root = copy.root;
  root.matrix.identity();
  root.matrix.decompose(root.position, root.quaternion, root.scale);
  root.updateMatrixWorld(true);
  root.visible = true;
  showDetail(root);
  const bounds = boundingBox(root);
  const centre = bounds.getCenter(new Vector3());
  const radius = bounds.getSize(new Vector3()).length() / 2;
  const distance = 2 * radius + 1e-3;
  const swapped = swapMaterials(root, { distance, radius, textureBias: 0 });
  const scene = new Scene().add(root);
  const camera = new OrthographicCamera(-radius, radius, radius, -radius, 0, 4 * radius + 1e-3);
  camera.matrixAutoUpdate = false;
  camera.layers.enableAll();
  const pixels = Math.min(MAX_VIEW, 2 ** Math.ceil(Math.log2((2 * radius) / texelSize)));
  const views = new RenderTarget(pixels * COLUMNS, pixels * ROWS, {
    count: 4,
    type: HalfFloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: true,
  });
  ["base", "normalDepth", "orm", "transmittance"].forEach((name, i) => (at(views.textures, i).name = name));
  const baked = new RenderTarget(size, size, { count: 4, type: UnsignedByteType, minFilter: NearestFilter, magFilter: NearestFilter });
  ["color", "normal", "orm", "windows"].forEach((name, i) => (at(baked.textures, i).name = name));
  at(baked.textures, 0).colorSpace = SRGBColorSpace;
  const bases = VIEWS.map(basisOf);
  const shell = new Mesh(shellGeometry(low), projection(views, pixels, bases, { centre, radius, reach, boxes, depth: boxes ? windowDepth(boxes) : 0 }));
  shell.frustumCulled = false;
  const shellScene = new Scene().add(shell);
  const zeroViews = zeroes(["base", "normalDepth", "orm", "transmittance"]);
  const zeroBaked = zeroes(["color", "normal", "orm", "windows"]);
  const previous = renderer.getRenderTarget();
  try {
    // Every view in its square of one target: their squares and depths never meet.
    renderer.setRenderTarget(views);
    renderer.clear(false, true, true);
    zeroViews.quad.render(renderer);
    for (const [i, { direction, tangent, bitangent }] of bases.entries()) {
      // WebGPU counts viewport rows from the top, as the views lie.
      views.viewport.set((i % COLUMNS) * pixels, Math.floor(i / COLUMNS) * pixels, pixels, pixels);
      camera.matrix.makeBasis(tangent, bitangent, direction).setPosition(centre.clone().addScaledVector(direction, distance));
      camera.updateMatrixWorld(true);
      renderer.render(scene, camera);
      // Yield to the page between views, so that a long bake does not freeze it.
      await nextTask();
    }
    renderer.setRenderTarget(baked);
    zeroBaked.quad.render(renderer);
    renderer.render(shellScene, camera);
    const [color, normal, orm, windows] = await Promise.all([0, 1, 2, 3].map((i) => readBytes(renderer, baked, i)));
    if (!color || !normal || !orm || !windows) throw new Error("bakeMesh: a baked map is missing");
    finish({ color, normal, orm, windows }, size, cutout);
    return { color, normal, orm, windows: rg(windows) };
  } finally {
    renderer.setRenderTarget(previous);
    for (const material of [...swapped.materials, zeroViews.material, zeroBaked.material, shell.material]) [material].flat().forEach((m) => m.dispose());
    shell.geometry.dispose();
    views.dispose();
    baked.dispose();
    copy.dispose();
  }
}

/** A view looking back along `direction`, with its right and up. */
interface View {
  direction: Vector3;
  tangent: Vector3;
  bitangent: Vector3;
}

function basisOf(direction: Vector3): View {
  const up = Math.abs(direction.y) > 0.99 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  const tangent = new Vector3().crossVectors(up, direction).normalize();
  return { direction, tangent, bitangent: new Vector3().crossVectors(direction, tangent) };
}

/**
 * `low` as triangles of their own, laid out in UV space, each corner with the smoothed normal, the triangle's own and
 * the tangent frame three derives there for a normal map (see `tangentFrame`).
 */
function shellGeometry({ positions, normals, uvs, index }: Low): BufferGeometry {
  const count = index.length;
  const attributes = { position: 3, normal: 3, uv: 2, face: 3, tangent: 3, bitangent: 3 } as const;
  const data = Object.fromEntries(Object.entries(attributes).map(([name, size]) => [name, new Float32Array(count * size)])) as Record<
    keyof typeof attributes,
    Float32Array
  >;
  const p = [new Vector3(), new Vector3(), new Vector3()] as const;
  const e1 = new Vector3();
  const e2 = new Vector3();
  const face = new Vector3();
  const n = new Vector3();
  const t = new Vector3();
  const b = new Vector3();
  for (let i = 0; i < count; i += 3) {
    const corners = [index[i] ?? 0, index[i + 1] ?? 0, index[i + 2] ?? 0] as const;
    corners.forEach((v, k) => at(p, k).fromArray(positions, v * 3));
    e1.subVectors(p[1], p[0]);
    e2.subVectors(p[2], p[0]);
    face.crossVectors(e1, e2).normalize();
    const u = (k: number, c: number) => uvs[at(corners, k) * 2 + c] ?? 0;
    corners.forEach((v, k) => {
      const o = i + k;
      at(p, k).toArray(data.position, o * 3);
      n.fromArray(normals, v * 3)
        .normalize()
        .toArray(data.normal, o * 3);
      data.uv.set([u(k, 0), u(k, 1)], o * 2);
      face.toArray(data.face, o * 3);
      tangentFrame(e1, e2, u(1, 0) - u(0, 0), u(1, 1) - u(0, 1), u(2, 0) - u(0, 0), u(2, 1) - u(0, 1), n, t, b);
      t.toArray(data.tangent, o * 3);
      b.toArray(data.bitangent, o * 3);
    });
  }
  const geometry = new BufferGeometry();
  for (const [name, size] of Object.entries(attributes)) geometry.setAttribute(name, new BufferAttribute(data[name as keyof typeof attributes], size));
  return geometry;
}

/**
 * The material that draws the low shell in UV space, each texel taking what the view facing it best sees there of
 * those that see the source at the texel or behind it (see `project`). Every view lies `pixels` square in `views`.
 */
function projection(
  views: RenderTarget,
  pixels: number,
  bases: readonly View[],
  { centre, radius, reach, boxes, depth }: { centre: Vector3; radius: number; reach: number; boxes: readonly Box3[] | null; depth: number },
): NodeMaterial {
  const forwards = uniformArray<"vec4">(
    bases.map(({ direction }) => new Vector4(direction.x, direction.y, direction.z, 0)),
    "vec4",
  );
  const rights = uniformArray<"vec4">(
    bases.map(({ tangent }) => new Vector4(tangent.x, tangent.y, tangent.z, 0)),
    "vec4",
  );
  const ups = uniformArray<"vec4">(
    bases.map(({ bitangent }) => new Vector4(bitangent.x, bitangent.y, bitangent.z, 0)),
    "vec4",
  );
  const read = (name: string, texel: Node<"ivec2">) => {
    const texture = views.textures.find((t) => t.name === name);
    if (!texture) throw new Error(`bakeMesh: no view output ${name}`);
    return textureLoad(texture, texel);
  };
  const material = new NodeMaterial();
  material.side = DoubleSide;
  material.depthTest = material.depthWrite = false;
  // The shell's UVs are the target's texels: v = 0 is the bottom row, as the maps lie.
  material.vertexNode = vec4(uv().mul(2).sub(1), 0, 1);
  const point = positionGeometry;
  const smooth = normalize(attribute<"vec3">("normal", "vec3"));
  const face = normalize(attribute<"vec3">("face", "vec3"));
  // Rays follow the smoothed normal, so creases leave no gaps, unless smoothing broke down (back-to-back cards
  // welded). Which side faces out is the low triangle's.
  const out = smooth.dot(face).greaterThan(0.2).select(smooth, face);
  const local = point.sub(vec3(centre));
  // The view that sees the point and faces it best, and its pixel there: x, y and the view's index, or -1 for none.
  const choose = Fn(() => {
    const best = float(0).toVar();
    const chosen = vec3(-1).toVar();
    Loop(bases.length, ({ i }) => {
      const along = forwards.element(i).xyz;
      const facing = out.dot(along);
      // The view's pixel at the point, top row first as the GPU stores it, and the depth the point would have there
      // (see `swapMaterials`).
      const x = local.dot(rights.element(i).xyz).div(radius).mul(0.5).add(0.5);
      const y = local.dot(ups.element(i).xyz).div(radius).mul(0.5).add(0.5);
      const corner = ivec2(i.mod(COLUMNS).mul(pixels), i.div(COLUMNS).mul(pixels));
      const texel = corner.add(ivec2(int(x.mul(pixels)), int(float(1).sub(y).mul(pixels))));
      const here = local.dot(along).div(radius).mul(0.5).add(0.5);
      const inside = x.greaterThanEqual(0).and(x.lessThan(1)).and(y.greaterThanEqual(0)).and(y.lessThan(1));
      const coverage = read("base", texel).a;
      // Something seen there, and nothing of the source in front of the low surface.
      const sees = coverage.greaterThan(0).and(
        read("normalDepth", texel)
          .a.div(max(coverage, 1e-6))
          .lessThanEqual(here.add(reach / radius / 2)),
      );
      If(facing.greaterThan(best).and(inside).and(sees), () => {
        best.assign(facing);
        chosen.assign(vec3(float(texel.x), float(texel.y), float(i)));
      });
    });
    return chosen;
  })();
  const found = choose.z.greaterThanEqual(0);
  const view = int(max(choose.z, 0));
  const forward = forwards.element(view).xyz;
  const near = local.dot(forward).div(radius).mul(0.5).add(0.5);
  const pixel = ivec2(int(choose.x), int(choose.y));
  const base = read("base", pixel);
  const coverage = max(base.a, 1e-6);
  const seen = read("normalDepth", pixel).div(coverage);
  const glassy = read("transmittance", pixel).div(coverage);
  const tangent = attribute<"vec3">("tangent", "vec3");
  const bitangent = attribute<"vec3">("bitangent", "vec3");
  // The seen object-space normal in the frame (tangent, bitangent, smooth), which need not be orthonormal.
  const n = seen.rgb.mul(2).sub(1);
  const det = tangent.dot(bitangent.cross(smooth));
  const solved = vec3(n.dot(bitangent.cross(smooth)), n.dot(smooth.cross(tangent)), n.dot(tangent.cross(bitangent))).div(det);
  const surface = point.add(forward.mul(seen.a.sub(near).mul(2 * radius)));
  const room = boxes ? roomAlong(boxes, surface, out.negate(), depth) : float(-1);
  const glass = found.and(glassy.r.greaterThan(0)).and(room.greaterThanEqual(0));
  // A covered texel no view sees stays open: colour's alpha 0, orm's 1 (see `finish`).
  material.mrtNode = mrt({
    // Glass in its own colour, which a window shows where its room does not.
    color: found.select(vec4(min(base.rgb.div(coverage).div(max(glassy.g, 1e-6)), 1), 1), vec4(0)),
    normal: found.select(vec4(normalize(solved).mul(0.5).add(0.5), 1), vec4(0)),
    orm: found.select(vec4(read("orm", pixel).rgb.div(coverage), 1), vec4(0, 0, 0, 1)),
    windows: vec4(glass.select(room.add(1).div(255), 0), glass.select(glassy.r, 0), 0, 1),
  });
  return material;
}

/** The room a ray from `origin` along unit `direction` is in or enters first within `far`, as a float; -1 for none. */
function roomAlong(boxes: readonly Box3[], origin: Node<"vec3">, direction: Node<"vec3">, far: number) {
  const lows = uniformArray<"vec4">(
    boxes.map((box) => new Vector4(box.min.x, box.min.y, box.min.z, 0)),
    "vec4",
  );
  const highs = uniformArray<"vec4">(
    boxes.map((box) => new Vector4(box.max.x, box.max.y, box.max.z, 0)),
    "vec4",
  );
  return Fn(() => {
    const nearest = float(-1).toVar();
    const best = float(far).toVar();
    Loop(boxes.length, ({ i }) => {
      const low = lows.element(i).xyz;
      const high = highs.element(i).xyz;
      // Slab test: where the ray is inside the box along each axis, and so inside it.
      const inverse = vec3(1).div(direction);
      const a = low.sub(origin).mul(inverse);
      const b = high.sub(origin).mul(inverse);
      const enter = max(max(min(a.x, b.x), min(a.y, b.y)), min(a.z, b.z));
      const leave = min(min(max(a.x, b.x), max(a.y, b.y)), max(a.z, b.z));
      const distance = max(enter, 0);
      If(leave.greaterThanEqual(distance).and(distance.lessThanEqual(best)), () => {
        best.assign(distance);
        nearest.assign(float(i));
      });
    });
    return nearest;
  })();
}

/** The windows' R and G channels of `rgba`. */
function rg(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length / 2);
  for (let i = 0; i < out.length / 2; i++) {
    out[i * 2] = rgba[i * 4] ?? 0;
    out[i * 2 + 1] = rgba[i * 4 + 1] ?? 0;
  }
  return out;
}

/** What a texel became: no low triangle covers it, a surface was baked, or no view saw anything there. */
const EMPTY = 0;
const BAKED = 1;
const OPEN = 2;

/**
 * Settle the maps as read back: colours spread over everything not baked, open texels included, so coverage edges do
 * not fringe; coverage spreads only into texels no triangle covers. A texel is covered where orm's alpha is, baked where
 * colour's is.
 */
function finish({ color, normal, orm, windows }: Maps, size: number, cutout: boolean): void {
  const count = size * size;
  const state = new Uint8Array(count);
  for (let t = 0; t < count; t++) state[t] = (color[t * 4 + 3] ?? 0) > 0 ? BAKED : (orm[t * 4 + 3] ?? 0) > 0 ? OPEN : EMPTY;
  dilate(state, (texel) => texel === BAKED, [color, normal, orm], 0, 3, size);
  for (let texel = 0; texel < count; texel++) color[texel * 4 + 3] = state[texel] === BAKED ? 255 : 0;
  if (cutout) {
    dilate(state, (texel) => texel !== EMPTY, [color], 3, 1, size);
    // Coverage stays a decision: in or out, at 0.5.
    for (let i = 3; i < color.length; i += 4) color[i] = (color[i] ?? 0) >= 128 ? 255 : 0;
  } else for (let i = 3; i < color.length; i += 4) color[i] = 255;
  for (let i = 3; i < color.length; i += 4) normal[i] = orm[i] = 255;
  spreadRooms(windows, size);
}

/**
 * Give every texel of `windows` (RGBA) without a room the room of the nearest one with (by 4-neighbour steps): the share
 * filters across window edges and mip levels, and wherever it does the texel read there must name the window's room.
 */
function spreadRooms(windows: Uint8Array, size: number): void {
  let ring: number[] = [];
  for (let i = 0; i < size * size; i++) if (windows[i * 4]) ring.push(i);
  while (ring.length > 0) {
    const next: number[] = [];
    for (const i of ring) {
      const x = i % size;
      const room = windows[i * 4] ?? 0;
      for (const j of [x > 0 ? i - 1 : -1, x < size - 1 ? i + 1 : -1, i - size, i + size]) {
        if (j < 0 || j >= size * size || windows[j * 4]) continue;
        windows[j * 4] = room;
        next.push(j);
      }
    }
    ring = next;
  }
}

/**
 * Fill every texel `known` rejects with the mean of its known 8 neighbours, ring by ring outwards until the whole
 * texture is filled: `channels` channels from `first` of each layer.
 */
function dilate(state: Uint8Array, known: (state: number) => boolean, layers: Uint8Array[], first: number, channels: number, size: number): void {
  const done = new Uint8Array(state.length);
  const queued = new Uint8Array(state.length);
  let ring = new Int32Array(state.length);
  let next = new Int32Array(state.length);
  let length = 0;
  for (let i = 0; i < state.length; i++) done[i] = known(state[i] ?? EMPTY) ? 1 : 0;
  const enqueue = (i: number) => {
    const x = i % size;
    const y = (i - x) / size;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx;
        if (done[j] || queued[j]) continue;
        queued[j] = 1;
        next[length++] = j;
      }
  };
  for (let i = 0; i < state.length; i++) if (done[i]) enqueue(i);
  while (length > 0) {
    [ring, next] = [next, ring];
    const count = length;
    length = 0;
    for (let r = 0; r < count; r++) {
      const i = ring[r] ?? 0;
      const x = i % size;
      const y = (i - x) / size;
      for (const layer of layers)
        for (let c = first; c < first + channels; c++) {
          let sum = 0;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
              const j = ny * size + nx;
              if (!done[j]) continue;
              sum += layer[j * 4 + c] ?? 0;
              n++;
            }
          if (n > 0) layer[i * 4 + c] = Math.round(sum / n);
        }
    }
    // A ring becomes a source only for the next one.
    for (let r = 0; r < count; r++) done[ring[r] ?? 0] = 1;
    for (let r = 0; r < count; r++) enqueue(ring[r] ?? 0);
  }
}
