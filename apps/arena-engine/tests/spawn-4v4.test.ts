/**
 * 4v4 · Colocación de spawns sobre el MAPA REAL (motor 0.3.0).
 *
 * El mapa es `maps/mvp-arena-01.json` pasado por `toEngineMap`, igual que en
 * producción (map-service → worker → motor). NO se modifica el mapa: tiene 2 spawns
 * por bando y el arreglo genera posiciones auxiliares seguras alrededor de ellos.
 *
 * Contra el motor 0.2.0 este fichero se pone ROJO: con 4 por bando el reparto era
 * cíclico (pares exactamente superpuestos, ~30 ticks de empujones de Rapier) y con
 * etiquetas A/B los dos bandos nacían encima en spawns[0..].
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { loadCatalog } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../../packages/module-catalog/resolve/archetypes.js";
import { toEngineMap } from "../../map-service/src/to-engine-map.js";
import { Battle, type Participant } from "../src/sim/battle.js";
import type { ArenaMap } from "../src/sim/modes.js";
import { initPhysics } from "../src/sim/physics.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../src/fixtures.js";
import { HunterBot, IdleBot } from "../src/stubs.js";
import type { VehicleSpec } from "../src/sim/vehicle.js";

const MARGIN_M = 1;
const EPS = 1e-4;

beforeAll(async () => {
  await initPhysics();
});

function realMap(): ArenaMap {
  const internal = JSON.parse(readFileSync(new URL("../../../maps/mvp-arena-01.json", import.meta.url), "utf8"));
  return toEngineMap(internal);
}

function heavy(): VehicleSpec {
  return resolveVehicle((ARCHETYPES as any).heavy, loadCatalog());
}

/** veh_1..veh_n alternando bandos: el orden en que el worker crea los vehículos. */
function roster(n: number, teams: [string, string], specs: (() => VehicleSpec)[]): Participant[] {
  const out: Participant[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `veh_${i + 1}`, botId: `bot_${i + 1}`, team: teams[i % 2], spec: specs[i % specs.length]() });
  }
  return out;
}

function makeBattle(participants: Participant[], map = realMap(), rulesetId = "tdm_mvp@1", overrides: any = {}) {
  const b = new Battle({
    battleId: "spawn-4v4",
    seed: "spawn-seed",
    ruleset: loadRuleset(rulesetId, overrides),
    map,
    participants,
  });
  for (const p of participants) b.attachBot(p.id, new IdleBot(p.botId));
  return b;
}

function positions(b: Battle) {
  const phys = b.getPhysics();
  return b.getVehicles().map((v) => ({ v, p: phys.pose(v.id)!.position }));
}

function minGap(b: Battle): number {
  const ps = positions(b);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) {
      const d = Math.hypot(ps[i].p.x - ps[j].p.x, ps[i].p.y - ps[j].p.y);
      min = Math.min(min, d - ps[i].v.spec.radiusM - ps[j].v.spec.radiusM);
    }
  return min;
}

function distToBox(p: { x: number; y: number }, c: { x: number; y: number }, hw: number, hh: number, rot = 0) {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const lx = dx * Math.cos(-rot) - dy * Math.sin(-rot);
  const ly = dx * Math.sin(-rot) + dy * Math.cos(-rot);
  return Math.hypot(Math.max(Math.abs(lx) - hw, 0), Math.max(Math.abs(ly) - hh, 0));
}

const CASES: { name: string; teams: [string, string]; specs: (() => VehicleSpec)[] }[] = [
  { name: "red/blue · gunner", teams: ["red", "blue"], specs: [gunnerLoadout] },
  { name: "red/blue · heavy+scout (radio máx 2,0 m)", teams: ["red", "blue"], specs: [heavy, scoutLoadout] },
  { name: "A/B (torneo) · gunner", teams: ["A", "B"], specs: [gunnerLoadout] },
];

describe("4v4 TDM sobre mvp-arena-01 real · spawns", () => {
  for (const c of CASES) {
    it(`${c.name}: sin solapes, dentro del mapa, fuera de muros y ácido, sin daño ni empujones`, () => {
      const map = realMap();
      const b = makeBattle(roster(8, c.teams, c.specs), map);
      const start = new Map(positions(b).map(({ v, p }) => [v.id, { ...p }]));

      // Tick 0: separación >= margen entre TODO par (aliados y rivales).
      expect(minGap(b)).toBeGreaterThanOrEqual(MARGIN_M - EPS);

      for (const { v, p } of positions(b)) {
        const r = v.spec.radiusM;
        expect(p.x - r).toBeGreaterThanOrEqual(0);
        expect(p.y - r).toBeGreaterThanOrEqual(0);
        expect(p.x + r).toBeLessThanOrEqual(map.widthM);
        expect(p.y + r).toBeLessThanOrEqual(map.heightM);
        for (const w of map.walls)
          expect(distToBox(p, w.position, w.halfW, w.halfH, w.rotation ?? 0)).toBeGreaterThan(r);
        for (const d of map.destructibles) expect(distToBox(p, d.position, d.halfW, d.halfH)).toBeGreaterThan(r);
        for (const z of map.zones.filter((z) => z.kind === "damage")) {
          expect(Math.hypot(p.x - z.position.x, p.y - z.position.y)).toBeGreaterThan(z.radiusM + r);
        }
      }

      // 90 ticks (3 s) con bots quietos: nadie se mueve, nadie recibe daño.
      for (let t = 0; t < 90; t++) b.step();
      expect(minGap(b)).toBeGreaterThanOrEqual(MARGIN_M - EPS);
      for (const { v, p } of positions(b)) {
        const s = start.get(v.id)!;
        expect(Math.hypot(p.x - s.x, p.y - s.y)).toBeLessThan(0.01);
        expect(v.hullHp).toBe(v.spec.hullHp);
        expect(v.alive).toBe(true);
      }
      expect(b.publicEvents.filter((e) => e.kind === "vehicle_destroyed" || e.kind === "hit_taken")).toEqual([]);
      b.free();
    });

    it(`${c.name}: cada bando nace en su lado y ningún auxiliar nace por delante de su spawn base`, () => {
      const map = realMap();
      const b = makeBattle(roster(8, c.teams, c.specs), map);
      const [t0, t1] = c.teams;
      const xs = (t: string) =>
        positions(b)
          .filter(({ v }) => v.team === t)
          .map(({ p }) => p.x);
      // mvp-arena-01: red a la izquierda (x≈10), blue a la derecha (x≈110). A cae en
      // red y B en blue (orden de los grupos del mapa).
      expect(Math.max(...xs(t0))).toBeLessThan(map.widthM / 2);
      expect(Math.min(...xs(t1))).toBeGreaterThan(map.widthM / 2);
      // "Por delante" = proyección sobre el heading del spawn base más cercano.
      for (const { v, p } of positions(b)) {
        const side = v.team === t0 ? "red" : "blue";
        const bases = map.spawns.filter((s) => s.team === side);
        const near = bases.reduce((a, s) =>
          Math.hypot(s.position.x - p.x, s.position.y - p.y) < Math.hypot(a.position.x - p.x, a.position.y - p.y)
            ? s
            : a,
        );
        const ahead =
          (p.x - near.position.x) * Math.cos(near.heading) + (p.y - near.position.y) * Math.sin(near.heading);
        expect(ahead).toBeLessThanOrEqual(EPS);
      }
      b.free();
    });
  }

  it("es determinista: dos construcciones dan exactamente las mismas posiciones", () => {
    const a = makeBattle(roster(8, ["red", "blue"], [heavy, scoutLoadout]));
    const b = makeBattle(roster(8, ["red", "blue"], [heavy, scoutLoadout]));
    expect(positions(a).map(({ v, p }) => [v.id, p.x, p.y])).toEqual(positions(b).map(({ v, p }) => [v.id, p.x, p.y]));
    expect(a.stateHash()).toBe(b.stateHash());
    a.free();
    b.free();
  });
});

describe("Etiquetas desconocidas (torneos A/B) · 1v1 y 2v2", () => {
  for (const n of [2, 4]) {
    it(`${n / 2}v${n / 2} A/B: cada bando en un grupo de spawns distinto, sin solapes`, () => {
      const map = realMap();
      const b = makeBattle(roster(n, ["A", "B"], [gunnerLoadout]), map, "tdm_mvp@1");
      expect(minGap(b)).toBeGreaterThanOrEqual(MARGIN_M - EPS);
      const ps = positions(b);
      const A = ps.filter(({ v }) => v.team === "A").map(({ p }) => p);
      const B = ps.filter(({ v }) => v.team === "B").map(({ p }) => p);
      // A ocupa exactamente los spawns red del mapa; B los blue.
      const red = map.spawns
        .filter((s) => s.team === "red")
        .slice(0, n / 2)
        .map((s) => s.position);
      const blue = map.spawns
        .filter((s) => s.team === "blue")
        .slice(0, n / 2)
        .map((s) => s.position);
      expect(A).toEqual(red);
      expect(B).toEqual(blue);
      b.free();
    });
  }

  it("1v1 DM de torneo A/B: ya no nacen uno encima del otro", () => {
    const b = makeBattle(roster(2, ["A", "B"], [gunnerLoadout]), realMap(), "dm_practice@1");
    expect(minGap(b)).toBeGreaterThan(50);
    b.free();
  });
});

describe("1v1 / 2v2 red/blue · comportamiento de 0.2.0 intacto", () => {
  it("1v1 red/blue: cada uno exactamente en el primer spawn de su bando", () => {
    const map = realMap();
    const b = makeBattle(roster(2, ["red", "blue"], [gunnerLoadout]), map);
    const ps = positions(b);
    expect(ps[0].p).toEqual(map.spawns.find((s) => s.team === "red")!.position);
    expect(ps[1].p).toEqual(map.spawns.find((s) => s.team === "blue")!.position);
    b.free();
  });

  it("2v2 red/blue: los cuatro spawns del mapa, en el orden de 0.2.0", () => {
    const map = realMap();
    const b = makeBattle(roster(4, ["red", "blue"], [gunnerLoadout]), map);
    const ps = positions(b).map(({ p }) => p);
    const red = map.spawns.filter((s) => s.team === "red").map((s) => s.position);
    const blue = map.spawns.filter((s) => s.team === "blue").map((s) => s.position);
    expect(ps).toEqual([red[0], blue[0], red[1], blue[1]]);
    b.free();
  });

  it("1v1 red/blue con combate y respawn: hash de 3000 ticks (arena abierta, hay muertes) idéntico al del motor 0.2.0 (e902b0a)", () => {
    const parts: Participant[] = [
      { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "b2", team: "blue", spec: gunnerLoadout() },
    ];
    const b = new Battle({
      battleId: "spawn-4v4",
      seed: "spawn-seed",
      ruleset: loadRuleset("tdm_mvp@1"),
      map: emptyArena(),
      participants: parts,
    });
    b.attachBot("veh_1", new HunterBot("b1"));
    b.attachBot("veh_2", new HunterBot("b2"));
    for (let t = 0; t < 3000 && !b.isFinished(); t++) b.step();
    // Hubo muertes (y por tanto respawns): el hash cubre también PASO 7.
    const score = (b as any).mode.score as Record<string, number>;
    expect(score.red + score.blue).toBeGreaterThan(0);
    // Medido con apps/arena-engine/src/sim/{battle,modes}.ts de e902b0a.
    expect(b.stateHash()).toBe(GOLDEN_1V1_HASH_E902B0A);
    b.free();
  });
});

describe("1v1 red/blue sobre mvp-arena-01 real · hash de 0.2.0", () => {
  it("HunterBot vs HunterBot, 3000 ticks: mismo hash que e902b0a", () => {
    const parts: Participant[] = [
      { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "b2", team: "blue", spec: gunnerLoadout() },
    ];
    const b = new Battle({
      battleId: "spawn-4v4",
      seed: "spawn-seed",
      ruleset: loadRuleset("tdm_mvp@1"),
      map: realMap(),
      participants: parts,
    });
    b.attachBot("veh_1", new HunterBot("b1"));
    b.attachBot("veh_2", new HunterBot("b2"));
    for (let t = 0; t < 3000 && !b.isFinished(); t++) b.step();
    expect(b.stateHash()).toBe(GOLDEN_1V1_REALMAP_HASH_E902B0A);
    b.free();
  });
});

describe("Respawn TDM · nunca encima de un vehículo", () => {
  it("si su spawn está ocupado por un vehículo vivo, reaparece en otro punto libre", () => {
    const map = realMap();
    const parts = roster(8, ["red", "blue"], [gunnerLoadout]);
    const b = makeBattle(parts, map, "tdm_mvp@1", { respawn: { enabled: true, delayTicks: 3 } });
    b.step();
    const phys = b.getPhysics();
    const victim = b.getVehicle("veh_1")!;
    // Todos los spawns red del mapa quedan TAPADOS por vehículos vivos (los rojos
    // veh_3/veh_5 se teletransportan encima): el punto de 0.2.0 (hash % pool) está
    // ocupado sea cual sea.
    const reds = map.spawns.filter((s) => s.team === "red");
    phys.get("veh_3")!.rb.setTranslation(reds[0].position, true);
    phys.get("veh_5")!.rb.setTranslation(reds[1].position, true);
    victim.alive = false;
    victim.hullHp = 0;
    for (let t = 0; t < 10 && !victim.alive; t++) b.step();
    expect(victim.alive).toBe(true);
    const vp = phys.pose("veh_1")!.position;
    for (const o of b.getVehicles()) {
      if (o.id === victim.id) continue;
      const op = phys.pose(o.id)!.position;
      expect(Math.hypot(vp.x - op.x, vp.y - op.y)).toBeGreaterThanOrEqual(victim.spec.radiusM + o.spec.radiusM);
    }
    // Y sigue en su lado del mapa.
    expect(vp.x).toBeLessThan(map.widthM / 2);
    b.free();
  });

  it("dos reapariciones en el mismo tick no eligen el mismo punto", () => {
    const map = realMap();
    const parts = roster(8, ["red", "blue"], [gunnerLoadout]);
    const b = makeBattle(parts, map, "tdm_mvp@1", { respawn: { enabled: true, delayTicks: 3 } });
    b.step();
    const phys = b.getPhysics();
    for (const id of ["veh_1", "veh_3", "veh_5", "veh_7"]) {
      const v = b.getVehicle(id)!;
      v.alive = false;
      v.hullHp = 0;
    }
    for (let t = 0; t < 10; t++) b.step();
    const reds = b.getVehicles().filter((v) => v.team === "red");
    expect(reds.every((v) => v.alive)).toBe(true);
    for (let i = 0; i < reds.length; i++)
      for (let j = i + 1; j < reds.length; j++) {
        const a = phys.pose(reds[i].id)!.position;
        const c = phys.pose(reds[j].id)!.position;
        expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeGreaterThanOrEqual(reds[i].spec.radiusM + reds[j].spec.radiusM);
      }
    b.free();
  });
});

const GOLDEN_1V1_HASH_E902B0A = "e40ee855cb479a2a5f05cc214f9309edd2f4e5611ce31b9d9552873ce8626794";
const GOLDEN_1V1_REALMAP_HASH_E902B0A = "6a9c139d094b1f8b6d933d6dfc9b6056d045ef6a9a9215066727759121c81abc";
