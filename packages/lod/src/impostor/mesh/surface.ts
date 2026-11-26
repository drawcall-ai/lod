import type { Node, Texture } from "three/webgpu";
import {
  abs,
  cameraProjectionMatrix,
  cameraViewMatrix,
  ceil,
  clamp,
  Discard,
  dFdx,
  dFdy,
  dot,
  exp2,
  float,
  floor,
  fract,
  fwidth,
  length,
  log2,
  max,
  min,
  mix,
  normalize,
  positionViewDirection,
  screenCoordinate,
  select,
  sin,
  sqrt,
  step,
  texture,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { dither, keepsPixel } from "../../levels/fade.js";
import type { Card } from "./card.js";

// The impostor's surface: where the view ray meets the object, blended from the three
// frames around the view direction, and what the pixel shows of it.

/** What the surface of one impostor reads besides its card. */
export interface SurfaceInputs {
  radius: Node<"float">;
  halfSize: Node<"float">;
  frames: Node<"float">;
  /** atlas texels per frame side */
  cell: number;
  maps: { base: Texture; normalDepth: Texture; orm: Texture; emissive: Texture | null };
  /** coverage below which a pixel is empty */
  cutoff: number;
  /** depth disagreement at which a frame's sample counts half in the blend */
  tolerance: number;
  /** mip bias of every atlas read */
  mipBias: Node<"float">;
}

/** How a pass draws the surface. */
interface Pass {
  /** depth-parallax refinements per frame; 0 for none */
  parallax: number;
  /** whether the target is multisampled: coverage then goes to alpha-to-coverage */
  multisampled: boolean;
  /** whether to read the maps that only lighting needs */
  lit: boolean;
}

export interface Surface {
  /** colour and screen coverage */
  color: Node<"vec4">;
  /** whether the pixel is drawn: covered, and this draw's by its fade */
  drawn: Node<"bool">;
  /** Resolve depth only when a depth output or shadow lookup needs it. */
  resolve(): {
    depth: Node<"float">;
    /** the surface, stopped short toward the camera by a depth step */
    shadowPosition: Node<"vec3">;
  };
  /** Build lighting after the coverage mask; null in shadow passes. */
  light: (() => Lighting) | null;
}

export interface Lighting {
  /** unit view-space normal to shade with */
  normal: Node<"vec3">;
  /** the normals' mean direction, on `normal`'s side but not leaned, × how far they agree: see `cosine` */
  spread: Node<"vec3">;
  roughness: Node<"float">;
  metalness: Node<"float">;
  occlusion: Node<"float">;
  emissive: Node<"vec3"> | null;
}

export function buildSurface(inputs: SurfaceInputs, card: Card, pass: Pass): Surface {
  const { radius, halfSize, frames, cell, maps, cutoff, tolerance, mipBias } = inputs;
  const [a, b, c] = card.views;
  // The bake frame is orthonormal, so every view has the same ray length. Keep the
  // intersection in units of the original ray for both perspective and orthographic depth.
  const rayLength = length(a.ray.xyz).toVar();
  const plane = ({ origin, ray, frame, weight }: Card["views"][number]) => {
    const along = min(ray.z, rayLength.mul(-1e-3)).toVar();
    const t = origin.z.negate().div(along).toVar();
    const uv = origin.xy.add(ray.xy.mul(t)).div(halfSize.mul(2)).add(0.5).toVar();
    const slope = ray.xy.div(along.mul(halfSize.mul(2)));
    return { frame, weight, uv, slope, t, along };
  };
  const first = plane(a);

  // All maps use the same isotropic mip from the flat projection. Parallax shifts UVs
  // across depth edges, where their derivatives would select too coarse a mip.
  const dx = dFdx(first.uv);
  const dy = dFdy(first.uv);
  const texels = max(length(dx), length(dy)).mul(cell).toVar();
  const mip = min(log2(max(texels.mul(exp2(mipBias)), 1)), Math.log2(cell)).toVar();
  // Half a texel of the coarser mip in the trilinear blend keeps every read inside its frame.
  const inset = exp2(ceil(mip))
    .mul(0.5 / cell)
    .toVar();
  const read = (map: Texture, uv: Node<"vec2">) => texture(map, uv).level(mip);
  const atlas = (frame: Node<"vec2">, uv: Node<"vec2">) => frame.add(clamp(uv, inset, inset.oneMinus())).div(frames);
  const inside = (uv: Node<"vec2">) => step(0, uv.x).mul(step(0, uv.y)).mul(step(uv.x, 1)).mul(step(uv.y, 1));

  // Frame-local uv where the view ray meets the baked surface, its normal-depth texel
  // there, and "run", the distance along the ray to it. "trust" falls toward 0 when the
  // depth walk did not settle: the frame's surface there is not on this ray (the frame
  // sees something the camera does not), and blending it in would ghost.
  const resolveFrame = (p: ReturnType<typeof plane>) => {
    const { frame } = p;
    let uv: Node<"vec2"> = p.uv;
    let previous: Node<"float"> | undefined;
    for (let k = 0; k < pass.parallax; k++) {
      previous = read(maps.normalDepth, atlas(frame, uv)).a.toVar();
      uv = p.uv.add(p.slope.mul(previous.sub(0.5).mul(radius.mul(2)))).toVar();
    }
    const at = atlas(frame, uv).toVar();
    let texel: Node<"vec4"> | undefined;
    const sample = () => (texel ??= read(maps.normalDepth, at).toVar());
    const trust = () => {
      if (!previous) return float(1);
      const miss = abs(sample().a.sub(previous)).div(tolerance);
      return float(1).div(miss.mul(miss).add(1));
    };
    const run = () => p.t.add(sample().a.sub(0.5).mul(radius.mul(2)).div(p.along));
    return { at, sample, trust, run, inside: inside(uv), weight: p.weight };
  };
  const r0 = resolveFrame(first);
  const r1 = resolveFrame(plane(b));
  const r2 = resolveFrame(plane(c));

  // Every layer is weighted by barycentric weight × trust × that frame's coverage, so a
  // frame that does not cover this pixel cannot bleed its colour, normal or depth into it.
  const c0 = read(maps.base, r0.at).toVar();
  const c1 = read(maps.base, r1.at).toVar();
  const c2 = read(maps.base, r2.at).toVar();
  const minified = clamp(texels.sub(1), 0, 1);
  const grain = dither(screenCoordinate.xy.add(17));
  const threshold = mix(float(cutoff), grain, minified);
  // The final coverage is a weighted average of the three alphas. Even their
  // maximum cannot pass here, so skip the last depth read in each parallax walk.
  if (pass.lit && !pass.multisampled && pass.parallax > 0) Discard(max(c0.a, max(c1.a, c2.a)).add(1e-6).lessThan(threshold));
  const trusted = vec3(r0.weight.mul(r0.trust()), r1.weight.mul(r1.trust()), r2.weight.mul(r2.trust()));
  const covered = trusted
    .mul(vec3(r0.inside, r1.inside, r2.inside))
    .mul(vec3(c0.a, c1.a, c2.a))
    .div(max(trusted.x.add(trusted.y).add(trusted.z), 1e-4));
  const cover = covered.x.add(covered.y).add(covered.z).toVar();
  const w = covered.div(max(cover, 1e-4)).toVar();
  const blend = (a: Node<"vec4">, b: Node<"vec4">, c: Node<"vec4">) => a.mul(w.x).add(b.mul(w.y)).add(c.mul(w.z));
  const rgb = blend(c0, c1, c2).rgb;

  // Baked coverage to screen coverage. Magnified (a texel spans pixels), the edge is
  // sharpened around the cutoff, centred on it. Minified, a texel already holds a pixel's
  // worth of supersampled coverage, so it is kept and dithered: both alpha-to-coverage and
  // a plain cutoff round fractional coverage away, erasing branches, wires and sparse
  // foliage in the distance.
  let alpha: Node<"float">;
  let covers: Node<"bool">;
  if (pass.multisampled) {
    const sharp = clamp(
      cover
        .sub(cutoff)
        .div(max(fwidth(cover), 1e-4))
        .add(0.5),
      0,
      1,
    );
    // Dither by one sample step (4x MSAA), faded out toward 0 and 1 so empty stays empty
    // and solid stays solid. Hardware alpha-to-coverage rounds to a sample count, some
    // GPUs down, some to nearest; offsetting the noise by a quarter step keeps either
    // within 1/8 sample, where centred noise loses coverage.
    const dithered = clamp(
      cover.add(
        grain
          .sub(0.25)
          .mul(0.25)
          .mul(min(min(cover, cover.oneMinus()).mul(4), 1)),
      ),
      0,
      1,
    );
    alpha = mix(sharp, dithered, minified).toVar();
    covers = alpha.greaterThan(0);
  } else {
    alpha = float(1);
    covers = cover.greaterThanEqual(threshold);
  }

  let point: ReturnType<Surface["resolve"]> | undefined;
  const resolve = () => {
    if (point) return point;
    const s = dot(vec3(r0.run(), r1.run(), r2.run()), w).toVar();
    const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(card.worldPoint.add(card.worldRay.mul(s)), 1));
    // Stop short toward the camera by a texel and depth step: the light's and the camera's frames
    // resolve slightly different surfaces, otherwise the receiver shades itself.
    const short = s.sub(
      halfSize
        .mul(2 / cell)
        .add(radius.mul(2 / 255))
        .div(rayLength),
    );
    point = { depth: clip.z.div(clip.w), shadowPosition: card.worldPoint.add(card.worldRay.mul(short)) };
    return point;
  };

  let lighting: Lighting | undefined;
  const light = (): Lighting => {
    if (lighting) return lighting;
    const normal = (texel: Node<"vec4">) => texel.rgb.mul(2).sub(1);
    const mean = normal(r0.sample()).mul(w.x).add(normal(r1.sample()).mul(w.y)).add(normal(r2.sample()).mul(w.z)).toVar();
    const orm = blend(read(maps.orm, r0.at), read(maps.orm, r1.at), read(maps.orm, r2.at)).toVar();
    // How far the normals agree, kept above 0 for what divides by it.
    const agreed = clamp(length(mean), 1e-3, 1).toVar();
    // Toksvig: the spread of the averaged normal widens the specular lobe, so distant
    // foliage and bumpy rock stop sparkling.
    const roughness = sqrt(min(orm.g.mul(orm.g).add(agreed.oneMinus().div(agreed)), 1));
    // orm.a is the share shading with the normal rather than its opposite. Pick one
    // per texel of the strongest frame's mip, fixed on the object as leaves are.
    const strong = select(w.x.greaterThanEqual(max(w.y, w.z)), r0.at, select(w.y.greaterThanEqual(w.z), r1.at, r2.at));
    const level = exp2(ceil(max(log2(max(texels, 1e-4)), 0)));
    const texel = floor(strong.mul(cell).mul(frames).div(level));
    const random = fract(sin(dot(texel, vec2(12.9898, 78.233))).mul(43758.5453));
    const side = select(random.lessThan(orm.a), float(1), float(-1));
    const spread: Node<"vec3"> = card.toView(mean).mul(side).mul(agreed).toVar();
    // Lean the shading normal toward the view by what unit normals agreeing this little have beside their mean. A heuristic,
    // not their visible mean, whose lean grows with the view angle: what it fixes is the mean of grass pointing up, into
    // glare from a low sun ahead.
    const leaned = normalize(spread.add(positionViewDirection.mul(sqrt(agreed.mul(agreed).oneMinus()))));
    const emissive = maps.emissive ? blend(read(maps.emissive, r0.at), read(maps.emissive, r1.at), read(maps.emissive, r2.at)).rgb : null;
    lighting = { normal: leaned, spread, roughness, metalness: orm.b, occlusion: orm.r, emissive };
    return lighting;
  };
  return {
    color: vec4(rgb, alpha),
    drawn: covers.and(keepsPixel()),
    resolve,
    light: pass.lit ? light : null,
  };
}

/**
 * The mean of saturate(dot(n, direction)) over the normals an averaged `normal` stands
 * for, whose length is how far they agree. Fitted to normals spread over the half of the
 * sphere that faces the camera (all a view shows of a surface), within 0.01: exact for
 * light along the mean and at length 1, where it is the clamped cosine.
 */
export function cosine(normal: Node<"vec3">, direction: Node<"vec3">): Node<"float"> {
  const along = dot(normal, direction);
  const agree = dot(normal, normal);
  return along
    .add(
      sqrt(
        along.mul(along).add(
          agree
            .oneMinus()
            .mul(along.mul(along).div(max(agree, 1e-8)).oneMinus())
            .div(3),
        ),
      ),
    )
    .mul(0.5);
}
