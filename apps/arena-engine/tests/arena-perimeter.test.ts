/**
 * UX-07 / C6 · La arena TIENE perímetro, lo declare el mapa o no.
 *
 * Hallazgo de producción: `maps/mvp-arena-01.json` sólo declara 3 muros interiores,
 * `toEngineMap` no añade bordes y el motor no limitaba nada a `widthM`×`heightM`:
 * en una batalla real los vehículos aparecieron en x=−26/165, y=−43/94 sobre un
 * mapa de 120×80. Los fixtures del motor (`mvpArena`, `emptyArena`) sí traen cuatro
 * muros de perímetro escritos a mano, y por eso ningún test lo había visto: el mapa
 * de juguete tapaba el defecto del mapa real.
 *
 * Por eso aquí se juega SIEMPRE sobre mapas SIN perímetro declarado: el documento
 * real del catálogo pasado por `toEngineMap` (exactamente lo que ejecuta la API) y
 * un mapa abierto sin un solo muro (lo mínimo que puede guardar el editor).
 *
 * Contrato (sim/battle.ts · `addArenaBoundary`):
 *   - ningún vehículo sale de [0,widthM]×[0,heightM] contando su radio;
 *   - un proyectil que llega al borde impacta en el perímetro y desaparece.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Battle, type BotAgent } from "../src/sim/battle.js";
import { initPhysics } from "../src/sim/physics.js";
import type { ArenaMap } from "../src/sim/modes.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { gunnerLoadout, sandbagLoadout } from "../src/fixtures.js";
import { validateArenaMap } from "../src/arena-map.js";
import { toEngineMap } from "../../map-service/src/to-engine-map.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const realMap = (file: string): ArenaMap =>
  toEngineMap(JSON.parse(readFileSync(join(REPO, "maps", file), "utf8")));

/** Mapa sin muros de ningún tipo: lo que guarda el editor si el usuario no dibuja nada. */
function openMap(w: number, h: number): ArenaMap {
  return {
    mapId: "open-no-walls",
    version: 1,
    checksum: "sha256:" + "0".repeat(64),
    widthM: w,
    heightM: h,
    walls: [],
    destructibles: [],
    spawns: [
      { team: "red", position: { x: w * 0.25, y: h * 0.4 }, heading: 0 },
      { team: "red", position: { x: w * 0.25, y: h * 0.6 }, heading: 0 },
      { team: "blue", position: { x: w * 0.75, y: h * 0.4 }, heading: Math.PI },
      { team: "blue", position: { x: w * 0.75, y: h * 0.6 }, heading: Math.PI },
    ],
    bases: [],
    flags: [],
    zones: [],
  };
}

/** 10 minutos simulados a 30 Hz. */
const TEN_MINUTES_TICKS = 18_000;
/**
 * Penetración máxima tolerada en el perímetro (m). Rapier resuelve contactos con
 * un margen de solapamiento de milímetros; 5 cm es dos órdenes de magnitud por
 * encima de eso y dos por debajo de lo observado en producción (26 m).
 */
const TOLERANCE_M = 0.05;

function norm(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Conduce a fondo hacia un punto, girando hacia él. */
function driveTowards(obs: any, target: { x: number; y: number }) {
  const p = obs.self.position;
  const want = Math.atan2(target.y - p.y, target.x - p.x);
  const diff = norm(want - obs.self.heading);
  return { forTick: obs.tick, move: { throttle: 1, steer: Math.max(-1, Math.min(1, diff * 3)) } };
}

/**
 * Recorre en bucle una lista de objetivos FUERA del mapa (bordes y esquinas), cambiando
 * cada `period` ticks: se estrella de frente, en diagonal y contra las esquinas.
 */
class EdgeRunner implements BotAgent {
  constructor(
    readonly botId: string,
    private targets: { x: number; y: number }[],
    private period: number,
  ) {}
  decide(obs: any) {
    const i = Math.floor(obs.tick / this.period) % this.targets.length;
    return driveTowards(obs, this.targets[i]);
  }
}

/**
 * Empujador: persigue la posición REAL de otro vehículo (leída del mundo físico, no de
 * sus sensores, que el saco de arena no tiene) y sigue de largo, aplastándolo contra
 * el borde. Es la prueba de "un vehículo empuja a otro fuera".
 */
class Pusher implements BotAgent {
  constructor(
    readonly botId: string,
    private battle: () => Battle,
    private victimId: string,
  ) {}
  decide(obs: any) {
    const v = this.battle().getPhysics().pose(this.victimId);
    if (!v) return { forTick: obs.tick };
    const p = obs.self.position;
    // Apunta a un punto 50 m más allá de la víctima, en la recta empujador→víctima.
    const ang = Math.atan2(v.position.y - p.y, v.position.x - p.x);
    return driveTowards(obs, { x: v.position.x + Math.cos(ang) * 50, y: v.position.y + Math.sin(ang) * 50 });
  }
}

function outsideTargets(w: number, h: number) {
  const far = 60;
  return [
    { x: w / 2, y: -far }, // sur, de frente
    { x: w + far, y: h / 2 }, // este
    { x: w / 2, y: h + far }, // norte
    { x: -far, y: h / 2 }, // oeste
    { x: -far, y: -far }, // esquinas, en diagonal
    { x: w + far, y: h + far },
    { x: w + far, y: -far },
    { x: -far, y: h + far },
  ];
}

interface Excursion {
  worst: number;
  worstAt: string;
  maxSpeed: number;
  ticks: number;
}

/**
 * Juega `ticks` ticks y mide, en CADA tick, cuánto se sale el borde exterior de cada
 * vehículo del rectángulo del mapa (positivo = fuera).
 */
function runAndMeasure(map: ArenaMap, ticks: number): Excursion {
  const ruleset = loadRuleset("tdm_mvp@1", { timeLimitTicks: ticks + 10, scoreToWin: 1e9 });
  const spec = sandbagLoadout(); // ruedas (13 m/s) y nada que dispare: nadie muere
  const battle = new Battle({
    battleId: "perimeter",
    seed: "perimeter-seed",
    ruleset,
    map,
    participants: [
      { id: "veh_1", botId: "b1", team: "red", spec },
      { id: "veh_2", botId: "b2", team: "red", spec },
      { id: "veh_3", botId: "b3", team: "blue", spec },
      { id: "veh_4", botId: "b4", team: "blue", spec },
    ],
  });
  const W = map.widthM;
  const H = map.heightM;
  const t = outsideTargets(W, H);
  // Dos corredores con fases distintas (y uno en sentido inverso) y dos empujadores
  // que persiguen a un corredor cada uno: hay empujes contra el borde y en las esquinas.
  battle.attachBot("veh_1", new EdgeRunner("b1", t, 240));
  battle.attachBot("veh_2", new EdgeRunner("b2", [...t].reverse(), 300));
  battle.attachBot("veh_3", new Pusher("b3", () => battle, "veh_1"));
  battle.attachBot("veh_4", new Pusher("b4", () => battle, "veh_2"));

  const r = spec.radiusM;
  let worst = -Infinity;
  let worstAt = "";
  let maxSpeed = 0;
  let n = 0;
  for (; n < ticks && !battle.isFinished(); n++) {
    battle.step();
    for (const v of battle.getVehicles()) {
      const p = battle.getPhysics().pose(v.id)!;
      const out = Math.max(-(p.position.x - r), p.position.x + r - W, -(p.position.y - r), p.position.y + r - H);
      if (out > worst) {
        worst = out;
        worstAt = `${v.id}@tick${battle.tick} (${p.position.x.toFixed(2)}, ${p.position.y.toFixed(2)})`;
      }
      maxSpeed = Math.max(maxSpeed, Math.hypot(p.velocity.x, p.velocity.y));
    }
  }
  battle.free();
  return { worst, worstAt, maxSpeed, ticks: n };
}

beforeAll(async () => {
  await initPhysics();
});

describe("UX-07 · perímetro implícito de la arena", () => {
  it("el mapa REAL del catálogo no declara perímetro (precondición: el test mide el caso de producción)", () => {
    const m = realMap("mvp-arena-01.json");
    expect(validateArenaMap(m).ok).toBe(true);
    // Ningún muro del documento toca los cuatro bordes: si alguien se lo añade al
    // JSON, este test deja de medir el motor y debe saberse.
    const touchesAllEdges =
      m.walls.some((w) => w.position.y - w.halfH <= 0 && w.halfW * 2 >= m.widthM) &&
      m.walls.some((w) => w.position.y + w.halfH >= m.heightM && w.halfW * 2 >= m.widthM);
    expect(touchesAllEdges).toBe(false);
  });

  it.each([
    ["mvp-arena-01 (documento real → toEngineMap)", () => realMap("mvp-arena-01.json")],
    ["mapa abierto sin muros 120×80", () => openMap(120, 80)],
  ])(
    "%s · 10 minutos simulados contra bordes, esquinas y empujes: nadie sale del mapa",
    (_label, mk) => {
      const map = mk();
      const res = runAndMeasure(map, TEN_MINUTES_TICKS);
      expect(res.ticks).toBe(TEN_MINUTES_TICKS);
      // Control positivo: de verdad se fue a velocidad máxima de ruedas (13 m/s).
      expect(res.maxSpeed).toBeGreaterThan(12.5);
      expect(res.worst, `peor salida ${res.worst.toFixed(3)} m en ${res.worstAt}`).toBeLessThanOrEqual(TOLERANCE_M);
    },
    120_000,
  );

  it("mapas pequeños y alargados también quedan cerrados (no depende de 120×80)", () => {
    for (const [w, h] of [
      [30, 20],
      [200, 40],
    ]) {
      const res = runAndMeasure(openMap(w, h), 3_000);
      expect(res.worst, `mapa ${w}×${h}: peor ${res.worst.toFixed(3)} m en ${res.worstAt}`).toBeLessThanOrEqual(
        TOLERANCE_M,
      );
    }
  }, 60_000);

  it("los proyectiles que llegan al borde impactan en el perímetro y desaparecen", () => {
    const map = openMap(120, 80);
    const ruleset = loadRuleset("tdm_mvp@1", { timeLimitTicks: 1_000, scoreToWin: 1e9 });
    const battle = new Battle({
      battleId: "perimeter-proj",
      seed: "perimeter-proj",
      ruleset,
      map,
      participants: [
        { id: "veh_1", botId: "b1", team: "red", spec: gunnerLoadout() },
        { id: "veh_2", botId: "b2", team: "blue", spec: sandbagLoadout() },
      ],
    });
    // El artillero gira sobre sí mismo con la torreta alineada al morro (siempre dentro
    // del arco) y dispara sin parar: barre los cuatro bordes.
    const slots = gunnerLoadout()
      .modules.filter((m) => m.category === "weapon")
      .map((m) => m.slot);
    expect(slots.length).toBeGreaterThan(0);
    battle.attachBot("veh_1", {
      botId: "b1",
      decide: (obs: any) => ({
        forTick: obs.tick,
        move: { throttle: 0, steer: 0.4 },
        turret: { targetHeading: obs.self.heading },
        fire: slots,
      }),
    });
    battle.attachBot("veh_2", { botId: "b2", decide: (obs: any) => ({ forTick: obs.tick }) });

    let seen = 0;
    let outside = 0;
    for (let i = 0; i < 600; i++) {
      battle.step();
      for (const p of battle.getPublicSnapshot().projectiles ?? []) {
        seen++;
        const { x, y } = p.position;
        if (x < -TOLERANCE_M || x > map.widthM + TOLERANCE_M || y < -TOLERANCE_M || y > map.heightM + TOLERANCE_M) {
          outside++;
        }
      }
    }
    battle.free();
    expect(seen, "control positivo: hubo proyectiles en vuelo").toBeGreaterThan(0);
    expect(outside).toBe(0);
  });
});
