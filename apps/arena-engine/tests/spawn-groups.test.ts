/**
 * 4v4 · Reparto estable de bandos entre grupos de spawns (motor 0.3.0, ADR-020).
 * Puro: sin física. El comportamiento sobre el mapa real está en spawn-4v4.test.ts.
 */
import { describe, expect, it } from "vitest";
import { auxSpawnCandidates, resolveSpawnGroups, spawnPoolFor, type ArenaMap } from "../src/sim/modes.js";

const map = {
  spawns: [
    { team: "red", position: { x: 10, y: 36 }, heading: 0 },
    { team: "red", position: { x: 10, y: 44 }, heading: 0 },
    { team: "blue", position: { x: 110, y: 36 }, heading: Math.PI },
    { team: "blue", position: { x: 110, y: 44 }, heading: Math.PI },
  ],
} as Pick<ArenaMap, "spawns">;

describe("resolveSpawnGroups", () => {
  it("etiquetas del mapa: cada una la suya", () => {
    expect([...resolveSpawnGroups(["blue", "red"], map)]).toEqual([
      ["blue", "blue"],
      ["red", "red"],
    ]);
  });
  it("A/B sobre red/blue: A→red, B→blue (orden de grupos del mapa)", () => {
    const g = resolveSpawnGroups(["A", "B"], map);
    expect(g.get("A")).toBe("red");
    expect(g.get("B")).toBe("blue");
  });
  it("mezcla conocido/desconocido: el desconocido toma el grupo libre", () => {
    const g = resolveSpawnGroups(["A", "red"], map);
    expect(g.get("red")).toBe("red");
    expect(g.get("A")).toBe("blue");
  });
  it("más bandos que grupos (FFA): reparto cíclico estable", () => {
    const g = resolveSpawnGroups(["p1", "p2", "p3", "p4"], map);
    expect(["p1", "p2", "p3", "p4"].map((t) => g.get(t))).toEqual(["red", "blue", "red", "blue"]);
  });
  it("spawnPoolFor nunca devuelve el pool completo para A/B", () => {
    expect(spawnPoolFor("A", ["A", "B"], map).map((s) => s.position)).toEqual([
      { x: 10, y: 36 },
      { x: 10, y: 44 },
    ]);
    expect(spawnPoolFor("B", ["A", "B"], map).map((s) => s.position)).toEqual([
      { x: 110, y: 36 },
      { x: 110, y: 44 },
    ]);
  });
});

describe("auxSpawnCandidates", () => {
  it("sólo lateral y hacia atrás, nunca por delante del spawn base", () => {
    const pool = [{ position: { x: 50, y: 50 }, heading: 0.7 }];
    const cs = auxSpawnCandidates(pool, 5);
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) {
      const ahead = (c.position.x - 50) * Math.cos(0.7) + (c.position.y - 50) * Math.sin(0.7);
      expect(ahead).toBeLessThanOrEqual(1e-9);
      expect(c.heading).toBe(0.7);
    }
    // El primer anillo empieza por los laterales.
    expect(Math.hypot(cs[0].position.x - 50, cs[0].position.y - 50)).toBeCloseTo(5, 9);
  });
});
