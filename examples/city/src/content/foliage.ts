import * as THREE from "three";
import { ImpostorMesh } from "@drawcall/lod";

export interface FoliageOptions {
  /** Share of sunlight a leaf passes on to its shaded side (0–1). */
  translucency: number;
  /** Colour of the transmitted light relative to the leaf's own: thin leaves glow yellow-green. */
  tint?: THREE.ColorRepresentation;
}

/**
 * Turns a standard or physical leaf material into foliage, on top of whatever its
 * onBeforeCompile does already:
 * - translucency: sunlight hitting the far side of a thin leaf shows on the near side, so
 *   back-lit leaves glow instead of turning black. It rides on the direct-light term, so it
 *   is shadowed exactly like front light. On an impostor's material, it lights the baked
 *   leaves the same way, by their averaged normals.
 * - for cut-out leaves, alpha to coverage plus a mip-dependent alpha boost: plain alpha
 *   testing loses coverage in smaller mips, which makes distant needles and leaves vanish.
 *   Three's shadow pass runs none of this: see `leafShadows`.
 */
export function foliage(m: THREE.MeshStandardMaterial, { translucency, tint = "#e4ff8a" }: FoliageOptions): void {
  if (m.alphaTest > 0) m.alphaToCoverage = true;
  // an impostor's material is alpha-tested too, but by its own test of the baked coverage
  const leaves = isLeaves(m);
  const color = new THREE.Color(tint);
  const previous = m.onBeforeCompile;
  const key = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    previous.call(m, shader, renderer);
    shader.uniforms.translucency = { value: translucency };
    shader.uniforms.translucencyTint = { value: color };
    // just before main: after three's lighting functions, which an impostor's shader replaces
    shader.fragmentShader = replace(
      shader.fragmentShader,
      "void main() {",
      /* glsl */ `uniform float translucency;
      uniform vec3 translucencyTint;
      void RE_Direct_Foliage(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
        RE_Direct_Physical(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
        #ifdef IMPOSTOR_LIT
          float behind = impostorCosine(geometryNormal, -directLight.direction);
        #else
          float behind = saturate(-dot(geometryNormal, directLight.direction));
        #endif
        // light scatters forward through the leaf: strongest when looking toward the sun
        float forward = 0.35 + 0.65 * pow(saturate(dot(geometryViewDir, -directLight.direction)), 3.0);
        reflectedLight.directDiffuse += directLight.color * material.diffuseColor * translucencyTint * translucency * behind * forward;
      }
      #undef RE_Direct
      #define RE_Direct RE_Direct_Foliage
      void main() {`,
    );
    if (!leaves) return;
    boostAlpha(shader);
  };
  m.customProgramCacheKey = () => `${key()}|foliage-${leaves}`;
}

/** Applies `foliage` to every alpha-tested material of a loaded plant model, and `leafShadows` to its meshes. */
export function foliageModel(root: THREE.Object3D, options: FoliageOptions): void {
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (seen.has(m) || !(m instanceof THREE.MeshStandardMaterial) || m.alphaTest === 0) continue;
      seen.add(m);
      foliage(m, options);
    }
  });
  leafShadows(root);
}

/**
 * Applies `foliage` to the impostors a Lod or InstancedLod under `root` draws, which light
 * the baked surface as a standard material and know nothing of the leaves' translucency,
 * and `leafShadows` to its other meshes, which neither three's clones nor an
 * InstancedLod's meshes inherit.
 */
export function foliageLevels(root: THREE.Object3D, options: FoliageOptions): void {
  root.traverse((o) => {
    if (o instanceof ImpostorMesh) foliage(o.material, options);
  });
  leafShadows(root);
}

/**
 * Gives every mesh under `root` that draws cut-out leaves a depth material with their
 * alpha boost, so it casts the coverage it draws. Three's own depth material runs no
 * onBeforeCompile: without this, trees cast thinner shadows than they show while their
 * impostors cast what they show, and the shade under a tree changes as it hands over.
 * Three hands the depth material each drawn material's map and alpha test.
 */
function leafShadows(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o instanceof ImpostorMesh) return;
    const materials: THREE.Material[] = Array.isArray(o.material) ? o.material : [o.material];
    const leaves = materials.filter(isLeaves);
    if (leaves.length === 0) return;
    // three reuses one depth material for every group of a mesh, without refreshing its map
    if (leaves.length !== materials.length || new Set(leaves.map((m) => m.map)).size > 1) {
      throw new Error(`foliage: "${o.name}" draws leaves with other materials; split it to cast their shadows`);
    }
    const depth = new THREE.MeshDepthMaterial();
    depth.onBeforeCompile = boostAlpha;
    depth.customProgramCacheKey = () => "foliage-leaves";
    o.customDepthMaterial = depth;
  });
}

/** Cut-out leaves: their alpha is boosted (see `foliage`). An impostor's material has no map. */
function isLeaves(m: THREE.Material): m is THREE.Material & { map: THREE.Texture } {
  return m.alphaTest > 0 && "map" in m && m.map instanceof THREE.Texture;
}

/** Boosts alpha by the mip the map is read at, before the alpha test. */
function boostAlpha(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.fragmentShader = replace(
    shader.fragmentShader,
    "#include <alphatest_fragment>",
    /* glsl */ `#if defined(USE_ALPHATEST) && defined(USE_MAP)
    {
      vec2 texel = vMapUv * vec2(textureSize(map, 0));
      float mip = max(0.0, 0.5 * log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel)))));
      diffuseColor.a *= 1.0 + mip * 0.25;
    }
    #endif
    #include <alphatest_fragment>`,
  );
}

/** `source` with `search` replaced by `by`; throws if three or the package changed it. */
function replace(source: string, search: string, by: string): string {
  if (!source.includes(search)) throw new Error(`foliage: "${search}" not found in the shader`);
  return source.replace(search, () => by);
}
