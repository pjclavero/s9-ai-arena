/**
 * OLA 2 · MA · Gate PUBLIC_PROJECTION_BOUNDARY (+ PUBLIC_ENTITY_IDS y PRIVATE_EQUIPMENT
 * sobre el canal REAL): ENGINE INTERNAL STATE → projectFrame() → espectador/broadcast.
 *
 * Batalla REAL del motor (un artillero y un minador que siembra en cada decisión) servida
 * por el gateway REAL a dos audiencias firmadas (`public_live` y `broadcast`). Se recoge
 * TODO lo que sale por el WebSocket y se parsea (no se cuenta texto):
 *  - ningún id interno del motor (veh_N, proj_N, mine_N) ni campo de equipamiento;
 *  - proyectiles densos p_1..p_K aunque el contador interno tenga huecos (#261);
 *  - mapper e historial por audiencia (mappingId distinto);
 *  - la proyección no toca la simulación: mismo finalStateHash con y sin gateway (F3:
 *    el visibilityEpoch vive en la proyección, nunca en el hash).
 * Calibración (mutantes en VM112): saltarse projectFrame en el pump ⇒ rojo; id público =
 * interno ⇒ rojo; epoch en el hash ⇒ rojo.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { WebSocket } from "ws";
import { SpectateGateway, spectateProtocols } from "./gateway.js";
import { signSpectateTicket, spectateTicketSecret, type SpectatorView } from "../auth/tokens.js";
import { Battle, type BattleConfig } from "../../../arena-engine/src/sim/battle.js";
import { initPhysics } from "../../../arena-engine/src/sim/physics.js";
import { emptyArena, gunnerLoadout, minerLoadout } from "../../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../../arena-engine/src/stubs.js";
import { loadRuleset } from "../../../../packages/game-rules/index.js";

beforeAll(async () => {
  process.env.ARENA_DEV_INSECURE_SECRETS ??= "1";
  await initPhysics();
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/**
 * Caza y, además, intenta sembrar una mina en cada decisión.
 * OJO (defecto del motor, lo corrige MC en su rama): `resolveFiring` hace `continue` si el
 * comando no trae `fire` no vacío, así que `deployMine` sólo se procesa junto a un disparo.
 * Por eso el minador siempre incluye `fire` (aunque el arma se rechace por cadencia/munición).
 * Cuando MC integre su corrección el test sigue siendo válido.
 */
class MinerHunter extends HunterBot {
  decide(obs: any) {
    const c = (super.decide(obs) ?? {}) as Record<string, unknown>;
    const fire = Array.isArray(c.fire) && c.fire.length ? c.fire : ["turret_main"];
    return { ...c, fire, deployMine: { slot: "mine_bay", armDelayTicks: 0 } };
  }
}

const TICKS = 360;

function config(battleId: string): BattleConfig {
  return {
    battleId,
    seed: "ma-boundary-seed",
    ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: TICKS }),
    map: emptyArena(40, 30),
    participants: [
      { id: "veh_1", botId: "bot-gunner", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "bot-miner", team: "blue", spec: minerLoadout() },
    ],
  };
}

async function battle(battleId: string): Promise<Battle> {
  const b = await Battle.create(config(battleId));
  b.attachBot("veh_1", new HunterBot("bot-gunner"));
  b.attachBot("veh_2", new MinerHunter("bot-miner"));
  cleanups.push(() => b.free());
  return b;
}

function connect(gw: SpectateGateway, battleId: string, view: SpectatorView) {
  const ticket = signSpectateTicket({ battleId, jti: randomUUID(), anon: true, view }, 60);
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/spectate/${battleId}`, spectateProtocols(ticket));
  cleanups.push(() => ws.terminate());
  const got: any[] = [];
  ws.on("message", (d) => got.push(JSON.parse(String(d))));
  return new Promise<{ got: any[]; ws: WebSocket }>((resolve, reject) => {
    ws.once("open", () => resolve({ got, ws }));
    ws.once("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function strings(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) for (const v of x) strings(v, out);
  else if (x && typeof x === "object")
    for (const [k, v] of Object.entries(x)) {
      out.push(k);
      strings(v, out);
    }
  return out;
}

function keysDeep(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) for (const v of x) keysDeep(v, out);
  else if (x && typeof x === "object")
    for (const [k, v] of Object.entries(x)) {
      out.add(k);
      keysDeep(v, out);
    }
  return out;
}

const INTERNAL_ID = /^(veh|proj|mine)_\d+$/;
const EQUIPMENT_KEYS = ["hullHp", "hullHpMax", "modules", "chassis", "spec", "loadout", "ownerId", "versions"];

describe("PUBLIC_PROJECTION_BOUNDARY · directo y broadcast sólo por projectFrame()", () => {
  it("todo lo que sale por el WebSocket está proyectado por audiencia; nada del motor sale crudo", async () => {
    const id = "ma-boundary-live";
    const b = await battle(id);
    const gw = new SpectateGateway({ publicSpectateEnabled: true });
    cleanups.push(() => gw.close());
    gw.attachBattle(id, b, {
      pollIntervalMs: 5,
      roster: [
        { id: "veh_1", botId: "bot-gunner", team: "red", chassis: "chassis.medium@2" },
        { id: "veh_2", botId: "bot-miner", team: "blue", chassis: "chassis.light@2" },
      ],
      meta: { mode: "deathmatch", secretThing: "no-sale" },
    });
    const live = await connect(gw, id, "public_live");
    const bcast = await connect(gw, id, "broadcast");

    // Control positivo: el frame INTERNO sí lleva minas, ids internos con huecos y equipamiento.
    let internalMines = 0;
    const internalProjectileSeqs = new Set<number>();
    while (!b.isFinished()) {
      for (let i = 0; i < 6 && !b.isFinished(); i++) b.step();
      await sleep(2);
    }
    for (const f of b.snapshots) {
      internalMines = Math.max(internalMines, f?.deployables?.length ?? 0);
      for (const p of f?.projectiles ?? []) internalProjectileSeqs.add(Number(String(p.id).split("_")[1]));
    }
    await sleep(150);
    expect(internalMines, "control: el minador sembró minas").toBeGreaterThan(0);
    expect(b.snapshots[0].vehicles[0]).toHaveProperty("hullHpMax");
    const seqs = [...internalProjectileSeqs].sort((x, y) => x - y);
    expect(seqs.length, "control: hubo proyectiles").toBeGreaterThan(1);
    expect(seqs.at(-1)! + 1, "control: el contador interno tiene huecos (minas)").toBeGreaterThan(seqs.length);

    for (const [label, c] of [
      ["public_live", live],
      ["broadcast", bcast],
    ] as const) {
      const msgs = c.got;
      expect(msgs[0].type, label).toBe("init");
      expect(
        msgs.some((m) => m.type === "result"),
        `${label}: llega el resultado`,
      ).toBe(true);
      // I1/F1 · ningún id interno, en ningún mensaje (init, snapshot, evento, resultado).
      expect(
        strings(msgs).filter((s) => INTERNAL_ID.test(s)),
        label,
      ).toEqual([]);
      // EQUIPMENT_PRIVATE · ningún campo de equipamiento en ninguna profundidad.
      const keys = keysDeep(msgs);
      for (const k of EQUIPMENT_KEYS) expect(keys.has(k), `${label}: clave «${k}»`).toBe(false);
      expect(JSON.stringify(msgs)).not.toContain("no-sale");
      // Las minas no existen para el público (ni posición ni id).
      const snaps = msgs.filter((m) => m.type === "snapshot").map((m) => m.snapshot);
      expect(snaps.length).toBeGreaterThan(10);
      for (const s of snaps) expect(s.deployables).toEqual([]);
      // #261 · proyectiles densos 1..K, sin huecos, en orden de primera visibilidad.
      const pids = new Set<number>();
      for (const s of snaps) for (const p of s.projectiles) pids.add(Number(p.id.split("_")[1]));
      const sorted = [...pids].sort((x, y) => x - y);
      expect(sorted.length).toBeGreaterThan(0);
      expect(sorted).toEqual(sorted.map((_, i) => i + 1));
      // Casco cuantizado N=20.
      for (const s of snaps) for (const v of s.vehicles) expect(v.hullLevel).toBeGreaterThanOrEqual(0);
      for (const s of snaps) for (const v of s.vehicles) expect(v.hullLevel).toBeLessThanOrEqual(20);
      // Cada snapshot lleva el mappingId de SU audiencia.
      const mids = new Set(msgs.filter((m) => m.type === "snapshot").map((m) => m.mappingId));
      expect(mids.size, label).toBe(1);
      expect([...mids][0]).toBe(msgs[0].mappingId);
    }
    expect(live.got[0].mappingId).not.toBe(bcast.got[0].mappingId);
    expect(live.got[0].meta.roster.map((r: any) => r.id).sort()).toEqual(["v_1", "v_2"]);
  });

  it("F3 · la proyección no toca la simulación: mismo finalStateHash con gateway y sin él", async () => {
    const plain = await battle("ma-f3");
    const r1 = plain.run();
    const watched = await battle("ma-f3");
    const gw = new SpectateGateway({ publicSpectateEnabled: true });
    cleanups.push(() => gw.close());
    gw.attachBattle("ma-f3", watched, { pollIntervalMs: 1 });
    await connect(gw, "ma-f3", "public_live");
    while (!watched.isFinished()) {
      for (let i = 0; i < 3 && !watched.isFinished(); i++) watched.step();
      // Proyectar N veces el mismo estado tampoco cambia nada.
      watched.getInternalFrame();
      await sleep(1);
    }
    await sleep(50);
    const r2 = watched.getResult()!;
    expect(r2.finalStateHash).toBe(r1.finalStateHash);
    expect(watched.stateHashes).toEqual(plain.stateHashes);
  });

  it("un ticket sin audiencia firmada no abre el canal", async () => {
    const id = "ma-noview";
    const b = await battle(id);
    const gw = new SpectateGateway({ publicSpectateEnabled: true });
    cleanups.push(() => gw.close());
    gw.attachBattle(id, b, { pollIntervalMs: 5 });
    const legacy = jwt.sign({ battleId: id, anon: true }, spectateTicketSecret(), {
      algorithm: "HS256",
      jwtid: randomUUID(),
      expiresIn: 60,
      issuer: "s9-ai-arena",
      audience: "s9-arena/spectate",
    });
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/spectate/${id}`, spectateProtocols(legacy));
    cleanups.push(() => ws.terminate());
    const code = await new Promise<number>((resolve) => ws.once("close", (c) => resolve(c)));
    expect(code).toBe(4401);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────
// 1a · Ronda 2 (REVIEW-1a F-1/F-2) · la MISMA frontera con RETARDO: historial por audiencia
// (#282/EQ5), feed retrasado, result retrasado y un espectador que llega TARDE (su init sale
// de dueSnapshot/dueResult/meta de SU audiencia). Calibración: ma-mutants.py MD1–MD6 (feed
// retrasado con snapshot/evento/result crudos, init retrasado con meta o result crudos, init
// retrasado con el snapshot de la audiencia `staff`).
function checkDelayed(label: string, msgs: any[]) {
  expect(msgs[0]?.type, label).toBe("init");
  expect(
    strings(msgs).filter((s) => INTERNAL_ID.test(s)),
    `${label}: ids internos`,
  ).toEqual([]);
  const keys = keysDeep(msgs);
  for (const k of EQUIPMENT_KEYS) expect(keys.has(k), `${label}: clave «${k}»`).toBe(false);
  expect(JSON.stringify(msgs), `${label}: meta fuera de la lista blanca`).not.toContain("no-sale");
  for (const m of msgs) if (m.type === "snapshot") expect(m.snapshot.deployables, label).toEqual([]);
}

/** Casco CUANTIZADO público (D-B5): hullLevel entero en [0, 20] y nunca hp exacto. */
function checkQuantized(label: string, snapshot: any) {
  expect(snapshot?.vehicles?.length, `${label}: sin vehículos`).toBeGreaterThan(0);
  for (const v of snapshot.vehicles) {
    expect(Number.isInteger(v.hullLevel), `${label}: hullLevel entero`).toBe(true);
    expect(v.hullLevel).toBeGreaterThanOrEqual(0);
    expect(v.hullLevel).toBeLessThanOrEqual(20);
    expect(v.hullHp, `${label}: hp exacto`).toBeUndefined();
  }
}

describe("PUBLIC_PROJECTION_BOUNDARY · con retardo (historial e init retrasado por audiencia)", () => {
  it("DELAYED_PROJECTION_BOUNDARY · feed retrasado + init tardío: nada sale crudo ni de otra audiencia", async () => {
    const id = "ma-delay";
    const b = await battle(id);
    const gw = new SpectateGateway({ publicSpectateEnabled: true });
    cleanups.push(() => gw.close());
    gw.attachBattle(id, b, {
      pollIntervalMs: 5,
      spectator: { delaySeconds: 0.4 },
      roster: [
        { id: "veh_1", botId: "bot-gunner", team: "red", chassis: "chassis.medium@2" },
        { id: "veh_2", botId: "bot-miner", team: "blue", chassis: "chassis.light@2" },
      ],
      meta: { mode: "deathmatch", secretThing: "no-sale" },
    });
    const live = await connect(gw, id, "public_live");
    const bcast = await connect(gw, id, "broadcast");
    // La batalla dura MÁS que el retardo (60 tandas × ≥ 15 ms ≫ 400 ms): así el historial de
    // CADA audiencia (también `staff`, sin clientes) ya ha vencido estado cuando llega el
    // tardío, y un init que tomara el de otra audiencia no coincidiría por casualidad.
    while (!b.isFinished()) {
      for (let i = 0; i < 6 && !b.isFinished(); i++) b.step();
      await sleep(15);
    }
    await sleep(900); // pasa el retardo: llega todo, incluido el result retrasado
    const late = await connect(gw, id, "public_live"); // init desde dueSnapshot/dueResult
    await sleep(300);
    for (const [label, c] of [
      ["public_live", live],
      ["broadcast", bcast],
      ["late", late],
    ] as const) {
      checkDelayed(label, c.got);
      const snaps = c.got.filter((m) => m.type === "snapshot").length + (c.got[0].snapshot ? 1 : 0);
      expect(snaps, `${label}: hubo estado`).toBeGreaterThan(0);
    }
    expect(
      live.got.some((m) => m.type === "result"),
      "live: result retrasado",
    ).toBe(true);
    expect(
      live.got.some((m) => m.type === "event"),
      "live: eventos retrasados",
    ).toBe(true);
    expect(late.got[0].finished, "late: init con el fin vencido").toBe(true);
    expect(late.got[0].result, "late: init con result").toBeTruthy();
    expect(late.got[0].snapshot, "late: init con snapshot vencido").toBeTruthy();
    expect(late.got[0].mappingId).toBe(live.got[0].mappingId);
    expect(late.got[0].mappingId).not.toBe(bcast.got[0].mappingId);
    // F-2 · el init retrasado sale de SU audiencia: es exactamente el último snapshot público
    // que vio el directo (mismo mapper), con el casco cuantizado; y el result del init es el
    // mismo result proyectado que llegó por el feed.
    const lastLive = live.got.filter((m) => m.type === "snapshot").at(-1)!.snapshot;
    checkQuantized("live", lastLive);
    checkQuantized("late", late.got[0].snapshot);
    expect(late.got[0].snapshot, "late: init = último snapshot público").toEqual(lastLive);
    expect(late.got[0].result).toEqual(live.got.find((m) => m.type === "result")!.result);
  }, 30_000);
});
