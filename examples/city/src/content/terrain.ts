import * as THREE from "three";
import { noise } from "./glsl.ts";
import { once, texture } from "./materials.ts";

/** Ground that is not lawn: corn fields (rotated rectangles), forest floor (round patches), farmland parcels. */
export interface Zones {
  /** Centre x, z, half size along the field's own x and z, and its turn about y (radians). */
  fields: { x: number; z: number; halfX: number; halfZ: number; angle: number }[];
  /** Centre x, z, radius and the phase of its ragged edge and clearings, see `forestEdge`. */
  forests: { x: number; z: number; radius: number; phase: number }[];
  /**
   * Farmland parcels over the square ±`extent`, one texel per cell: RGBA8 = crop (1 pasture,
   * 2 wheat, 3 rapeseed, 4 ploughed, 5 stubble, 0 none), the parcel's tint, its row
   * direction (over half a turn), the cell's use (unused here). Null for none.
   */
  parcels: { texture: THREE.Texture; extent: number } | null;
  /** The town, whose lawns (lawn cells within `radius`) are mown in stripes along its grid (`angle`). */
  town: { x: number; z: number; radius: number; angle: number } | null;
}

/**
 * How far from its centre a forest of `radius` reaches in the direction `angle` (radians,
 * atan2(z, x)): stretched one way, lobed and ragged. The terrain shader repeats this
 * formula (FOREST_GLSL): placement and ground agree.
 */
export function forestEdge(radius: number, angle: number, phase: number): number {
  const stretch = 1 + 0.28 * Math.cos(2 * (angle - phase));
  const lobes =
    0.16 * Math.sin(3 * angle + phase) +
    0.09 * Math.sin(5 * angle + 2.3 * phase) +
    0.05 * Math.sin(11 * angle + 3 * phase) +
    0.025 * Math.sin(23 * angle + 5 * phase);
  return radius * stretch * (1 + lobes);
}

/** The forest's two clearings: centre x, z (relative to the forest's centre) and radius. */
export function forestClearings(radius: number, phase: number): { x: number; z: number; radius: number }[] {
  return [phase + 1, phase + 3.7].map((a, k) => ({
    x: Math.cos(a) * radius * (0.35 + 0.15 * k),
    z: Math.sin(a) * radius * (0.35 + 0.15 * k),
    radius: radius * (0.12 + 0.06 * k),
  }));
}

/** GLSL twins of `forestEdge` and the clearing test (in a clearing: 1). */
const FOREST_GLSL = /* glsl */ `
  float cityForestEdge(float radius, float a, float phase) {
    float stretch = 1.0 + 0.28 * cos(2.0 * (a - phase));
    float lobes = 0.16 * sin(3.0 * a + phase) + 0.09 * sin(5.0 * a + 2.3 * phase) + 0.05 * sin(11.0 * a + 3.0 * phase) + 0.025 * sin(23.0 * a + 5.0 * phase);
    return radius * stretch * (1.0 + lobes);
  }
  float cityClearing(vec2 d, float radius, float phase) {
    float open = 0.0;
    for (int k = 0; k < 2; k++) {
      float a = phase + (k == 0 ? 1.0 : 3.7);
      vec2 c = vec2(cos(a), sin(a)) * radius * (0.35 + 0.15 * float(k));
      open = max(open, 1.0 - smoothstep(-6.0, 4.0, length(d - c) - radius * (0.12 + 0.06 * float(k))));
    }
    return open;
  }
`;

/** The lawn everywhere, for the content viewer. */
export const terrain = once(() => terrainMaterial({ fields: [], forests: [], parcels: null, town: null }));

/**
 * Ground for anything from a few metres to a few kilometres away, on a mesh whose UVs are
 * world x/z in metres. Close up it shows the lawn texture at two scales; with distance it
 * fades to an aerial texture, colour-matched to the lawn so the hand-over is invisible.
 * Over everything, large-scale noise paints lush, dry and dark patches and bare soil, so
 * no repeat survives at any height. Fields are bare soil furrowed along their x axis
 * (the corn rows, 0.75 m apart); forests have a floor of dark litter.
 */
export function terrainMaterial(zones: Zones): THREE.MeshStandardMaterial {
  const lawn = "Grass001";
  const m = new THREE.MeshStandardMaterial({
    name: "terrain",
    normalMap: texture(lawn, "nor"),
    // fully rough: the photo's roughness lets a low sun glare off the lawn like wet tarmac
    roughness: 1,
    aoMap: texture(lawn, "arm"),
    metalness: 0,
  });
  const ground = groundShading(zones);
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, ground.uniforms);
    shader.vertexShader = `varying vec3 vTerrainPos;\n${shader.vertexShader}`.replace(
      "#include <worldpos_vertex>",
      "#include <worldpos_vertex>\nvTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
    );
    shader.fragmentShader = `varying vec3 vTerrainPos;\n${ground.glsl}\n${shader.fragmentShader}`.replace(
      "#include <map_fragment>",
      "diffuseColor.rgb *= cityGround(vTerrainPos.xz, distance(cameraPosition, vTerrainPos));",
    );
  };
  m.customProgramCacheKey = () => ground.key;
  return m;
}

/**
 * The ground's colour as a GLSL function, `vec3 cityGround(vec2 xz, float dist)` (world
 * x/z and distance from the eye), with the uniforms it reads: the terrain draws with it,
 * and grass takes the colour of the ground it grows from, so where the blades thin out
 * into the terrain nothing changes colour.
 */
export function groundShading(zones: Zones): { uniforms: Record<string, { value: unknown }>; glsl: string; key: string } {
  const lawn = "Grass001";
  const aerial = "aerial_grass_rock";
  const soil = "farm_soil";
  // GLSL arrays cannot be empty: pad with zones far outside the world
  const fields = zones.fields.map((f) => new THREE.Vector4(f.x, f.z, f.halfX, f.halfZ));
  const angles = zones.fields.map((f) => new THREE.Vector2(Math.cos(f.angle), Math.sin(f.angle)));
  const forests = zones.forests.map((f) => new THREE.Vector4(f.x, f.z, f.radius, f.phase));
  if (fields.length === 0) {
    fields.push(new THREE.Vector4(1e7, 1e7, 1, 1));
    angles.push(new THREE.Vector2(1, 0));
  }
  if (forests.length === 0) forests.push(new THREE.Vector4(1e7, 1e7, 1, 0));
  // loaded now, not at the first compile, so waiting for downloads covers them
  const uniforms = {
    lawnMap: { value: texture(lawn, "diff") },
    aerialMap: { value: texture(aerial, "diff") },
    soilMap: { value: texture(soil, "diff") },
    parcels: { value: zones.parcels?.texture ?? null },
    fields: { value: fields },
    fieldAxes: { value: angles },
    forests: { value: forests },
  };
  const glsl = /* glsl */ `
    uniform sampler2D lawnMap;
    uniform sampler2D aerialMap;
    uniform sampler2D soilMap;
    uniform vec4 fields[${fields.length}];
    uniform vec2 fieldAxes[${fields.length}];
    uniform vec4 forests[${forests.length}];
    ${zones.town ? `#define CITY_TOWN\nconst vec4 TOWN = vec4(${[zones.town.x, zones.town.z, zones.town.radius, zones.town.angle].map((v) => v.toFixed(3)).join(", ")});` : ""}
    ${zones.parcels ? `#define CITY_PARCELS\nuniform sampler2D parcels;\nconst float PARCEL_EXTENT = ${zones.parcels.extent.toFixed(1)};` : ""}
    ${noise}
    ${FOREST_GLSL}
    vec3 cityGround(vec2 xz, float dist) {
        // several scales of each texture, rotated and blended by noise, break up the repeats
        mat2 turn = mat2(0.8, -0.6, 0.6, 0.8);
        mat2 turn2 = mat2(0.28, 0.96, -0.96, 0.28);
        vec3 lawnMean = textureLod(lawnMap, vec2(0.5), 12.0).rgb;
        vec3 aerialMean = textureLod(aerialMap, vec2(0.5), 12.0).rgb;
        vec3 lawn = mix(texture2D(lawnMap, xz / 1.2).rgb, texture2D(lawnMap, turn * xz / 9.1).rgb, 0.35);
        // the 15 m repeat still reads as a pattern from a few hundred metres up: fade it to its mean
        vec3 a1 = mix(texture2D(aerialMap, xz / 15.0).rgb, aerialMean, smoothstep(200.0, 600.0, dist));
        vec3 a2 = texture2D(aerialMap, turn * xz / 47.0 + 0.37).rgb;
        vec3 a3 = texture2D(aerialMap, turn2 * xz / 131.0 + 0.71).rgb;
        vec3 aerial = mix(mix(a1, a2, 0.3 + 0.4 * cityNoise2(xz / 70.0 + 71.0)), a3, 0.2 + 0.4 * cityNoise2(xz / 160.0 + 13.0));
        // match the aerial texture's mean colour to the lawn's (the top mip level is the mean)
        aerial *= lawnMean / max(aerialMean, vec3(0.01));
        vec3 c = mix(lawn, aerial, smoothstep(25.0, 220.0, dist));
        // the lawn photo is greener than unkempt ground: pull it toward grey-olive
        c = mix(vec3(dot(c, vec3(0.3, 0.59, 0.11))) * vec3(1.05, 1.0, 0.8), c, 0.55);
        float land = cityFbm(xz / 900.0 + 3.0);
        float macro = cityFbm(xz / 260.0);
        float meso = cityFbm(xz / 37.0 + 5.0);
        c *= mix(vec3(0.7, 0.92, 0.62), vec3(1.25, 1.08, 0.7), smoothstep(0.25, 0.75, macro));
        c *= mix(0.75, 1.2, smoothstep(0.3, 0.7, land));
        c *= 0.72 + 0.56 * meso;
        // worn, bare ground in a few dry places: soil darkened and greyed toward the lawn's tone
        float bare = smoothstep(0.7, 0.78, cityFbm(xz / 55.0 + 31.0)) * smoothstep(0.55, 0.75, macro);
        vec3 soil = texture2D(soilMap, xz / 2.0).rgb;
        vec3 earth = mix(vec3(dot(soil, vec3(0.3, 0.55, 0.15))), soil, 0.6) * 0.85;
        c = mix(c, earth, bare * 0.85);
        // forest floor: dark leaf litter with moss, out to the forest's wavy edge (forestEdge)
        float fray = (cityNoise2(xz / 9.0) - 0.5) * 8.0;
        float wood = 0.0;
        for (int i = 0; i < ${forests.length}; i++) {
          vec2 d = xz - forests[i].xy;
          float a = atan(d.y, d.x);
          float edge = cityForestEdge(forests[i].z, a, forests[i].w);
          wood = max(wood, (1.0 - smoothstep(-10.0, 4.0, length(d) - edge + fray)) * (1.0 - cityClearing(d, forests[i].z, forests[i].w)));
        }
        if (wood > 0.0) c = mix(c, mix(earth * vec3(0.55, 0.45, 0.35), c * 0.45, 0.35 + 0.4 * cityNoise2(xz / 6.0)), wood);
        // fields: ploughed soil in ridges along the rows, a little weed at the margins
        float margin = (cityNoise2(xz * 0.4) - 0.5) * 1.5;
        for (int i = 0; i < ${fields.length}; i++) {
          vec2 d = xz - fields[i].xy;
          vec2 local = vec2(dot(d, fieldAxes[i]), dot(d, vec2(-fieldAxes[i].y, fieldAxes[i].x)));
          vec2 outside = abs(local) - fields[i].zw;
          float inside = 1.0 - smoothstep(-0.5, 1.5, max(outside.x, outside.y) + margin);
          if (inside <= 0.0) continue;
          // the rows stand 0.375 m off every multiple of 0.75 m from the centre (see world/corn/field.ts)
          float ridge = 0.5 + 0.5 * cos((local.y - 0.375) * 6.2831853 / 0.75);
          vec3 field = soil * (0.62 + 0.3 * ridge * (1.0 - smoothstep(30.0, 120.0, dist))) * (0.85 + 0.3 * meso);
          c = mix(c, field, inside);
        }
        #ifdef CITY_PARCELS
        {
          // the cells, looked up through a little noise so their edges do not step
          vec2 jitter = (vec2(cityNoise2(xz * 0.35), cityNoise2(xz * 0.35 + 17.0)) - 0.5) * 2.5;
          ivec2 size = textureSize(parcels, 0);
          ivec2 cell = clamp(ivec2(floor((xz + jitter + PARCEL_EXTENT) / (2.0 * PARCEL_EXTENT) * float(size.x))), ivec2(0), size - 1);
          vec4 p = texelFetch(parcels, cell, 0);
          int crop = int(p.r * 255.0 + 0.5);
          #ifdef CITY_TOWN
          // garden lawns, mown in light and dark stripes along the street grid
          if (crop == 0 && p.a < 0.5 / 255.0 && distance(xz, TOWN.xy) < TOWN.z) {
            float stripe = sign(sin(dot(xz, vec2(cos(TOWN.w), sin(TOWN.w))) * 3.14159265 / 0.8));
            c *= 1.0 + 0.035 * stripe * (1.0 - smoothstep(30.0, 90.0, dist));
          }
          #endif
          if (crop >= 1) {
            // a grass margin where the next cell over holds another crop
            float margin = 0.0;
            for (int k = 0; k < 4; k++) {
              ivec2 o = k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1);
              vec4 q = texelFetch(parcels, clamp(cell + o, ivec2(0), size - 1), 0);
              margin = max(margin, step(0.5 / 255.0, abs(q.r - p.r)) * step(0.5 / 255.0, abs(q.r)));
            }
            float tint = p.g;
            float angle = p.b * 3.14159265;
            vec2 across2 = vec2(-sin(angle), cos(angle));
            float across = dot(xz, across2);
            float near = 1.0 - smoothstep(40.0, 160.0, dist);
            float detail = dot(texture2D(lawnMap, xz / 1.2).rgb, vec3(0.3, 0.59, 0.11)) / max(dot(lawnMean, vec3(0.3, 0.59, 0.11)), 0.01);
            detail = mix(1.0, detail, 0.6 * near);
            float patchy = 0.85 + 0.3 * cityNoise2(xz / 30.0 + tint * 40.0);
            // tractor tramlines, 20 m apart, two wheel tracks each
            float lane = abs(fract(across / 20.0) - 0.5) * 20.0;
            float tracks = 1.0 - smoothstep(0.15, 0.3, abs(lane - 0.9));
            // once a pixel spans more than the tracks are wide they alias into rows of
            // dots: blend them to their share of the ground, a few percent
            tracks = mix(tracks, 0.03, smoothstep(0.08, 0.4, fwidth(across)));
            vec3 earth2 = soil * 0.55;
            vec3 crops;
            if (crop == 1) crops = c * vec3(1.0, 1.2, 0.78) * (1.1 + 0.3 * tint);
            else if (crop == 2) crops = mix(vec3(0.36, 0.27, 0.1), vec3(0.47, 0.37, 0.15), tint) * patchy * detail;
            else if (crop == 3) crops = mix(vec3(0.52, 0.42, 0.02), vec3(0.2, 0.3, 0.05), 0.25 + 0.2 * tint) * patchy * detail;
            else if (crop == 4) {
              // ploughed: earth brown, the soil texture's grain in it, furrows across the near ground
              vec3 dirt = vec3(0.26, 0.18, 0.11) * (0.8 + 0.4 * tint) * (0.7 + 0.6 * dot(soil, vec3(0.3, 0.55, 0.15)) / max(dot(textureLod(soilMap, vec2(0.5), 12.0).rgb, vec3(0.3, 0.55, 0.15)), 0.01));
              crops = dirt * (0.8 + 0.3 * (0.5 + 0.5 * cos(across * 6.2831853 / 0.35)) * near) * patchy * mix(1.0, detail, 0.5);
            } else {
              // stubble: pale straw over soil, in soft swaths where the harvester went
              float swath = 0.5 + 0.5 * sin(across * 6.2831853 / 6.0 + cityNoise2(xz / 20.0) * 3.0);
              crops = mix(vec3(0.42, 0.36, 0.22), earth2, 0.25 + 0.15 * swath) * (0.92 + 0.08 * swath) * patchy * detail;
            }
            if (crop >= 2 && crop <= 3) crops = mix(crops, earth2, tracks * 0.8);
            c = mix(crops, c, margin * 0.8);
          }
        }
        #endif
        return c;
    }`;
  return { uniforms, glsl, key: `ground-${fields.length}-${forests.length}-${zones.parcels !== null}-${zones.town !== null}` };
}
