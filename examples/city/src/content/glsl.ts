/**
 * Value noise in [0, 1] (3D, and a cheaper 2D one) and a 4-octave 2D fbm, shared by the
 * procedural shader patches. Each
 * fbm octave is rotated: value noise flattens out along its lattice lines, and unrotated
 * octaves stack those lines into a visible grid on large flat surfaces.
 */
export const noise = /* glsl */ `
  float cityHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float cityNoise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(cityHash(i), cityHash(i + vec3(1, 0, 0)), f.x), mix(cityHash(i + vec3(0, 1, 0)), cityHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(cityHash(i + vec3(0, 0, 1)), cityHash(i + vec3(1, 0, 1)), f.x), mix(cityHash(i + vec3(0, 1, 1)), cityHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float cityHash2(vec2 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * (p.x + p.y)); }
  float cityNoise2(vec2 x) {
    vec2 i = floor(x); vec2 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(cityHash2(i), cityHash2(i + vec2(1, 0)), f.x), mix(cityHash2(i + vec2(0, 1)), cityHash2(i + vec2(1, 1)), f.x), f.y);
  }
  float cityFbm(vec2 p) {
    float sum = 0.0;
    float amp = 0.5;
    mat2 turn = mat2(0.8, 0.6, -0.6, 0.8) * 2.03;
    for (int i = 0; i < 4; i++) { sum += amp * cityNoise2(p); p = turn * p + 17.0; amp *= 0.5; }
    return sum / 0.9375;
  }
`;
