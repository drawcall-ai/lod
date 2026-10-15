/**
 * Monotone cubic interpolation (Fritsch–Carlson) of one value over time: smooth through
 * every key and never overshooting between two, so a camera closing in on a ladybird
 * never swings past it.
 */
export class MonotoneCurve {
  private readonly slopes: number[];

  constructor(
    private readonly times: number[],
    private readonly values: number[],
  ) {
    if (times.length !== values.length || times.length < 2) throw new Error("MonotoneCurve needs two or more keys, one value per time");
    const n = times.length;
    const secant = (i: number) => ((values[i + 1] ?? 0) - (values[i] ?? 0)) / ((times[i + 1] ?? 0) - (times[i] ?? 0));
    const slopes = Array.from({ length: n }, (_, i) => {
      if (i === 0) return secant(0);
      if (i === n - 1) return secant(n - 2);
      const a = secant(i - 1);
      const b = secant(i);
      return a * b <= 0 ? 0 : (a + b) / 2;
    });
    for (let i = 0; i < n - 1; i++) {
      const d = secant(i);
      if (d === 0) {
        slopes[i] = slopes[i + 1] = 0;
        continue;
      }
      const a = (slopes[i] ?? 0) / d;
      const b = (slopes[i + 1] ?? 0) / d;
      const h = Math.hypot(a, b);
      if (h > 3) {
        slopes[i] = (3 / h) * a * d;
        slopes[i + 1] = (3 / h) * b * d;
      }
    }
    // ease in and out of the whole flight
    slopes[0] = 0;
    slopes[n - 1] = 0;
    this.slopes = slopes;
  }

  at(t: number): number {
    const { times, values, slopes } = this;
    const last = times.length - 1;
    if (t <= (times[0] ?? 0)) return values[0] ?? 0;
    if (t >= (times[last] ?? 0)) return values[last] ?? 0;
    let i = 0;
    while (i < last - 1 && t > (times[i + 1] ?? 0)) i++;
    const t0 = times[i] ?? 0;
    const h = (times[i + 1] ?? 0) - t0;
    const s = (t - t0) / h;
    const y0 = values[i] ?? 0;
    const y1 = values[i + 1] ?? 0;
    const s2 = s * s;
    const s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * y0 + (s3 - 2 * s2 + s) * h * (slopes[i] ?? 0) + (-2 * s3 + 3 * s2) * y1 + (s3 - s2) * h * (slopes[i + 1] ?? 0);
  }
}
