/**
 * [REVIEW-4v4] · Spawns 0.3.0 con mapas HOSTILES (no publicados): esquina, muro
 * pegado, zona de daño junto al spawn, spawn base dentro de una zona de daño y
 * mapa diminuto. Mide solapes, fuera de mapa, dentro de muro y determinismo.
 * Las aserciones son las propiedades que ADR-020 promete; los casos que el ADR
 * declara fuera de garantía (mapa saturado → reparto cíclico de 0.2.0; spawn
 * base del propio mapa) se fijan como tales para que no se lean como cubiertos.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { Battle, type Participant } from "../src/sim/battle.js";
import type { ArenaMap } from "../src/sim/modes.js";
import { initPhysics } from "../src/sim/physics.js";
import { emptyArena, gunnerLoadout } from "../src/fixtures.js";
import { IdleBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

function roster(n: number): Participant[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `veh_${i + 1}`,
    botId: `b${i + 1}`,
    team: i < n / 2 ? "blue" : "red", // agrupados por bando, como el worker con ORDER BY team
    spec: gunnerLoadout(),
  }));
}

function build(map: ArenaMap, n = 8) {
  const parts = roster(n);
  const b = new Battle({ battleId: "hostile", seed: "h", ruleset: loadRuleset("tdm_mvp@1"), map, participants: parts });
  for (const p of parts) b.attachBot(p.id, new IdleBot(p.botId));
  return b;
}

function distToBox(p: { x: number; y: number }, c: { x: number; y: number }, hw: number, hh: number, rot = 0) {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const lx = dx * Math.cos(-rot) - dy * Math.sin(-rot);
  const ly = dx * Math.sin(-rot) + dy * Math.cos(-rot);
  return Math.hypot(Math.max(Math.abs(lx) - hw, 0), Math.max(Math.abs(ly) - hh, 0));
}

function measure(b: Battle, map: ArenaMap) {
  const phys = b.getPhysics();
  const ps = b.getVehicles().map((v) => ({ v, p: phys.pose(v.id)!.position }));
  let minGap = Infinity;
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++)
      minGap = Math.min(
        minGap,
        Math.hypot(ps[i].p.x - ps[j].p.x, ps[i].p.y - ps[j].p.y) - ps[i].v.spec.radiusM - ps[j].v.spec.radiusM,
      );
  const outside = ps.filter(
    ({ v, p }) =>
      p.x - v.spec.radiusM < 0 ||
      p.y - v.spec.radiusM < 0 ||
      p.x + v.spec.radiusM > map.widthM ||
      p.y + v.spec.radiusM > map.heightM,
  ).length;
  const inWall = ps.filter(({ v, p }) =>
    map.walls.some((w) => distToBox(p, w.position, w.halfW, w.halfH, w.rotation ?? 0) < v.spec.radiusM),
  ).length;
  const inAcid = ps.filter(({ v, p }) =>
    map.zones.some(
      (z) => z.kind === "damage" && Math.hypot(p.x - z.position.x, p.y - z.position.y) < z.radiusM + v.spec.radiusM,
    ),
  ).length;
  return { minGap, outside, inWall, inAcid, positions: ps.map(({ v, p }) => [v.id, p.x, p.y]) };
}

const HOSTILE: Record<string, () => ArenaMap> = {
  corner: () => {
    const m = emptyArena();
    m.spawns = [
      { team: "red", position: { x: 3, y: 3 }, heading: Math.PI / 4 },
      { team: "blue", position: { x: 117, y: 77 }, heading: (-3 * Math.PI) / 4 },
    ];
    return m;
  },
  wallBeside: () => {
    const m = emptyArena();
    m.walls.push({ id: "w_side_r", position: { x: 20, y: 44 }, halfW: 6, halfH: 0.5 });
    m.walls.push({ id: "w_side_b", position: { x: 100, y: 36 }, halfW: 6, halfH: 0.5 });
    m.walls.push({ id: "w_rot", position: { x: 14, y: 36 }, halfW: 4, halfH: 0.5, rotation: Math.PI / 4 });
    return m;
  },
  acidBeside: () => {
    const m = emptyArena();
    m.zones.push({ id: "acid_r", position: { x: 20, y: 46 }, radiusM: 4, kind: "damage", damagePerSecond: 20 });
    m.zones.push({ id: "acid_b", position: { x: 100, y: 34 }, radiusM: 4, kind: "damage", damagePerSecond: 20 });
    return m;
  },
};

describe("[REVIEW-4v4] spawns en mapas hostiles", () => {
  for (const [name, mk] of Object.entries(HOSTILE)) {
    // DEFECTO (REVIEW-4v4): spawn en esquina con heading diagonal hacia dentro. La
    // rejilla auxiliar sólo mira atrás y a los lados, que en una esquina caen TODOS
    // fuera del mapa: chooseSpawn devuelve null y battle.ts vuelve al reparto
    // cíclico de 0.2.0 ⇒ pares con los centros coincidentes (hueco -3,2 m). `fails`
    // se pondrá ROJO cuando se arregle: entonces se quita.
    const run = name === "corner" ? it.fails : it;
    run(`${name}: 4v4 sin solapes, dentro del mapa, fuera de muros y ácido; determinista`, () => {
      const map = mk();
      const a = build(map);
      const b = build(mk());
      const ma = measure(a, map);
      const mb = measure(b, map);
      console.log(`[REVIEW-4v4] ${name}`, JSON.stringify({ ...ma, positions: undefined }));
      expect(ma.positions).toEqual(mb.positions);
      expect(a.stateHash()).toBe(b.stateHash());
      expect(ma.minGap).toBeGreaterThanOrEqual(1 - 1e-4);
      expect(ma.outside).toBe(0);
      expect(ma.inWall).toBe(0);
      expect(ma.inAcid).toBe(0);
      a.free();
      b.free();
    });
  }

  it("mapa diminuto 14x14 (fuera de garantía, ADR-020: reparto cíclico de 0.2.0): se mide y se fija", () => {
    const m = emptyArena(14, 14);
    m.spawns = [
      { team: "red", position: { x: 3.5, y: 7 }, heading: 0 },
      { team: "blue", position: { x: 10.5, y: 7 }, heading: Math.PI },
    ];
    const b = build(m);
    const r = measure(b, m);
    console.log("[REVIEW-4v4] tiny", JSON.stringify({ ...r, positions: undefined }));
    // Sin hueco: hay solapes (el fallback no es «seguro»). Se fija para que nadie
    // lea ADR-020 como una garantía universal.
    expect(r.minGap).toBeLessThan(0);
    b.free();
  });

  it("spawn BASE dentro de una zona de daño: el motor no lo valida (es del mapa) y se nace en ácido", () => {
    const m = emptyArena();
    m.zones.push({ id: "acid_on_spawn", position: { x: 20, y: 40 }, radiusM: 3, kind: "damage", damagePerSecond: 20 });
    const b = build(m, 2);
    const r = measure(b, m);
    console.log("[REVIEW-4v4] baseInAcid", JSON.stringify({ ...r, positions: undefined }));
    expect(r.inAcid).toBe(1);
    b.free();
  });
});
