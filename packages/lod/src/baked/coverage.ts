import type { Mip } from "../source/sampler.js";

/**
 * Preserve the base mip's cut-out coverage down the chain: scale each smaller mip's alpha, in place, so that the same
 * share of its texels passes the alpha test, with room for filtering around the test. Returns `mips`.
 */
export function preserveCoverage(mips: Mip[]): Mip[] {
  const [base] = mips;
  if (!base) return mips;
  const target = passing(base, 1);
  if (target === 0 || target === 1) return mips;
  for (const mip of mips.slice(1)) {
    let low = 0;
    let high = 8;
    for (let i = 0; i < 16; i++) {
      const scale = (low + high) / 2;
      if (passing(mip, scale) < target) low = scale;
      else high = scale;
    }
    let inside = Infinity;
    let outside = -Infinity;
    for (let i = 3; i < mip.data.length; i += 4) {
      const alpha = mip.data[i] ?? 0;
      if (alpha * high >= 127.5) inside = Math.min(inside, alpha);
      else outside = Math.max(outside, alpha);
    }
    // The smallest scale puts a retained texel at alpha 128: bilinear filtering
    // then cuts almost all of its area away. Centre the gap without changing which
    // texels pass. A uniform coarse mip has no gap; use its original correction.
    if (Number.isFinite(inside) && Number.isFinite(outside)) high = 255 / (inside + outside);
    for (let i = 3; i < mip.data.length; i += 4) mip.data[i] = (mip.data[i] ?? 0) * high;
  }
  return mips;
}

function passing({ data }: Mip, scale: number): number {
  let count = 0;
  for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) * scale >= 127.5) count++;
  return count / (data.length / 4);
}
