import * as THREE from "three";

// The sun is one light but several shadow-casting DirectionalLights, one per cascade (see
// `Sun`). three would light every material once per light; this replaces the directional
// part of three's lighting, for every material at once (faded copies, baked levels,
// interiors, impostors, terrain, grass and canopies alike): the first light is the sun,
// the others with shadows are its cascades and add no light. Each fragment takes its
// shadow from the finest cascade whose map covers it, blending into the next coarser one
// over the outer `BAND` of the map; past every map it is lit. Covering is decided on the
// shadow coordinate itself, so it needs no uniforms and holds for maps of cascades not
// redrawn this frame. A coordinate beyond the map's far plane counts as not covered:
// three's PCF test under reversed depth would shade it.
//
// The fragment works its shadow coordinates out from its own position: three's one
// varying per shadow-casting light, written by every vertex, costs more than the lookups
// (several milliseconds over a view of the whole countryside). An impostor's position
// there is its resolved surface, so its shadows need nothing of their own.

/** Share of a cascade's map, at each edge, over which it hands over to the next one. */
const BAND = 0.12;

/** `chunk` with the part from `first` up to `next` replaced by `by`; throws if three changed it. */
function replaceSection(chunk: string, first: string, next: string, by: string): string {
  const start = chunk.indexOf(first);
  const end = chunk.indexOf(next, start);
  if (start < 0 || end < 0) throw new Error(`three's shader chunk changed: "${first}" … "${next}" not found`);
  return chunk.slice(0, start) + by + chunk.slice(end);
}

/** `chunk` with `search` replaced by `by`; throws if three changed it. */
function replace(chunk: string, search: string, by: string): string {
  if (!chunk.includes(search)) throw new Error(`three's shader chunk changed: "${search}" not found`);
  return chunk.replace(search, () => by);
}

const COORD_VARYING = "varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];";

THREE.ShaderChunk.shadowmap_pars_vertex = replace(THREE.ShaderChunk.shadowmap_pars_vertex, COORD_VARYING, "");

THREE.ShaderChunk.shadowmap_vertex = replaceSection(THREE.ShaderChunk.shadowmap_vertex, "#if NUM_DIR_LIGHT_SHADOWS > 0", "#if NUM_POINT_LIGHT_SHADOWS > 0", "");

// A cascade's lookup: four bilinear depth comparisons around the coordinate, a smooth
// tent over about 2 × radius texels without noise. Unlike three's getShadow it reads the
// map's top mip explicitly: implicit derivatives would make the GPU sample every cascade
// ahead of the branch that picks one. Under PCF only, which this scene uses.
THREE.ShaderChunk.shadowmap_pars_fragment =
  replace(THREE.ShaderChunk.shadowmap_pars_fragment, COORD_VARYING, "uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];") +
  /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0 && defined( SHADOWMAP_TYPE_PCF )

	float sunShadowAt( sampler2DShadow map, vec2 size, float intensity, float bias, float radius, vec3 coord ) {

		vec2 offset = 0.5 * radius / size;
		float z = coord.z + bias;
		float shadow = 0.25 * (
			textureLod( map, vec3( coord.xy + vec2( - offset.x, - offset.y ), z ), 0.0 ) +
			textureLod( map, vec3( coord.xy + vec2( offset.x, - offset.y ), z ), 0.0 ) +
			textureLod( map, vec3( coord.xy + vec2( - offset.x, offset.y ), z ), 0.0 ) +
			textureLod( map, vec3( coord.xy + vec2( offset.x, offset.y ), z ), 0.0 )
		);
		return mix( 1.0, shadow, intensity );

	}

#endif
`;

const sun = /* glsl */ `
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	DirectionalLight directionalLight;
	float sunShadow = 1.0;

	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0

	DirectionalLightShadow directionalLightShadow;
	if ( receiveShadow ) {

		// world space; the normal offset goes toward the sun whichever way the face looks,
		// so the back of a leaf takes the shadow of its sunlit front
		vec3 sunPoint = ( ( vec4( geometryPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
		vec3 sunNormal = dot( nonPerturbedNormal, directionalLights[ 0 ].direction ) < 0.0 ? - nonPerturbedNormal : nonPerturbedNormal;
		sunNormal = ( vec4( sunNormal, 0.0 ) * viewMatrix ).xyz;

		sunShadow = 0.0;
		// weight not yet taken by a finer cascade
		float sunLeft = 1.0;
		vec3 sunCoord;
		vec2 sunEdge;
		float sunCover;

		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {

			if ( sunLeft > 0.0 ) {

				directionalLightShadow = directionalLightShadows[ i ];
				sunCoord = ( directionalShadowMatrix[ i ] * vec4( sunPoint + sunNormal * directionalLightShadow.shadowNormalBias, 1.0 ) ).xyz;
				sunEdge = min( sunCoord.xy, 1.0 - sunCoord.xy );
				sunCover = smoothstep( 0.0, ${BAND.toFixed(3)}, min( sunEdge.x, sunEdge.y ) ) * step( 0.0, sunCoord.z );
				if ( sunCover > 0.0 ) {

					sunShadow += sunLeft * sunCover * sunShadowAt( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, sunCoord );
					sunLeft -= sunLeft * sunCover;

				}

			}

		}
		#pragma unroll_loop_end

		sunShadow += sunLeft;

	}

	#endif

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

		#if ( UNROLLED_LOOP_INDEX == 0 ) || ( UNROLLED_LOOP_INDEX >= NUM_DIR_LIGHT_SHADOWS )

		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if ( UNROLLED_LOOP_INDEX == 0 )
		directLight.color *= sunShadow;
		#endif
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

		#endif

	}
	#pragma unroll_loop_end

#endif

`;

THREE.ShaderChunk.lights_fragment_begin = replaceSection(
  THREE.ShaderChunk.lights_fragment_begin,
  "#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )",
  "#if ( NUM_RECT_AREA_LIGHTS > 0 )",
  sun,
);
