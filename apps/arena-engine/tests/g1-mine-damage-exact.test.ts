/**
 * OLA 2 · G1 · Daño y radio de explosión de la MINA con valores EXACTOS.
 *
 * Hasta G1 el daño (`mine.damage`) y el radio de explosión (`mine.explosionRadiusM`) de la
 * mina sólo tenían controles gruesos (C-MINE-1: «el hp baja») y el gate CATALOG_CONTRACT, que
 * tras el hash v2 de MD los daba por usados con sólo copiarlos a la mina (mutante M12 de MC
 * vivo). Este fichero fija los números, por datos del catálogo y por la frontera real
 * (resolveVehicle):
 *
 *   base     = mine.damage · max(0, 1 − d / mine.explosionRadiusM)   (explosionFalloff)
 *   casco    = base · CHASSIS_DAMAGE_SHARE (víctima sin blindaje: sin reducción)
 *   detona   ⇔ d ≤ mine.triggerRadiusM, en el tick de siembra + mine.armDelayTicks
 *
 * Escenario estático: el minador (rojo) siembra en el tick 0 en (20, 40) y no se mueve; las
 * víctimas (azules, IdleBot, sin blindaje) están a distancias EXACTAS del centro de la mina
 * (los vehículos no cortan la línea de visión, sólo muros). Para que una víctima inmóvil a
 * 5 m dispare la mina, el catálogo de la prueba ensancha triggerRadiusM (copia en memoria;
 * data/ no se toca). Todo se elige por categoría y ranura, nunca por id de módulo.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CHASSIS_DAMAGE_SHARE, loadRuleset } from "../../../packages/game-rules/index.js";
import { CATALOG_VERSION, loadCatalog } from "../../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import type { LoadoutInput, ModuleDefinition } from "../../../packages/module-catalog/types.js";
import { Battle } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import { emptyArena } from "../src/fixtures.js";
import { IdleBot } from "../src/stubs.js";

beforeAll(async () => {
  await initPhysics();
});

const REAL = loadCatalog();
const ref = (m: ModuleDefinition) => `${m.id}@${m.version}`;
/** La mina del catálogo (por categoría; hoy hay una). */
const MINE = REAL.find((m) => m.category === "mine")!;

/** Catálogo con la mina cambiada (copia en memoria). */
function withMine(over: Partial<ModuleDefinition>): ModuleDefinition[] {
  return REAL.map((m) => (m === MINE ? ({ ...structuredClone(m), ...over } as ModuleDefinition) : m));
}

const MINER: LoadoutInput = {
  loadoutId: "ldt_g1mine1",
  revision: 1,
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.medium@1",
  modules: [
    { slot: "drive", moduleId: "movement.tracks@1" },
    { slot: "power", moduleId: "power.generator@1" },
    { slot: "mine_bay", moduleId: ref(MINE) },
  ],
};
/** Víctima SIN blindaje: el importe efectivo es la base (reducción 0). */
const VICTIM: LoadoutInput = {
  loadoutId: "ldt_g1mine2",
  revision: 1,
  catalogVersion: CATALOG_VERSION,
  chassis: "chassis.light@1",
  modules: [
    { slot: "drive", moduleId: "movement.wheels@1" },
    { slot: "power", moduleId: "power.battery@1" },
  ],
};

const MINE_AT = { x: 20, y: 40 };

interface Outcome {
  /** Tick en el que se sembró (decisión del tick 0). */
  deployTick: number | null;
  /** Tick de la detonación (evento mine_triggered), o null. */
  detonationTick: number | null;
  minePos: { x: number; y: number } | null;
  /** Registros de daño de origen «deployable», por víctima. */
  records: Map<string, { base: number; effective: number; hull: number; reduction: number; tick: number }[]>;
  /** Distancia REAL víctima ↔ centro de la mina en la detonación. */
  dist: Map<string, number>;
  hullLost: Map<string, number>;
  minesLeft: number;
}

/** Víctimas a `offsets` (vectores desde el centro de la mina). */
function run(catalog: ModuleDefinition[], offsets: { x: number; y: number }[], ticks = 60): Outcome {
  const map = emptyArena(120, 80);
  map.spawns = [
    { team: "red", position: MINE_AT, heading: 0 },
    ...offsets.map((o) => ({ team: "blue", position: { x: MINE_AT.x + o.x, y: MINE_AT.y + o.y }, heading: 0 })),
  ];
  const victims = offsets.map((_, i) => `veh_${i + 2}`);
  const b = new Battle({
    battleId: "g1_mine_exact",
    seed: "g1-mine-exact",
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 100000, scoreToWin: 999 }),
    map,
    participants: [
      { id: "veh_1", botId: "bM", team: "red", spec: resolveVehicle(MINER, catalog) },
      ...victims.map((id, i) => ({
        id,
        botId: `bV${i}`,
        team: "blue",
        spec: resolveVehicle({ ...VICTIM, loadoutId: `ldt_g1v${i}` }, catalog),
      })),
    ],
  });
  let deployTick: number | null = null;
  let detonationTick: number | null = null;
  b.attachBot("veh_1", {
    botId: "bM",
    decide: (obs: any) => ({ forTick: obs.tick, ...(obs.tick === 0 ? { deployMine: { slot: "mine_bay" } } : {}) }),
    // Los eventos llegan en la siguiente decisión pero llevan el tick en que ocurrieron.
    onEvent: (e: any) => {
      if (e.kind === "mine_deployed" && deployTick === null) deployTick = e.tick;
      if (e.kind === "mine_triggered" && detonationTick === null) detonationTick = e.tick;
    },
  } as any);
  victims.forEach((id, i) => b.attachBot(id, new IdleBot(`bV${i}`)));
  const hull0 = new Map(victims.map((id) => [id, b.getVehicle(id)!.hullHp]));
  const records: Outcome["records"] = new Map(victims.map((id) => [id, []]));
  const dist = new Map<string, number>();
  let minePos: Outcome["minePos"] = null;
  try {
    for (let t = 0; t < ticks; t++) {
      const before = b.getMines()[0];
      if (before) minePos = { ...before.position };
      b.step();
      for (const r of b.damageRecordsOfLastTick()) {
        if (r.sourceKind !== "deployable") continue;
        records.get(r.target)!.push({
          base: r.base,
          effective: r.effective,
          hull: r.hull,
          reduction: r.reduction,
          tick: r.tick,
        });
        const p = b.getPhysics().pose(r.target)!.position;
        dist.set(r.target, Math.hypot(p.x - minePos!.x, p.y - minePos!.y));
      }
    }
    // El reparto de spawns entre vehículos del mismo equipo no es por orden: las víctimas se
    // identifican por su distancia REAL al centro de la mina (no se mueven).
    const at = (id: string) => {
      const p = b.getPhysics().pose(id)!.position;
      return Math.hypot(p.x - MINE_AT.x, p.y - MINE_AT.y);
    };
    const key = (id: string) => `${Math.round(at(id) * 1000) / 1000}m`;
    const rename = <T,>(m: Map<string, T>) => new Map([...m].map(([id, v]) => [key(id), v]));
    return {
      deployTick,
      detonationTick,
      minePos,
      records: rename(records),
      dist: rename(dist),
      hullLost: rename(new Map(victims.map((id) => [id, hull0.get(id)! - b.getVehicle(id)!.hullHp]))),
      minesLeft: b.getMines().length,
    };
  } finally {
    b.free();
  }
}

const DAMAGE = MINE.damage as number; // 90 en data/
const RADIUS = MINE.explosionRadiusM as number; // 6 en data/
const ARM = MINE.armDelayTicks as number; // 30 en data/

describe("G1 · mina: el escenario es el que dice ser", () => {
  it("datos del catálogo que fija este fichero (si cambian, revisar los números exactos)", () => {
    expect([DAMAGE, RADIUS, ARM, MINE.triggerRadiusM]).toEqual([90, 6, 30, 2.5]);
  });
  it("la mina se siembra en el centro previsto y las víctimas no se mueven", () => {
    const o = run(withMine({ triggerRadiusM: 6 }), [{ x: 5, y: 0 }]);
    expect(o.minePos).toEqual(MINE_AT);
    expect(o.dist.get("5m")).toBeCloseTo(5, 9);
  });
});

describe("G1 · mina: daño EXACTO = damage · (1 − d / explosionRadiusM)", () => {
  it("datos reales (90, R=6), víctima a 5 m: base 15, casco 15·0,7 = 10,5; víctima a 7 m (> R): nada", () => {
    const o = run(withMine({ triggerRadiusM: 6 }), [
      { x: 5, y: 0 },
      { x: 0, y: 7 },
    ]);
    const [r] = o.records.get("5m")!;
    expect(o.records.get("5m")!.length).toBe(1);
    expect(r.reduction).toBe(0);
    expect(r.base).toBeCloseTo(15, 9);
    expect(r.base).toBeCloseTo(DAMAGE * (1 - o.dist.get("5m")! / RADIUS), 12);
    expect(r.effective).toBeCloseTo(15, 9);
    expect(r.hull).toBeCloseTo(15 * CHASSIS_DAMAGE_SHARE, 9);
    expect(o.hullLost.get("5m")).toBeCloseTo(10.5, 9);
    expect(o.records.get("7m")).toEqual([]);
    expect(o.hullLost.get("7m")).toBe(0);
  });

  it("damage del catálogo ×2 (180): la misma víctima recibe exactamente el doble (30)", () => {
    const o = run(withMine({ triggerRadiusM: 6, damage: 180 }), [{ x: 5, y: 0 }]);
    expect(o.records.get("5m")!.map((r) => r.base)).toHaveLength(1);
    expect(o.records.get("5m")![0].base).toBeCloseTo(30, 9);
    expect(o.hullLost.get("5m")).toBeCloseTo(21, 9);
  });

  it("damage del catálogo 33: base 33·(1 − 5/6) = 5,5 (ningún valor por defecto del motor)", () => {
    const o = run(withMine({ triggerRadiusM: 6, damage: 33 }), [{ x: 5, y: 0 }]);
    expect(o.records.get("5m")![0].base).toBeCloseTo(5.5, 9);
  });
});

describe("G1 · mina: radio de explosión EXACTO", () => {
  it("explosionRadiusM 12: a 5 m base 90·(1 − 5/12) = 52,5 y a 7 m 90·(1 − 7/12) = 37,5", () => {
    const o = run(withMine({ triggerRadiusM: 6, explosionRadiusM: 12 }), [
      { x: 5, y: 0 },
      { x: 0, y: 7 },
    ]);
    expect(o.records.get("5m")![0].base).toBeCloseTo(52.5, 9);
    expect(o.records.get("7m")![0].base).toBeCloseTo(37.5, 9);
    expect(o.hullLost.get("7m")).toBeCloseTo(37.5 * CHASSIS_DAMAGE_SHARE, 9);
  });

  it("explosionRadiusM 5,5: a 5 m base 90·(1 − 5/5,5); a 5,5 m o más, nada (borde exclusivo)", () => {
    const o = run(withMine({ triggerRadiusM: 6, explosionRadiusM: 5.5 }), [
      { x: 5, y: 0 },
      { x: 0, y: 5.5 },
    ]);
    expect(o.records.get("5m")![0].base).toBeCloseTo(90 * (1 - 5 / 5.5), 9);
    expect(o.records.get("5.5m")).toEqual([]);
  });

  it("explosionRadiusM 4 (< d = 5): la mina detona pero no hace daño", () => {
    const o = run(withMine({ triggerRadiusM: 6, explosionRadiusM: 4 }), [{ x: 5, y: 0 }]);
    expect(o.detonationTick).not.toBeNull();
    expect(o.records.get("5m")).toEqual([]);
    expect(o.hullLost.get("5m")).toBe(0);
  });
});

describe("G1 · mina: disparo y armado exactos", () => {
  it("triggerRadiusM 4,9 con víctima a 5 m: no detona y la mina sigue en el terreno", () => {
    const o = run(withMine({ triggerRadiusM: 4.9 }), [{ x: 5, y: 0 }]);
    expect(o.detonationTick).toBeNull();
    expect(o.minesLeft).toBe(1);
    expect(o.records.get("5m")).toEqual([]);
  });

  it("triggerRadiusM 5,1 con víctima a 5 m: detona justo al armarse (siembra + armDelayTicks)", () => {
    const o = run(withMine({ triggerRadiusM: 5.1 }), [{ x: 5, y: 0 }]);
    expect(o.deployTick).not.toBeNull();
    expect(o.detonationTick).toBe(o.deployTick! + ARM);
    expect(o.minesLeft).toBe(0);
    expect(o.records.get("5m")![0].tick).toBe(o.deployTick! + ARM);
  });

  it("armDelayTicks 45: la detonación se retrasa exactamente a siembra + 45", () => {
    const o = run(withMine({ triggerRadiusM: 6, armDelayTicks: 45 }), [{ x: 5, y: 0 }], 80);
    expect(o.detonationTick).toBe(o.deployTick! + 45);
  });
});
