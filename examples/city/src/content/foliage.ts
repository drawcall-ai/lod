import * as THREE from "three";

export interface FoliageOptions {
  /** Share of sunlight a leaf passes on to its shaded side (0–1). */
  translucency: number;
  /** Colour of the transmitted light relative to the leaf's own: thin leaves glow yellow-green. */
  tint?: THREE.ColorRepresentation;
}

/**
 * Turns a standard or physical leaf material into foliage:
 * - translucency: sunlight hitting the far side of a thin leaf shows on the near side, so
 *   back-lit leaves glow instead of turning black. It rides on the direct-light term, so it
 *   is shadowed exactly like front light.
 * - for cut-out leaves, alpha to coverage plus a mip-dependent alpha boost: plain alpha
 *   testing loses coverage in smaller mips, which makes distant needles and leaves vanish.
 */
export function foliage(m: THREE.MeshStandardMaterial, { translucency, tint = "#e4ff8a" }: FoliageOptions): void {
  if (m.alphaTest > 0) m.alphaToCoverage = true;
  const color = new THREE.Color(tint);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.translucency = { value: translucency };
    shader.uniforms.translucencyTint = { value: color };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <lights_physical_pars_fragment>",
        /* glsl */ `#include <lights_physical_pars_fragment>
        uniform float translucency;
        uniform vec3 translucencyTint;
        void RE_Direct_Foliage(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
          RE_Direct_Physical(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
          float behind = saturate(-dot(geometryNormal, directLight.direction));
          // light scatters forward through the leaf: strongest when looking toward the sun
          float forward = 0.35 + 0.65 * pow(saturate(dot(geometryViewDir, -directLight.direction)), 3.0);
          reflectedLight.directDiffuse += directLight.color * material.diffuseColor * translucencyTint * translucency * behind * forward;
        }
        #undef RE_Direct
        #define RE_Direct RE_Direct_Foliage`,
      )
      .replace(
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
  };
  m.customProgramCacheKey = () => `foliage-${m.alphaTest > 0}`;
}

/** Applies `foliage` to every alpha-tested material of a loaded plant model. */
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
}
