/**
 * 4v4-FIX · Spawn en esquina con heading diagonal: la rejilla atrás/lados de 0.3.0
 * cae fuera del mapa. La búsqueda amplia (anillos completos) debe:
 *  - colocar los 4 de cada bando sin solapes, dentro del mapa y deterministas;
 *  - preferir puntos NO más cercanos al rival que el spawn base cuando existen
 *    (rival en la OTRA esquina del mismo borde: hay sitio «hacia el lado»).
 *  - y sólo si no hay otro remedio, por delante (rival en la esquina opuesta: todo
 *    el mapa está más cerca de él; aun así, sin solapes).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle, type Participant } from "../src/sim/battle.js";
import { chooseSpawn, wideSpawnCandidates, type ArenaMap } from "../src/sim/modes.js";
import { initPhysics } from "../src/sim/physics.js";
import { emptyArena, gunnerLoadout } from "../src/fixtures.js";
import { IdleBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

const parts = (): Participant[] =>
  Array.from({ length: 8 }, (_, i) => ({
    id: `veh_${i + 1}`,
    botId: `b${i + 1}`,
    team: i < 4 ? "red" : "blue",
    spec: gunnerLoadout(),
  }));

function place(map: ArenaMap) {
  const ps = parts();
  const b = new Battle({ battleId: "corner", seed: "c", ruleset: loadRuleset("tdm_mvp@1"), map, participants: ps });
  for (const p of ps) b.attachBot(p.id, new IdleBot(p.botId));
  const phys = b.getPhysics();
  const out = b
    .getVehicles()
    .map((v) => ({ id: v.id, team: v.team, r: v.spec.radiusM, p: { ...phys.pose(v.id)!.position } }));
  const hash = b.stateHash();
  b.free();
  return { out, hash };
}

function minGap(out: { r: number; p: { x: number; y: number } }[]) {
  let g = Infinity;
  for (let i = 0; i < out.length; i++)
    for (let j = i + 1; j < out.length; j++)
      g = Math.min(g, Math.hypot(out[i].p.x - out[j].p.x, out[i].p.y - out[j].p.y) - out[i].r - out[j].r);
  return g;
}

describe("4v4-FIX · spawn en esquina con heading diagonal", () => {
  it("rival en la misma fila: sin solapes y ningún rojo más cerca del rival que su base", () => {
    const m = emptyArena();
    m.spawns = [
      { team: "red", position: { x: 3, y: 3 }, heading: Math.PI / 4 },
      { team: "blue", position: { x: 117, y: 3 }, heading: (3 * Math.PI) / 4 },
    ];
    const a = place(m);
    const b = place(m);
    expect(a.out).toEqual(b.out);
    expect(a.hash).toBe(b.hash);
    expect(minGap(a.out)).toBeGreaterThanOrEqual(1 - 1e-4);
    const base = Math.hypot(117 - 3, 0);
    for (const v of a.out.filter((v) => v.team === "red")) {
      expect(Math.hypot(v.p.x - 117, v.p.y - 3), v.id).toBeGreaterThanOrEqual(base - 1e-6);
    }
    for (const v of a.out) {
      expect(v.p.x - v.r).toBeGreaterThanOrEqual(0);
      expect(v.p.y - v.r).toBeGreaterThanOrEqual(0);
    }
  });

  it("rival en la esquina opuesta: último recurso por delante, pero sin solapes", () => {
    const m = emptyArena();
    m.spawns = [
      { team: "red", position: { x: 3, y: 3 }, heading: Math.PI / 4 },
      { team: "blue", position: { x: 117, y: 77 }, heading: (-3 * Math.PI) / 4 },
    ];
    const { out } = place(m);
    expect(minGap(out)).toBeGreaterThanOrEqual(1 - 1e-4);
  });

  it("la búsqueda amplia sólo entra cuando atrás/lados no tiene hueco (orden: atrás antes que delante)", () => {
    const cs = wideSpawnCandidates([{ position: { x: 50, y: 50 }, heading: 0 }], 4, 1);
    // Anillo 1 completo = 8 posiciones; la primera es la de más atrás (b=+1), la última por delante.
    expect(cs).toHaveLength(8);
    expect(cs[0].position).toEqual({ x: 46, y: 50 });
    expect(cs[cs.length - 1].position.x).toBe(54);
    // Arena abierta: chooseSpawn devuelve el mismo auxiliar atrás/lados de siempre.
    const m = emptyArena();
    const pick = chooseSpawn({
      pool: [{ position: { x: 20, y: 40 }, heading: 0 }],
      startIndex: 0,
      radiusM: 1.6,
      radiusMaxM: 1.6,
      occupied: [{ position: { x: 20, y: 40 }, radiusM: 1.6 }],
      reserved: [],
      map: m,
    });
    expect(pick!.position.x).toBeLessThanOrEqual(20);
  });
});
