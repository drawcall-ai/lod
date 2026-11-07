import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  dot,
  float,
  lightShadowMatrix,
  min,
  normalWorldGeometry,
  select,
  shadow,
  shadowPositionWorld,
  smoothstep,
  step,
  texture,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Cascade } from "./index.ts";

// The sun is one light, shadowed by several maps, one per cascade (see `Sun`). Each
// fragment takes its shadow from the finest cascade whose map covers it, blending into
// the next coarser one over the outer `BAND` of the map; past every map it is lit.
// Covering is decided on the shadow coordinate itself, so it holds for maps of cascades
// not redrawn this frame. A coordinate beyond the map's far plane counts as not covered:
// the depth test under reversed depth would shade it. An impostor's position here is its
// resolved surface (three's `receivedShadowPositionNode`).

/** Share of a cascade's map, at each edge, over which it hands over to the next one. */
const BAND = 0.12;

/** The sun's shadow: the light's `shadow.shadowNode`, which three multiplies its colour by. */
export class SunShadow extends THREE.ShadowBaseNode {
  /** Per cascade, its shadow: three's node drawing the map, looking up with `lookup`. */
  private readonly lookups: THREE.ShadowNode[];

  constructor(
    light: THREE.DirectionalLight,
    private readonly cascades: Cascade[],
    sun: THREE.Vector3,
  ) {
    super(light);
    this.lookups = cascades.map((cascade) => {
      // three looks a shadow map up with the light shadow's `filterNode`, which its typings leave out
      Object.assign(cascade.light.shadow, { filterNode: lookup(cascade, sun) });
      return shadow(cascade.light, cascade.light.shadow);
    });
  }

  override updateBefore(): undefined {
    // Each child ShadowNode updates its own map. This node only combines their lookups.
  }

  override setup(builder: THREE.NodeBuilder): THREE.Node<"float"> {
    return Fn(() => {
      this.setupShadowPosition(builder);
      const position = vec3(0).toVar();
      position.assign(shadowPositionWorld);
      const lit = float(0).toVar();
      // weight not yet taken by a finer cascade
      const left = float(1).toVar();
      this.cascades.forEach(({ light }, i) => {
        const map = this.lookups[i];
        if (!map) throw new Error("the sun has a cascade without a shadow");
        If(left.greaterThan(0), () => {
          const at = lightShadowMatrix(light).mul(vec4(position, 1)).xyz.toVar();
          const edge = min(min(at.x, at.x.oneMinus()), min(at.y, at.y.oneMinus()));
          const cover = smoothstep(0, BAND, edge).mul(step(0, at.z)).toVar();
          If(cover.greaterThan(0), () => {
            // three's typings leave the shadow's type open; it is a float
            const shade = float(1).toVar();
            shade.assign(map);
            lit.addAssign(left.mul(cover).mul(shade));
            left.subAssign(left.mul(cover));
          });
        });
      });
      return lit.add(left);
    })();
  }
}

/**
 * A cascade's lookup, from three's shadow coordinate: offset toward the sun, then four
 * bilinear depth comparisons around it, a smooth tent over about 2 texels without
 * noise. The normal offset goes toward the sun whichever way the face looks, so the back
 * of a leaf takes the shadow of its sunlit front (three would offset it along the
 * normal it shades with, away from the sun).
 */
function lookup({ light, offset }: Cascade, sun: THREE.Vector3) {
  const half = 0.5 / light.shadow.mapSize.x;
  return ({ depthTexture, shadowCoord }: { depthTexture: THREE.DepthTexture; shadowCoord: THREE.Node<"vec3"> }): THREE.Node<"float"> => {
    const n = normalWorldGeometry;
    const toward = select(dot(n, vec3(sun.x, sun.y, sun.z)).lessThan(0), n.negate(), n).mul(offset);
    // into the map's coordinates, whose y runs down
    const shift = lightShadowMatrix(light).mul(vec4(toward, 0)).xyz;
    const at = shadowCoord.add(vec3(shift.x, shift.y.negate(), shift.z)).toVar();
    const tap = (x: number, y: number) => texture(depthTexture, at.xy.add(vec2(x * half, y * half))).compare(at.z).x;
    return tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1)).mul(0.25);
  };
}
