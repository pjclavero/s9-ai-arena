/** OLA2-MF · el criterio de crecimiento de memoria se pone rojo ante fugas y verde ante una meseta. */
import { describe, expect, it } from "vitest";
import { evaluateGrowth, type GrowthPoint } from "./mf-growth.js";

const series = (n: number, rss: (i: number) => number, heap: (i: number) => number = () => 30): GrowthPoint[] =>
  Array.from({ length: n }, (_, i) => ({ i, rssMb: rss(i), heapMb: heap(i), availableMb: 3700 }));

describe("OLA2-MF · evaluateGrowth", () => {
  it("meseta tras calentamiento (115→166 MB en 11 batallas, luego ±1): verde", () => {
    const v = evaluateGrowth(series(40, (i) => (i < 11 ? 115 + i * 4.6 : 165 + (i % 3))), { gc: true });
    expect(v.violations).toEqual([]);
  });
  it("fuga de 3 MB/batalla: roja por pendiente y por cota absoluta", () => {
    const v = evaluateGrowth(series(40, (i) => 160 + 3 * i), { gc: false });
    expect(v.ok).toBe(false);
    expect(v.violations.join("|")).toMatch(/pendiente RSS/);
    expect(v.violations.join("|")).toMatch(/RSS final/);
  });
  it("fuga lenta de 0.6 MB/batalla (bajo el umbral de pendiente): la cota absoluta la caza", () => {
    const v = evaluateGrowth(series(60, (i) => 160 + 0.6 * i), { gc: false });
    expect(v.metrics.rssSlopeSecondHalf).toBeLessThan(1);
    expect(v.ok).toBe(false);
    expect(v.violations.join("|")).toMatch(/RSS final/);
  });
  it("fuga de objetos (heap +0.5 MB/batalla) con gc: roja aunque la RSS esté plana", () => {
    const heap = (i: number) => 30 + 0.5 * i;
    const v = evaluateGrowth(series(40, () => 165, heap), { gc: true });
    expect(v.ok).toBe(false);
    expect(v.violations.join("|")).toMatch(/heapUsed/);
    expect(evaluateGrowth(series(40, () => 165, heap), { gc: false }).ok).toBe(true);
  });
  it("pérdida sostenida de MemAvailable: roja", () => {
    const pts = series(40, () => 165).map((p) => ({ ...p, availableMb: 3700 - 3 * p.i }));
    expect(evaluateGrowth(pts, { gc: false }).violations.join("|")).toMatch(/MemAvailable/);
  });
});
