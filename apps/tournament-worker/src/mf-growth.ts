/**
 * OLA2-MF · criterio de crecimiento de memoria de la serie de resistencia.
 *
 * Condiciones sobre las batallas medidas (sin la de calentamiento):
 *  1. pendiente (mínimos cuadrados) de la RSS en la SEGUNDA mitad < rssSlopeMax MB/batalla;
 *  2. cota ABSOLUTA: RSS de la última batalla - mediana de la RSS de la primera mitad < rssAbsMax MB
 *     (una fuga lenta que la pendiente tolera acaba cruzándola);
 *  3. si hay `--expose-gc`: pendiente de heapUsed tras gc < heapSlopeMax MB/batalla (separa una fuga
 *     de objetos de la deriva de las arenas de malloc, que sólo mueve la RSS).
 *  4. la pérdida de MemAvailable del sistema < availSlopeMax MB/batalla.
 */
export interface GrowthPoint {
  i: number;
  rssMb: number;
  heapMb: number;
  availableMb: number;
}
export interface GrowthLimits {
  rssSlopeMax: number;
  rssAbsMax: number;
  heapSlopeMax: number;
  availSlopeMax: number;
}
export const DEFAULT_GROWTH_LIMITS: GrowthLimits = {
  rssSlopeMax: 1,
  rssAbsMax: 20,
  heapSlopeMax: 0.25,
  availSlopeMax: 2,
};

export function slope(set: GrowthPoint[], key: "rssMb" | "heapMb" | "availableMb"): number {
  const n = set.length;
  if (n < 2) return 0;
  const mx = set.reduce((a, r) => a + r.i, 0) / n;
  const my = set.reduce((a, r) => a + r[key], 0) / n;
  const num = set.reduce((a, r) => a + (r.i - mx) * (r[key] - my), 0);
  const den = set.reduce((a, r) => a + (r.i - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface GrowthVerdict {
  ok: boolean;
  violations: string[];
  metrics: {
    n: number;
    rssSlopeSecondHalf: number;
    rssSlopeAll: number;
    rssAbsGrowth: number;
    heapSlopeSecondHalf: number | null;
    availSlopeSecondHalf: number;
  };
}

export function evaluateGrowth(
  points: GrowthPoint[],
  opts: { gc: boolean; limits?: Partial<GrowthLimits> } = { gc: false },
): GrowthVerdict {
  const L = { ...DEFAULT_GROWTH_LIMITS, ...(opts.limits ?? {}) };
  const half = Math.floor(points.length / 2);
  const first = points.slice(0, half);
  const second = points.slice(half);
  const rssSlope = slope(second, "rssMb");
  const availSlope = slope(second, "availableMb");
  const heapSlope = opts.gc ? slope(second, "heapMb") : null;
  const rssAbs = points.length ? points[points.length - 1].rssMb - median(first.map((p) => p.rssMb)) : 0;
  const violations: string[] = [];
  if (!(rssSlope < L.rssSlopeMax))
    violations.push(`pendiente RSS 2ª mitad ${rssSlope.toFixed(2)} >= ${L.rssSlopeMax} MB/batalla`);
  if (!(rssAbs < L.rssAbsMax)) violations.push(`RSS final - mediana 1ª mitad ${rssAbs.toFixed(1)} >= ${L.rssAbsMax} MB`);
  if (heapSlope !== null && !(heapSlope < L.heapSlopeMax))
    violations.push(`pendiente heapUsed(gc) 2ª mitad ${heapSlope.toFixed(2)} >= ${L.heapSlopeMax} MB/batalla`);
  if (!(availSlope > -L.availSlopeMax))
    violations.push(`MemAvailable ${availSlope.toFixed(2)} <= -${L.availSlopeMax} MB/batalla`);
  return {
    ok: violations.length === 0,
    violations,
    metrics: {
      n: points.length,
      rssSlopeSecondHalf: rssSlope,
      rssSlopeAll: slope(points, "rssMb"),
      rssAbsGrowth: rssAbs,
      heapSlopeSecondHalf: heapSlope,
      availSlopeSecondHalf: availSlope,
    },
  };
}
