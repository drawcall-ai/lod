import { type Textures, baseColor } from "../materials.ts";
import * as THREE from "three/webgpu";
import { Fn, If, cameraPosition, distance, float, mix, positionWorld, rtt, smoothstep, uv, vec4 } from "three/tsl";
import type { Zones } from "../../world/zones.ts";
import { groundShading } from "./shading.ts";

/** The lawn everywhere, for the content viewer. */
export const terrain = (textures: Textures) => terrainMaterial(textures, { fields: [], forests: [], parcels: null, town: null });

/** Ground for anything from a few metres to a few kilometres away, on a mesh whose UVs are world x/z in metres: see `groundShading`. */
export function terrainMaterial(textures: Textures, zones: Zones): THREE.MeshStandardNodeMaterial {
  const lawn = "Grass001";
  const m = new THREE.MeshStandardNodeMaterial({
    name: "terrain",
    normalMap: textures.get(lawn, "nor"),
    // fully rough: the photo's roughness lets a low sun glare off the lawn like wet tarmac
    roughness: 1,
    aoMap: textures.get(lawn, "arm"),
    metalness: 0,
  });
  const ground = groundShading(textures, zones);
  const xz = positionWorld.xz;
  const dist = distance(cameraPosition, positionWorld);
  if (!zones.parcels) {
    m.colorNode = baseColor.mul(vec4(ground(xz, dist), 1));
    return m;
  }

  // The distant ground colour stops changing with viewing distance at 600 m.
  // Include the ground beyond the playable parcels in the aerial view.
  const span = 4 * zones.parcels.extent;
  const map = rtt(vec4(ground(uv().sub(0.5).mul(span), float(600)), 1), 2048, 2048, {
    autoUpdate: false,
    depthBuffer: false,
    type: THREE.UnsignedByteType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  m.addEventListener("dispose", () => map.dispose());
  m.colorNode = baseColor.mul(
    Fn(() => {
      const st = xz.div(span).add(0.5);
      const inside = st.greaterThanEqual(0).all().and(st.lessThanEqual(1).all());
      const fade = smoothstep(400, 600, dist).mul(float(inside)).toVar();
      const colour = map.sample(st).toVar();
      If(fade.lessThan(1), () => {
        colour.assign(mix(vec4(ground(xz, dist), 1), colour, fade));
      });
      return colour;
    })(),
  );
  return m;
}
