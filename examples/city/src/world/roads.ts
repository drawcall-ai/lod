import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { surface } from "../content/materials.ts";
import { axes, PAVEMENT, type Plan } from "./plan.ts";
import type { Terrain } from "./terrain.ts";

/** Height of each surface above the ground: later ones win where they overlap. */
const LIFT = { bed: 0.012, path: 0.02, drive: 0.025, track: 0.03, street: 0.04, main: 0.05, plaza: 0.07 };

/**
 * Roads, pavements and the plaza as draped ribbons: vertices every few metres along and
 * across follow the terrain, so they lie on it at any distance. Asphalt and gravel take
 * world x/z texture coordinates, so where two roads overlap they show the same texels;
 * main roads carry painted lines.
 */
export function roads(plan: Plan): THREE.Group {
  const { terrain } = plan;
  const asphalt: THREE.BufferGeometry[] = [];
  const gravel: THREE.BufferGeometry[] = [];
  const kerbs: THREE.BufferGeometry[] = [];
  const beds: THREE.BufferGeometry[] = [];
  for (const road of plan.roads) {
    const lane = road.kind === "main";
    const lift = LIFT[road.kind];
    (road.kind === "track" || road.kind === "drive" ? gravel : road.kind === "path" ? kerbs : road.kind === "bed" ? beds : asphalt).push(
      ribbon(
        terrain,
        road.points,
        [
          { s: -road.width / 2, lift },
          { s: road.width / 2, lift },
        ],
        lane,
      ),
    );
    if (!road.pavement) continue;
    // stop short of the crossings, where the other street runs through
    const trimmed = trim(road.points, road.width / 2 + PAVEMENT.width);
    const inner = road.width / 2;
    const outer = inner + PAVEMENT.width;
    const { kerb } = PAVEMENT;
    // the pavement steps up at the kerb and down into the lawn at its back edge
    kerbs.push(
      ribbon(
        terrain,
        trimmed,
        [
          { s: inner, lift: 0 },
          { s: inner, lift: kerb },
          { s: outer, lift: kerb },
          { s: outer, lift: -0.05 },
        ],
        false,
      ),
    );
    kerbs.push(
      ribbon(
        terrain,
        trimmed,
        [
          { s: -outer, lift: -0.05 },
          { s: -outer, lift: kerb },
          { s: -inner, lift: kerb },
          { s: -inner, lift: 0 },
        ],
        false,
      ),
    );
  }
  const group = new THREE.Group();
  group.name = "roads";
  group.add(
    drape(asphalt, markings(), "asphalt"),
    drape(gravel, surface("gravel_road", { normalScale: 1.2 }), "tracks"),
    drape(kerbs, surface("brushed_concrete_04", { weather: 0.4 }), "pavements"),
  );
  group.add(drape(beds, surface("farm_soil", { color: "#8a7a6a", normalScale: 1.2 }), "beds"));
  group.add(drape([plazaGeometry(plan)], surface("cobblestone_floor_04", { normalScale: 1.5 }), "plaza"));
  return group;
}

function drape(parts: THREE.BufferGeometry[], material: THREE.Material, name: string): THREE.Mesh {
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error(`${name}: ribbons have different attributes`);
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = name;
  mesh.receiveShadow = true;
  return mesh;
}

/** A point of a ribbon's cross-section: metres left of the centre line, and height above the ground. */
interface Column {
  s: number;
  lift: number;
}

/**
 * A strip along `points` through the cross-section `across` (ordered right to left);
 * two columns at one offset make a kerb. UVs are world x/z; `lane` holds distance along
 * and offset across for road paint (99 across: no paint).
 */
function ribbon(terrain: Terrain, points: THREE.Vector2[], across: Column[], paint: boolean): THREE.BufferGeometry {
  const line = resample(points, 3);
  // subdivide wide spans so the strip follows the ground across it too
  const columns: Column[] = [];
  across.forEach((c, k) => {
    columns.push(c);
    const next = across[k + 1];
    if (!next) return;
    const steps = Math.ceil((next.s - c.s) / 1.5);
    for (let f = 1; f < steps; f++) columns.push({ s: c.s + ((next.s - c.s) * f) / steps, lift: c.lift + ((next.lift - c.lift) * f) / steps });
  });
  const position: number[] = [];
  const uv: number[] = [];
  const lane: number[] = [];
  let along = 0;
  line.forEach((p, i) => {
    const prev = line[i - 1] ?? p;
    const next = line[i + 1] ?? p;
    along += p.distanceTo(prev);
    const dir = next.clone().sub(prev).normalize();
    for (const { s, lift } of columns) {
      const x = p.x - dir.y * s;
      const z = p.y + dir.x * s;
      position.push(x, terrain.height(x, z) + lift, z);
      uv.push(x, z);
      lane.push(along, paint ? s : 99);
    }
  });
  const index: number[] = [];
  const n = columns.length;
  for (let i = 0; i < line.length - 1; i++)
    for (let c = 0; c < n - 1; c++) {
      const a = i * n + c;
      // counter-clockwise seen from above: the next column lies to the left
      index.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("lane", new THREE.Float32BufferAttribute(lane, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Points along `points` every `step` metres or less, the corners kept. */
function resample(points: THREE.Vector2[], step: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  points.forEach((p, i) => {
    const q = points[i + 1];
    if (!q) return out.push(p.clone());
    const n = Math.max(1, Math.ceil(p.distanceTo(q) / step));
    for (let k = 0; k < n; k++) out.push(p.clone().lerp(q, k / n));
  });
  return out;
}

/** `points` (a straight street) shortened by `by` at both ends. */
function trim(points: THREE.Vector2[], by: number): THREE.Vector2[] {
  const a = points[0];
  const b = points[points.length - 1];
  if (!a || !b) throw new Error("empty street");
  const dir = b.clone().sub(a).normalize();
  return [a.clone().addScaledVector(dir, by), b.clone().addScaledVector(dir, -by)];
}

function plazaGeometry(plan: Plan): THREE.BufferGeometry {
  const { plaza, terrain } = plan;
  const { x: ax, z: az } = axes(plaza.angle);
  const steps = 24;
  const position: number[] = [];
  const uv: number[] = [];
  const lane: number[] = [];
  for (let j = 0; j <= steps; j++)
    for (let i = 0; i <= steps; i++) {
      const lx = (i / steps - 0.5) * 2 * plaza.halfX;
      const lz = (j / steps - 0.5) * 2 * plaza.halfZ;
      const x = plaza.x + ax.x * lx + az.x * lz;
      const z = plaza.z + ax.y * lx + az.y * lz;
      position.push(x, terrain.height(x, z) + LIFT.plaza, z);
      uv.push(lx, lz);
      lane.push(0, 99);
    }
  const index: number[] = [];
  for (let j = 0; j < steps; j++)
    for (let i = 0; i < steps; i++) {
      const a = j * (steps + 1) + i;
      const c = a + steps + 1;
      index.push(a, c, a + 1, a + 1, c, c + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("lane", new THREE.Float32BufferAttribute(lane, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Asphalt with a dashed centre line and solid edge lines where `lane.y` is within the road. */
function markings(): THREE.MeshStandardMaterial {
  const m = surface("asphalt_02", { normalScale: 0.8 }).clone();
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute vec2 lane;\nvarying vec2 vLane;\n${shader.vertexShader}`.replace(
      "#include <uv_vertex>",
      "#include <uv_vertex>\nvLane = lane;",
    );
    shader.fragmentShader = `varying vec2 vLane;\n${shader.fragmentShader}`.replace(
      "#include <map_fragment>",
      /* glsl */ `#include <map_fragment>
      {
        float across = abs(vLane.y);
        float centre = step(across, 0.07) * step(fract(vLane.x / 9.0), 0.36);
        float edge = step(abs(across - 3.15), 0.07);
        float paint = max(centre, edge) * step(across, 50.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75), paint * 0.85);
      }`,
    );
  };
  m.customProgramCacheKey = () => "road-markings";
  return m;
}
