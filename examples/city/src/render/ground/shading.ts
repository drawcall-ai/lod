import type { Library } from "../../../public/content/materials.ts";
import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  abs,
  atan,
  clamp,
  cos,
  distance,
  dot,
  float,
  floor,
  fract,
  fwidth,
  ivec2,
  length,
  max,
  mix,
  select,
  sign,
  sin,
  smoothstep,
  step,
  texture,
  uniformArray,
  vec2,
  vec3,
} from "three/tsl";
import { fbm, noise2 } from "../../../public/content/noise.ts";
import type { Zones } from "../../world/zones.ts";
import { Crop, Use } from "../../world/land.ts";
import { BLOCK, ROWS } from "../../../public/content/corn/layout.ts";

/** Distance between corn rows (m); with an even number of rows a block's rows stand half of it off every multiple of it from the centre. */
const ROW = BLOCK / ROWS;

type Node<T extends string> = THREE.Node<T>;

/**
 * `map` at `uv` as given: `sample` applies the texture's repeat (its real-world size, set
 * for the materials that use it, see materials.ts) on top, which these uv already are in,
 * so it is divided out first. The maps set no offset or rotation.
 */
function raw(map: THREE.TextureNode, uv: Node<"vec2">): THREE.TextureNode {
  const { repeat } = map.value;
  return map.sample(uv.div(vec2(repeat.x, repeat.y)));
}

/** The ground's colour at world x/z `xz` seen from `dist` metres away: see `groundShading`. */
export type Ground = (xz: Node<"vec2">, dist: Node<"float">) => Node<"vec3">;

/** The shader twin of `forestEdge` (world/zones.ts). */
function forestEdge(radius: Node<"float">, a: Node<"float">, phase: Node<"float">): Node<"float"> {
  const stretch = cos(a.sub(phase).mul(2)).mul(0.28).add(1);
  const lobes = sin(a.mul(3).add(phase))
    .mul(0.16)
    .add(sin(a.mul(5).add(phase.mul(2.3))).mul(0.09))
    .add(sin(a.mul(11).add(phase.mul(3))).mul(0.05))
    .add(sin(a.mul(23).add(phase.mul(5))).mul(0.025));
  return radius.mul(stretch).mul(lobes.add(1));
}

/** The shader twin of the clearings of `forestClearings` (world/zones.ts): 1 in a clearing. */
function clearing(d: Node<"vec2">, radius: Node<"float">, phase: Node<"float">): Node<"float"> {
  let open: Node<"float"> = float(0);
  [1, 3.7].forEach((turn, k) => {
    const a = phase.add(turn);
    const c = vec2(cos(a), sin(a)).mul(radius.mul(0.35 + 0.15 * k));
    open = max(open, smoothstep(-6, 4, length(d.sub(c)).sub(radius.mul(0.12 + 0.06 * k))).oneMinus());
  });
  return open;
}

/** How far beyond its edge a field shows: its margin noise moves the edge by up to 0.75 m, the fade reaches 1.5 m past that. */
const FIELD_MARGIN = 2.25;

const grey = (c: Node<"vec3">, weights: [number, number, number]) => dot(c, vec3(...weights));

/**
 * The ground's colour, in the shaders that draw it: the terrain, and grass
 * that takes the colour of the ground it grows from, so where the blades thin out into
 * the terrain nothing changes colour. Close up it shows the lawn texture at two scales;
 * with distance it fades to an aerial texture, colour-matched to the lawn so the hand-over
 * is invisible. Over everything, large-scale noise paints lush, dry and dark patches and
 * bare soil, so no repeat survives at any height. Fields are bare soil furrowed along
 * their x axis (the corn rows, 0.75 m apart); forests have a floor of dark litter;
 * farmland parcels show their crops, and town lawns are mown in stripes.
 * An explicit `footprint` replaces pixel derivatives for a vertex evaluation.
 */
export function groundShading(library: Library, zones: Zones, footprint?: Node<"float">): Ground {
  // the maps once each: every read of one is a sample of the same binding
  const lawnMap = texture(library.texture("Grass001", "diff"));
  const aerialMap = texture(library.texture("aerial_grass_rock", "diff"));
  const soilMap = texture(library.texture("farm_soil", "diff"));
  const top = float(12);
  // arrays cannot be empty: pad with zones far outside the world
  const fields = zones.fields.length > 0 ? zones.fields : [{ x: 1e7, z: 1e7, halfX: 1, halfZ: 1, angle: 0 }];
  const forests = zones.forests.length > 0 ? zones.forests : [{ x: 1e7, z: 1e7, radius: 1, phase: 0 }];
  const fieldBoxes = uniformArray<"vec4">(
    fields.map((f) => new THREE.Vector4(f.x, f.z, f.halfX, f.halfZ)),
    "vec4",
  ).setName("groundFieldBoxes");
  const fieldAxes = uniformArray<"vec2">(
    fields.map((f) => new THREE.Vector2(Math.cos(f.angle), Math.sin(f.angle))),
    "vec2",
  ).setName("groundFieldAxes");
  const woods = uniformArray<"vec4">(
    forests.map((f) => new THREE.Vector4(f.x, f.z, f.radius, f.phase)),
    "vec4",
  ).setName("groundWoods");
  // a box around the fields and their margins: elsewhere the shader skips them
  const fieldsLo = new THREE.Vector2(Infinity, Infinity);
  const fieldsHi = new THREE.Vector2(-Infinity, -Infinity);
  for (const f of fields) {
    const c = Math.abs(Math.cos(f.angle));
    const s = Math.abs(Math.sin(f.angle));
    const reach = new THREE.Vector2(c * f.halfX + s * f.halfZ, s * f.halfX + c * f.halfZ).addScalar(FIELD_MARGIN);
    fieldsLo.min(new THREE.Vector2(f.x, f.z).sub(reach));
    fieldsHi.max(new THREE.Vector2(f.x, f.z).add(reach));
  }

  const shade = Fn(
    ([xz, dist]: [Node<"vec2">, Node<"float">]) => {
      // several scales of each texture, rotated and blended by noise, break up the repeats
      const turn = vec2(xz.x.mul(0.8).add(xz.y.mul(0.6)), xz.x.mul(-0.6).add(xz.y.mul(0.8)));
      const turn2 = vec2(xz.x.mul(0.28).sub(xz.y.mul(0.96)), xz.x.mul(0.96).add(xz.y.mul(0.28)));
      // the top mip level is the mean
      const lawnMean = raw(lawnMap, vec2(0.5)).level(top).rgb.toVar();
      const aerialMean = raw(aerialMap, vec2(0.5)).level(top).rgb.toVar();
      const fine = raw(lawnMap, xz.div(1.2)).rgb.toVar();
      const lawn = mix(fine, raw(lawnMap, turn.div(9.1)).rgb, 0.35);
      // the 15 m repeat still reads as a pattern from a few hundred metres up: fade it to its mean
      const a1 = mix(raw(aerialMap, xz.div(15)).rgb, aerialMean, smoothstep(200, 600, dist));
      const a2 = raw(aerialMap, turn.div(47).add(0.37)).rgb;
      const a3 = raw(aerialMap, turn2.div(131).add(0.71)).rgb;
      const aerial = mix(mix(a1, a2, noise2(xz.div(70).add(71)).mul(0.4).add(0.3)), a3, noise2(xz.div(160).add(13)).mul(0.4).add(0.2))
        // match the aerial texture's mean colour to the lawn's
        .mul(lawnMean.div(max(aerialMean, vec3(0.01))));
      const mixed = mix(lawn, aerial, smoothstep(25, 220, dist));
      // the lawn photo is greener than unkempt ground: pull it toward grey-olive
      const olive = mix(vec3(grey(mixed, [0.3, 0.59, 0.11])).mul(vec3(1.05, 1, 0.8)), mixed, 0.55);
      const land = fbm(xz.div(900).add(3));
      const macro = fbm(xz.div(260)).toVar();
      const meso = fbm(xz.div(37).add(5)).toVar();
      const patched = olive
        .mul(mix(vec3(0.7, 0.92, 0.62), vec3(1.25, 1.08, 0.7), smoothstep(0.25, 0.75, macro)))
        .mul(mix(0.75, 1.2, smoothstep(0.3, 0.7, land)))
        .mul(meso.mul(0.56).add(0.72));
      // worn, bare ground in a few dry places (only where macro passes 0.55): soil darkened and
      // greyed toward the lawn's tone
      const bare = float(0).toVar();
      If(macro.greaterThan(0.55), () => {
        bare.assign(smoothstep(0.7, 0.78, fbm(xz.div(55).add(31))).mul(smoothstep(0.55, 0.75, macro)));
      });
      const soil = raw(soilMap, xz.div(2)).rgb.toVar();
      const earth = mix(vec3(grey(soil, [0.3, 0.55, 0.15])), soil, 0.6)
        .mul(0.85)
        .toVar();
      const c = mix(patched, earth, bare.mul(0.85)).toVar();

      // forest floor: dark leaf litter with moss, out to the forest's wavy edge (forestEdge)
      const wood = float(0).toVar();
      Loop(forests.length, ({ i }) => {
        const f = woods.element(i);
        const d = xz.sub(f.xy).toVar();
        const r = length(d).toVar();
        // the edge reaches at most 1.7 radii out (forestEdge), the fray and the fade 8 m beyond
        If(r.lessThan(f.z.mul(1.7).add(8)), () => {
          const fray = noise2(xz.div(9)).sub(0.5).mul(8);
          const edge = forestEdge(f.z, atan(d.y, d.x), f.w);
          wood.assign(
            max(
              wood,
              smoothstep(-10, 4, r.sub(edge).add(fray))
                .oneMinus()
                .mul(clearing(d, f.z, f.w).oneMinus()),
            ),
          );
        });
      });
      If(wood.greaterThan(0), () => {
        c.assign(mix(c, mix(earth.mul(vec3(0.55, 0.45, 0.35)), c.mul(0.45), noise2(xz.div(6)).mul(0.4).add(0.35)), wood));
      });

      // fields: ploughed soil in ridges along the rows, a little weed at the margins
      const nearFields = xz
        .greaterThan(vec2(fieldsLo.x, fieldsLo.y))
        .all()
        .and(xz.lessThan(vec2(fieldsHi.x, fieldsHi.y)).all());
      If(nearFields, () => {
        Loop(fields.length, ({ i }) => {
          const box = fieldBoxes.element(i);
          const axis = fieldAxes.element(i);
          const d = xz.sub(box.xy);
          const local = vec2(dot(d, axis), dot(d, vec2(axis.y.negate(), axis.x))).toVar();
          const outside = abs(local).sub(box.zw);
          const out = max(outside.x, outside.y).toVar();
          If(out.lessThan(FIELD_MARGIN), () => {
            const margin = noise2(xz.mul(0.4)).sub(0.5).mul(1.5);
            const inside = smoothstep(-0.5, 1.5, out.add(margin)).oneMinus();
            const ridge = cos(local.y.sub(ROW / 2).mul((2 * Math.PI) / ROW))
              .mul(0.5)
              .add(0.5);
            const field = soil
              .mul(
                ridge
                  .mul(0.3)
                  .mul(smoothstep(30, 120, dist).oneMinus())
                  .add(0.62),
              )
              .mul(meso.mul(0.3).add(0.85));
            c.assign(mix(c, field, inside));
          });
        });
      });
      if (zones.parcels) parcels(zones, zones.parcels, { xz, dist, c, soil, fine, soilMap, lawnMean, top, footprint });
      return c;
    },
    // no function of its own (layout): three declares no textures read in one
  );
  return (xz, dist) => shade(xz, dist);
}

interface Painting {
  xz: Node<"vec2">;
  dist: Node<"float">;
  /** the colour so far, painted over */
  c: Node<"vec3">;
  soil: Node<"vec3">;
  /** the lawn map at its own scale */
  fine: Node<"vec3">;
  soilMap: THREE.TextureNode;
  lawnMean: Node<"vec3">;
  top: Node<"float">;
  footprint?: Node<"float">;
}

/** Paints the farmland parcels and the town's mown lawns over `c` (see `Zones`). */
function parcels(zones: Zones, { texture: cells, extent }: NonNullable<Zones["parcels"]>, p: Painting): void {
  const { xz, dist, c, soil, fine, soilMap, lawnMean, top, footprint } = p;
  const map = texture(cells);
  const size = cells.image.width;
  // the cells, looked up through a little noise so their edges do not step
  const jitter = vec2(noise2(xz.mul(0.35)), noise2(xz.mul(0.35).add(17)))
    .sub(0.5)
    .mul(2.5);
  const at = clamp(
    floor(
      xz
        .add(jitter)
        .add(extent)
        .div(2 * extent)
        .mul(size),
    ),
    0,
    size - 1,
  ).toVar();
  const cell = (dx: number, dy: number) => map.load(ivec2(clamp(at.add(vec2(dx, dy)), 0, size - 1)));
  const own = cell(0, 0).toVar();
  const crop = floor(own.r.mul(255).add(0.5)).toVar();
  const use = floor(own.a.mul(255).add(0.5));
  const { town } = zones;
  if (town) {
    // garden lawns, mown in light and dark stripes along the street grid
    const lawn = crop
      .equal(Crop.None)
      .and(use.equal(Use.Lawn))
      .and(distance(xz, vec2(town.x, town.z)).lessThan(town.radius));
    If(lawn, () => {
      const stripe = sign(sin(dot(xz, vec2(Math.cos(town.angle), Math.sin(town.angle))).mul(Math.PI / 0.8)));
      c.mulAssign(
        stripe
          .mul(0.035)
          .mul(smoothstep(30, 90, dist).oneMinus())
          .add(1),
      );
    });
  }
  If(crop.greaterThanEqual(Crop.Pasture), () => {
    // a grass margin where the next cell over holds another crop
    let margin: Node<"float"> = float(0);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const next = cell(dx, dy).r;
      margin = max(margin, step(0.5 / 255, abs(next.sub(own.r))).mul(step(0.5 / 255, abs(next))));
    }
    const tint = own.g;
    const angle = own.b.mul(Math.PI);
    const across = dot(xz, vec2(sin(angle).negate(), cos(angle))).toVar();
    const near = smoothstep(40, 160, dist).oneMinus();
    const grass = grey(fine, [0.3, 0.59, 0.11]).div(max(grey(lawnMean, [0.3, 0.59, 0.11]), 0.01));
    const detail = mix(1, grass, near.mul(0.6)).toVar();
    const patchy = noise2(xz.div(30).add(tint.mul(40)))
      .mul(0.3)
      .add(0.85)
      .toVar();
    // tractor tramlines, 20 m apart, two wheel tracks each
    const lane = abs(fract(across.div(20)).sub(0.5)).mul(20);
    // once a pixel spans more than the tracks are wide they alias into rows of dots: blend
    // them to their share of the ground, a few percent
    const tracks = mix(smoothstep(0.15, 0.3, abs(lane.sub(0.9))).oneMinus(), 0.03, smoothstep(0.08, 0.4, footprint ?? fwidth(across)));
    const earth = soil.mul(0.55);
    const pasture = c.mul(vec3(1, 1.2, 0.78)).mul(tint.mul(0.3).add(1.1));
    const wheat = mix(vec3(0.36, 0.27, 0.1), vec3(0.47, 0.37, 0.15), tint)
      .mul(patchy)
      .mul(detail);
    const rapeseed = mix(vec3(0.52, 0.42, 0.02), vec3(0.2, 0.3, 0.05), tint.mul(0.2).add(0.25))
      .mul(patchy)
      .mul(detail);
    // ploughed: earth brown, the soil texture's grain in it, furrows across the near ground
    const grain = grey(soil, [0.3, 0.55, 0.15]).div(max(grey(raw(soilMap, vec2(0.5)).level(top).rgb, [0.3, 0.55, 0.15]), 0.01));
    const dirt = vec3(0.26, 0.18, 0.11).mul(tint.mul(0.4).add(0.8)).mul(grain.mul(0.6).add(0.7));
    const furrows = cos(across.mul((2 * Math.PI) / 0.35))
      .mul(0.5)
      .add(0.5)
      .mul(0.3)
      .mul(near)
      .add(0.8);
    const ploughed = dirt
      .mul(furrows)
      .mul(patchy)
      .mul(mix(1, detail, 0.5));
    // stubble: pale straw over soil, in soft swaths where the harvester went
    const swath = sin(across.mul((2 * Math.PI) / 6).add(noise2(xz.div(20)).mul(3)))
      .mul(0.5)
      .add(0.5);
    const stubble = mix(vec3(0.42, 0.36, 0.22), earth, swath.mul(0.15).add(0.25))
      .mul(swath.mul(0.08).add(0.92))
      .mul(patchy)
      .mul(detail);
    const grown = select(crop.equal(Crop.Wheat), wheat, rapeseed);
    const crops = select(
      crop.equal(Crop.Pasture),
      pasture,
      select(crop.lessThanEqual(Crop.Rapeseed), mix(grown, earth, tracks.mul(0.8)), select(crop.equal(Crop.Ploughed), ploughed, stubble)),
    );
    c.assign(mix(crops, c, margin.mul(0.8)));
  });
}
