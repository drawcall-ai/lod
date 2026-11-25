import { Matrix4, OrthographicCamera, RenderTarget, Scene, Vector3, type Renderer } from "three/webgpu";
import { at } from "../../at.js";
import { readBytes } from "../../bake.js";
import { PAD, RECT_PIXELS as TILE, boxCentre, boxExtent, type Impostor } from "../impostor.js";
import { ImpostorMesh } from "../mesh/index.js";
import { frameBasis, frameDirection, type Vec3 } from "../octahedral.js";

const FULL = [-1, -1, 1, 1] as const;
type Rect = [number, number, number, number];

function bounds(bytes: Uint8Array, side: number, tile: number): Rect | null {
  const x0 = (tile % side) * TILE;
  const y0 = Math.floor(tile / side) * TILE;
  const start = (y0 * TILE * side + x0) * 4 + 3;
  let left = TILE;
  let bottom = TILE;
  let right = 0;
  let top = 0;
  for (let y = 0; y < TILE; y++) {
    const row = start + y * side * TILE * 4;
    let x = 0;
    let end = TILE;
    while (x < TILE && !bytes[row + x * 4]) x++;
    if (x === TILE) continue;
    while (!bytes[row + (end - 1) * 4]) end--;
    left = Math.min(left, x);
    right = Math.max(right, end);
    bottom = Math.min(bottom, y);
    top = y + 1;
  }
  return right ? [left, bottom, right, top] : null;
}

function cellRect(training: (Rect | null)[], checks: (Rect | null)[]): readonly number[] {
  const fit = training.filter((r) => r !== null);
  if (!fit.length) return FULL;
  const left = Math.max(0, Math.min(...fit.map((r) => r[0])) - 1);
  const bottom = Math.max(0, Math.min(...fit.map((r) => r[1])) - 1);
  const right = Math.min(TILE, Math.max(...fit.map((r) => r[2])) + 1);
  const top = Math.min(TILE, Math.max(...fit.map((r) => r[3])) + 1);
  if (checks.some((r) => r && (r[0] < left || r[1] < bottom || r[2] > right || r[3] > top))) return FULL;
  return [left, bottom, right, top].map((v) => v * (2 / TILE) - 1);
}

/** Measure the stock card's blended coverage in packed views, in batches bounded independently of the atlas size. */
export async function fittedRects(impostor: Impostor, renderer: Renderer): Promise<number[] | undefined> {
  const { frames, layout, halfSize } = impostor;
  // With fewer than four frames per side every cell touches the pole where the card changes axes.
  if (frames < 4) return undefined;
  const last = frames - 1;
  const grid = frames * frames;
  const cells = last * last;
  const side = Math.min(16, last * 2);
  const capacity = side * side;
  const width = TILE * side;
  const camera = new OrthographicCamera(0, width, width, 0, 0.01, 2);
  camera.position.z = 1;
  const scene = new Scene();
  // At a distance the coverage dither can reveal islands too faint to pass the usual 0.5 cutoff in a reference view.
  const mesh = new ImpostorMesh(impostor, capacity, { depth: "card", parallax: 0, alphaTest: 1 / 255 });
  mesh.frustumCulled = false;
  mesh.placement.makeTranslation(new Vector3(...boxCentre(impostor.box)).negate());
  scene.add(mesh);
  const extent = boxExtent(impostor.box);
  // Match buildCard's half-extent along each axis, so every stock card fills exactly one reference tile.
  const scale = (a: Vec3) =>
    TILE / (2 * Math.min(halfSize, Math.abs(a[0]) * extent[0] + Math.abs(a[1]) * extent[1] + Math.abs(a[2]) * extent[2] + halfSize * PAD));
  const cellView = (cell: number, u: number, v: number) => frameDirection(layout, frames, (cell % last) + u, Math.floor(cell / last) + v);
  async function renderViews(count: number, samples: number, direction: (i: number) => Vec3) {
    const views: (Rect | null)[] = [];
    const target = new RenderTarget(width, width, { samples });
    try {
      renderer.setRenderTarget(target);
      for (let start = 0; start < count; start += capacity) {
        mesh.count = Math.min(capacity, count - start);
        for (let tile = 0; tile < mesh.count; tile++) {
          const n = direction(start + tile);
          const { tangent, bitangent } = frameBasis(n);
          const matrix = new Matrix4()
            .makeBasis(new Vector3(...tangent).multiplyScalar(scale(tangent)), new Vector3(...bitangent).multiplyScalar(scale(bitangent)), new Vector3(...n))
            .transpose();
          matrix.setPosition(((tile % side) + 0.5) * TILE, (Math.floor(tile / side) + 0.5) * TILE, 0);
          mesh.setMatrixAt(tile, matrix);
        }
        renderer.clear();
        renderer.render(scene, camera);
        const bytes = await readBytes(renderer, target, 0);
        for (let tile = 0; tile < mesh.count; tile++) views.push(bounds(bytes, side, tile));
      }
    } finally {
      target.dispose();
    }
    return views;
  }
  const previous = renderer.getRenderTarget();
  const face = renderer.getActiveCubeFace();
  const mip = renderer.getActiveMipmapLevel();
  let fit, checks;
  try {
    // Fit the shared atlas corners and both blend-triangle centroids with alpha-to-coverage.
    fit = await renderViews(grid + cells * 2, 4, (i) => {
      if (i < grid) return frameDirection(layout, frames, i % frames, Math.floor(i / frames));
      const j = i - grid;
      const u = (1 + (j % 2)) / 3;
      return cellView(Math.floor(j / 2), u, 1 - u);
    });
    // Independent quadrant centres also exercise single-sample coverage.
    checks = await renderViews(cells * 4, 0, (i) => cellView(Math.floor(i / 4), (0.5 + (i % 2)) / 2, (0.5 + (Math.floor(i / 2) % 2)) / 2));
  } finally {
    renderer.setRenderTarget(previous, face, mip);
    mesh.dispose();
  }
  const rects = [];
  let trimmed = false;
  for (let cell = 0; cell < cells; cell++) {
    const col = cell % last;
    const row = Math.floor(cell / last);
    const i = row * frames + col;
    const first = grid + cell * 2;
    const training = [i, i + 1, i + frames, i + frames + 1, first, first + 1].map((k) => at(fit, k));
    // frameBasis changes axes at |n.y| = .999. Its pole caps lie within .032 atlas units of the centre or (full layout) a corner.
    const u = (col + 0.5) / last;
    const v = (row + 0.5) / last;
    const reach = 0.5 / last + 0.032;
    const pole = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) <= reach || (layout === "full" && Math.max(Math.min(u, 1 - u), Math.min(v, 1 - v)) <= reach);
    const rect = pole ? FULL : cellRect(training, checks.slice(cell * 4, cell * 4 + 4));
    trimmed ||= rect.some((v, i) => v !== FULL[i]);
    rects.push(...rect);
  }
  return trimmed ? rects : undefined;
}
