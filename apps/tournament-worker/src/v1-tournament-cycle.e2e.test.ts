/**
 * V1-C · Ciclo COMPLETO de torneo, de la API al motor, para los formatos de V1.
 *
 *   crear (API) → inscribir (API) → cerrar inscripciones (API) → iniciar (cola) →
 *   batallas con el MOTOR REAL en proceso → resultados → finalizar →
 *   clasificación, Elo y replays (API de lectura).
 *
 * Formatos: round robin, eliminación simple, suizo y Team Deathmatch por equipos 2v2.
 *
 * REAL: API Express completa, PostgreSQL embebida con todas las migraciones, cola de trabajos,
 * worker, scheduler, motor determinista (Battle + replay en disco), mapas y catálogo, Elo.
 * SIMULADO: los agentes de los bots son stubs deterministas del motor en proceso (`testStubAgents`);
 * NO hay sandbox Docker de bots ni navegador. El `FakeBotManager` sustituye al gestor de bots.
 *
 * El ORÁCULO de las clasificaciones se calcula aquí desde `participants.outcome` (lo que el
 * motor decidió en cada batalla), NO con el código de clasificación del producto: así un fallo
 * en el cálculo de puntos, en el reparto de equipos o en el Elo pone el test en rojo.
 *
 * Cada `it` lleva una etiqueta `V1C_*`: `tests/mutants/v1-tournament/run.mjs` exige que cada
 * mutante caiga por un test concreto con su etiqueta.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev, DEV_USERS } from "../../api/src/db/seeds/dev.js";
import { tokenFor } from "../../api/src/testing/helpers.js";
import { createApp } from "../../api/src/app.js";
import { FakeBotManager } from "../../api/src/services/bot-manager.js";
import { clearStandingsCache } from "../../api/src/services/standings.js";
import { TournamentWorker } from "./worker.js";
import { sortTable, type TableRow } from "./results.js";
import { makeDefaultHandlers, type AgentDriver } from "./engine-executor.js";
import { IdleBot } from "../../arena-engine/src/stubs.js";
import type { Battle, BotAgent } from "../../arena-engine/src/sim/battle.js";
import { createPublishedBot, type TestBot } from "./testing/fixtures.js";

type Row = Record<string, unknown>;

let h: TestDbHandle;
let app: Express;
let worker: TournamentWorker;
let organizer: string;
let developer: string;
let admin: string;
let developerId: string;
let replaysDir: string;
let seq = 0;
/**
 * Dos niveles de agente EN PROCESO: los bots "fuertes" (artillero oráculo) derriban a los "débiles"
 * (IdleBot, que no dispara); entre débiles hay empate y entre fuertes decide quién acierta antes.
 * Así hay victorias, derrotas y empates reales que el oráculo puede contar (con HunterBot contra
 * HunterBot el motor termina siempre 0-0: no discrimina nada).
 */
const strong = new Set<string>();

/**
 * Artillero oráculo: quieto, apunta la torreta al enemigo vivo más cercano leyendo la pose del
 * motor y dispara al estar alineado. Sólo es el «piloto»: daño, muertes, puntuación, ganador y
 * outcomes los resuelven motor y worker (mismo recurso que team4v4-runner.test.ts).
 */
class OracleGunner implements BotAgent {
  constructor(
    readonly botId: string,
    private engine: Battle,
    private selfId: string,
    private team: string,
  ) {}
  decide(obs: any) {
    const phys = this.engine.getPhysics();
    const me = phys.pose(this.selfId)!.position;
    const foes = this.engine
      .getVehicles()
      .filter((v) => v.team !== this.team && v.alive)
      .map((v) => phys.pose(v.id)!.position)
      .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    const cmd: any = { forTick: obs.tick, move: { throttle: 0, steer: 0 } };
    if (foes.length === 0) return cmd;
    const t = foes[0];
    cmd.turret = { targetPoint: t };
    const bearing = Math.atan2(t.y - me.y, t.x - me.x);
    let err = (obs.self.turretHeading ?? 0) - bearing;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    if (Math.abs(err) < 0.1) cmd.fire = ["turret_main"];
    return cmd;
  }
}

/** Driver en proceso sobre el motor REAL: los fuertes son artilleros, los débiles IdleBot. */
function duelDriver(): AgentDriver {
  return {
    kind: "in_process_stub",
    async run({ engine, vehicles, signal }) {
      const phys = engine.getPhysics();
      const perSide = new Map<string, number>();
      for (const v of vehicles) {
        // Sólo física inicial: cada bando en su fila, a 25 m, para que el duelo se decida pronto.
        const k = perSide.get(v.team) ?? 0;
        perSide.set(v.team, k + 1);
        phys.get(v.vehicleId)!.rb.setTranslation({ x: v.team === "A" ? 71 : 96, y: 30 + 6 * k }, true);
        engine.attachBot(
          v.vehicleId,
          strong.has(v.botId) ? new OracleGunner(v.botId, engine, v.vehicleId, v.team) : new IdleBot(v.botId),
        );
      }
      while (!engine.isFinished() && engine.tick < 5000) {
        if (signal?.aborted) throw new Error(`batalla abortada: ${String(signal.reason)}`);
        engine.step();
      }
      const result = engine.run(5000);
      // V1 REPLAYS PR-3 · el replay lo graba el ReplayRecorder del ejecutor (el motor ya no lo retiene).
      return { result };
    },
  };
}

const as = (tok: string) => ({ Authorization: `Bearer ${tok}` });

async function drainAll(maxIterations = 60): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if ((await worker.drain()) === 0) return;
  }
  throw new Error("drainAll: la cola no se vació (¿bucle de trabajos?)");
}

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  clearStandingsCache();
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  organizer = await tokenFor(h.db, DEV_USERS.organizer);
  developer = await tokenFor(h.db, DEV_USERS.developer);
  admin = await tokenFor(h.db, DEV_USERS.admin);
  developerId = (await h.db("users").where({ email: DEV_USERS.developer }).first()).id as string;

  replaysDir = mkdtempSync(join(tmpdir(), "v1c-replays-"));
  const wired = await makeDefaultHandlers({
    db: h.db,
    agents: duelDriver(),
    rulesetOverrides: { timeLimitTicks: 1500, scoreToWin: 1 },
    replaysDir,
  });
  worker = new TournamentWorker({
    db: h.db,
    workerId: "v1c-worker",
    handlers: wired.handlers,
    onExhausted: (job, ctx) => wired.onExhausted(ctx.db, job),
  });
}, 180_000);

afterAll(async () => {
  await h.stop();
});

// ---------------------------------------------------------------- utilidades

/** Bots del developer, con v1 publicada y loadout elegible: se inscriben por la API real. */
async function mkBots(
  n: number,
  label: string,
  teamId: string | null = null,
  pattern: boolean[] = [],
): Promise<TestBot[]> {
  const out: TestBot[] = [];
  for (let i = 0; i < n; i++) {
    const b = await createPublishedBot(h.db, `${label}-${++seq}`, { ownerId: developerId });
    if (pattern.length > 0 ? pattern[i] : i % 2 === 0) strong.add(b.botId);
    if (teamId) await h.db("bots").where({ id: b.botId }).update({ team_id: teamId });
    out.push(b);
  }
  return out;
}

async function createTournament(body: Record<string, unknown>): Promise<string> {
  const r = await request(app)
    .post("/tournaments")
    .set(as(organizer))
    .send({ rulesetId: "mvp-default", mode: "deathmatch", roundsPerPairing: 1, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body.state).toBe("open");
  return r.body.id as string;
}

async function enter(tid: string, bots: TestBot[]): Promise<void> {
  for (const b of bots) {
    const r = await request(app)
      .post(`/tournaments/${tid}/entries`)
      .set(as(developer))
      .send({ botId: b.botId, version: b.version });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
}

async function closeEntries(tid: string): Promise<void> {
  const r = await request(app).post(`/tournaments/${tid}/actions/close-entries`).set(as(organizer)).send({});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.state).toBe("closed");
}

/** Resultado de cada batalla oficial del torneo según lo que decidió el motor (participants.outcome). */
async function battleOutcomes(tid: string) {
  const battles = (await h.db("battles").where({ tournament_id: tid }).orderBy("created_at")) as Row[];
  const out: { battle: Row; parts: Row[] }[] = [];
  for (const battle of battles) {
    out.push({ battle, parts: (await h.db("participants").where({ battle_id: battle.id })) as Row[] });
  }
  return out;
}

/** ORÁCULO INDEPENDIENTE · puntos 3/1/0 por bot desde participants.outcome (1 juego por match). */
function oraclePointsByBot(rows: { battle: Row; parts: Row[] }[]) {
  const t = new Map<string, { points: number; wins: number; losses: number; draws: number }>();
  for (const { parts } of rows) {
    for (const p of parts) {
      const id = p.bot_id as string;
      const r = t.get(id) ?? { points: 0, wins: 0, losses: 0, draws: 0 };
      if (p.outcome === "win") ((r.points += 3), r.wins++);
      else if (p.outcome === "draw") ((r.points += 1), r.draws++);
      else if (p.outcome === "loss") r.losses++;
      t.set(id, r);
    }
  }
  return t;
}

/** Verificaciones comunes a todo torneo terminado: estado, matches, batallas, replays, jobs. */
async function expectFinishedCleanly(tid: string, expectedBattles: number) {
  const t = (await h.db("tournaments").where({ id: tid }).first()) as Row;
  expect(t.state).toBe("finished");
  const matches = (await h.db("matches").where({ tournament_id: tid })) as Row[];
  expect(matches.every((m) => m.state === "finished")).toBe(true);
  const battles = (await h.db("battles").where({ tournament_id: tid })) as Row[];
  expect(battles.length).toBe(expectedBattles);
  for (const b of battles) {
    expect(b.status).toBe("finished");
    expect(b.official).toBe(true);
    expect(typeof b.replay_ref).toBe("string");
    expect(existsSync(b.replay_ref as string)).toBe(true);
    expect(b.final_state_hash).toBeTruthy();
    expect(b.seed).toMatch(/^[0-9a-f]{64}$/);
  }
  const stuck = await h.db("jobs").whereIn("status", ["queued", "running", "needs_review"]);
  expect(stuck).toEqual([]);
  return { t, matches, battles };
}

/** Replays: el fichero crudo (admin) es JSON real con ticks, y el índice proyectado es legible por el staff. */
async function expectReplaysServed(battles: Row[]) {
  for (const b of battles) {
    const raw = await request(app).get(`/replays/${b.id}`).set(as(admin));
    expect(raw.status).toBe(200);
    expect(raw.body.length).toBeGreaterThan(0);
    const idx = await request(app).get(`/replays/${b.id}/index`).set(as(organizer));
    expect(idx.status).toBe(200);
    expect(idx.body.projection).toBe("s9.replay.public-competition.v2");
    // El fichero en disco es el que sirve la API (no un marcador vacío).
    expect(readFileSync(b.replay_ref as string).length).toBeGreaterThan(0);
  }
}

/**
 * ORÁCULO ELO INDEPENDIENTE (1v1): reaplica la fórmula estándar (K=24, logística de 400) sobre
 * el libro mayor en orden y exige que cada evento y el rating final coincidan; suma conservada.
 */
async function expectEloLedgerCorrect(tid: string, botIds: string[], mode: string) {
  const t = (await h.db("tournaments").where({ id: tid }).first()) as Row;
  const events = (await h
    .db("rating_events")
    .join("battles", "battles.id", "rating_events.battle_id")
    .where("battles.tournament_id", tid)
    .orderBy("rating_events.id")
    .select("rating_events.*")) as Row[];
  const battles = (await h.db("battles").where({ tournament_id: tid, status: "finished" })) as Row[];
  expect(events.length).toBe(battles.length * 2); // un evento por participante y batalla
  const rating = new Map<string, number>();
  // Rating previo al torneo (otros torneos de la misma temporada y modo ya escritos en la BD).
  for (const id of botIds) {
    const prev = (await h
      .db("rating_events")
      .where({ bot_id: id, season_id: t.season_id, mode })
      .whereNotIn(
        "battle_id",
        battles.map((b) => b.id as string),
      )
      .orderBy("id", "desc")
      .first()) as Row | undefined;
    rating.set(id, prev ? Number(prev.rating_after) : 1000);
  }
  const byBattle = new Map<string, Row[]>();
  for (const e of events) byBattle.set(e.battle_id as string, [...(byBattle.get(e.battle_id as string) ?? []), e]);
  for (const bid of [...byBattle.keys()]) {
    const [e1, e2] = byBattle.get(bid)!;
    const parts = (await h.db("participants").where({ battle_id: bid })) as Row[];
    const outcome = (id: string) => parts.find((p) => p.bot_id === id)!.outcome;
    const score = (o: unknown) => (o === "win" ? 1 : o === "draw" ? 0.5 : 0);
    const a = e1.bot_id as string;
    const b = e2.bot_id as string;
    const ea = 1 / (1 + 10 ** ((rating.get(b)! - rating.get(a)!) / 400));
    const da = 24 * (score(outcome(a)) - ea);
    expect(Number(e1.rating_before)).toBeCloseTo(rating.get(a)!, 6);
    expect(Number(e2.rating_before)).toBeCloseTo(rating.get(b)!, 6);
    expect(Number(e1.delta)).toBeCloseTo(da, 6);
    expect(Number(e2.delta)).toBeCloseTo(-da, 6);
    rating.set(a, rating.get(a)! + da);
    rating.set(b, rating.get(b)! - da);
  }
  for (const id of botIds) {
    const r = (await h.db("ratings").where({ bot_id: id, season_id: t.season_id, mode }).first()) as Row;
    expect(Number(r.rating)).toBeCloseTo(rating.get(id)!, 4);
  }
  const sum = [...rating.values()].reduce((x, y) => x + y, 0);
  expect(sum).toBeCloseTo(1000 * botIds.length, 4); // sistema cerrado: suma conservada
}

/** Clasificación por la API pública /standings contra el oráculo (puntos → V-D-E, rating y orden). */
async function expectStandingsMatchOracle(tid: string, botIds: string[], mode: string) {
  const t = (await h.db("tournaments").where({ id: tid }).first()) as Row;
  clearStandingsCache();
  const res = await request(app).get(`/standings?seasonId=${t.season_id}&mode=${mode}`);
  expect(res.status).toBe(200);
  const oracle = oraclePointsByBot(await battleOutcomes(tid));
  const rows = (res.body as Row[]).filter((r) => botIds.includes(r.botId as string));
  expect(rows.length).toBe(botIds.length);
  for (const r of rows) {
    const o = oracle.get(r.botId as string) ?? { points: 0, wins: 0, losses: 0, draws: 0 };
    expect({ w: r.wins, l: r.losses, d: r.draws }).toEqual({ w: o.wins, l: o.losses, d: o.draws });
  }
  // Orden: el puesto sigue a los PUNTOS del oráculo (puntos → directo → diferencia → seed).
  const byRank = [...rows].sort((a, b) => Number(a.rank) - Number(b.rank));
  const pts = byRank.map((r) => oracle.get(r.botId as string)!.points);
  expect(pts).toEqual([...pts].sort((a, b) => b - a));
  return { rows, oracle };
}

// ------------------------------------------------------------ round robin

describe("V1-C · round robin 4 bots de principio a fin", () => {
  let tid: string;
  let bots: TestBot[];

  it("V1C_RR_cycle · crea, inscribe, cierra, ejecuta con el motor y termina con campeón y replays", async () => {
    bots = await mkBots(4, "rr");
    tid = await createTournament({ name: `v1c-rr-${++seq}`, format: "round_robin" });
    await enter(tid, bots);
    await closeEntries(tid);
    // Cierre: versiones congeladas (cap. 17.2)
    for (const b of bots) {
      expect((await h.db("bot_versions").where({ bot_id: b.botId, version: b.version }).first()).state).toBe("frozen");
    }
    await drainAll();
    const { t, matches } = await expectFinishedCleanly(tid, 6); // C(4,2)
    expect(matches.length).toBe(6);
    expect(t.champion_bot_id).toBeTruthy();
    // todos contra todos EXACTAMENTE una vez
    const pairs = new Set(
      matches.map((m) => {
        const p = typeof m.pairing === "string" ? JSON.parse(m.pairing) : m.pairing;
        return [p.home, p.away].sort().join("|");
      }),
    );
    expect(pairs.size).toBe(6);
  });

  it("V1C_RR_standings · la clasificación publicada coincide con el oráculo y el campeón es el líder", async () => {
    const { rows, oracle } = await expectStandingsMatchOracle(
      tid,
      bots.map((b) => b.botId),
      "deathmatch",
    );
    const t = (await h.db("tournaments").where({ id: tid }).first()) as Row;
    // El campeón tiene el máximo de puntos del oráculo (3·V + E calculado desde los outcomes).
    const maxPts = Math.max(...[...oracle.values()].map((o) => o.points));
    expect(oracle.get(t.champion_bot_id as string)!.points).toBe(maxPts);
    // El oráculo DISCRIMINA: hay victorias y puntuaciones distintas (si todo fuera empate no probaría nada).
    expect([...oracle.values()].some((o) => o.wins > 0)).toBe(true);
    expect(new Set([...oracle.values()].map((o) => o.points)).size).toBeGreaterThan(1);
    // 6 batallas con 4 bots → V+D+E suma 12 participaciones
    expect(rows.reduce((s, r) => s + Number(r.wins) + Number(r.losses) + Number(r.draws), 0)).toBe(12);
  });

  it("V1C_RR_elo · el libro mayor Elo reaplica la fórmula estándar y conserva la suma", async () => {
    await expectEloLedgerCorrect(
      tid,
      bots.map((b) => b.botId),
      "deathmatch",
    );
  });

  it("V1C_RR_replays · todas las batallas tienen replay servido por la API", async () => {
    const battles = (await h.db("battles").where({ tournament_id: tid })) as Row[];
    await expectReplaysServed(battles);
    const list = await request(app).get(`/tournaments/${tid}/battles`).set(as(organizer));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(6);
  });
});

// -------------------------------------------------------- eliminación simple

describe("V1-C · eliminación simple 4 bots de principio a fin", () => {
  it("V1C_SE_cycle · el bracket se materializa y avanza; el campeón es el ganador de la final con replay visible", async () => {
    const bots = await mkBots(4, "se");
    const tid = await createTournament({ name: `v1c-se-${++seq}`, format: "single_elimination" });
    await enter(tid, bots);
    await closeEntries(tid);
    await drainAll();
    const { t, matches, battles } = await expectFinishedCleanly(tid, 3);
    // Bracket estándar de 4: 2 semifinales + final (3 matches, sin byes).
    expect(matches.length).toBe(3);
    expect(matches.filter((m) => (typeof m.pairing === "string" ? JSON.parse(m.pairing) : m.pairing).bye).length).toBe(
      0,
    );
    const final = matches.find((m) => m.final)!;
    expect(final).toBeTruthy();
    // Propagación: los dos participantes de la final son EXACTAMENTE los ganadores de las semifinales.
    const semis = matches.filter((m) => !m.final);
    expect(semis.length).toBe(2);
    const finalBattleRow = battles.find((b) => b.match_id === final.id)!;
    const finalBots = (await h.db("participants").where({ battle_id: finalBattleRow.id })).map(
      (p: Row) => p.bot_id as string,
    );
    expect([...finalBots].sort()).toEqual(semis.map((m) => m.winner_bot_id as string).sort());
    expect(final.winner_bot_id).toBe(t.champion_bot_id);
    // Cada match lo gana quien el MOTOR declaró vencedor; si la batalla fue empate, desempata el seed.
    const rows = await battleOutcomes(tid);
    // El oráculo DISCRIMINA: al menos una batalla decisiva (si todo fuera empate no probaría nada).
    expect(rows.some((r) => r.parts.some((p) => p.outcome === "win"))).toBe(true);
    for (const { battle, parts } of rows) {
      const m = matches.find((x) => x.id === battle.match_id)!;
      const winners = parts.filter((p) => p.outcome === "win");
      if (winners.length === 1) expect(m.winner_bot_id).toBe(winners[0].bot_id);
      else expect(parts.map((p) => p.bot_id)).toContain(m.winner_bot_id);
    }
    // El campeón disputó la final y no perdió ninguna batalla.
    expect(rows.filter((r) => r.parts.some((p) => p.bot_id === t.champion_bot_id && p.outcome === "loss")).length).toBe(
      0,
    );
    // La final se retransmite en visible; el resto, diferido.
    const finalBattle = battles.find((b) => b.match_id === final.id)!;
    expect(finalBattle.spectator_mode).toBe("visible");
    expect(battles.filter((b) => b.spectator_mode === "visible").length).toBe(1);
    await expectReplaysServed(battles);
  });

  it("V1C_SE_elo · Elo del bracket conforme a la fórmula y suma conservada", async () => {
    const last = (await h
      .db("tournaments")
      .where({ format: "single_elimination", state: "finished" })
      .orderBy("created_at", "desc")
      .first()) as Row;
    const ids = (await h.db("entries").where({ tournament_id: last.id })).map((e: Row) => e.bot_id as string);
    await expectEloLedgerCorrect(last.id as string, ids, "deathmatch");
  });
});

// ------------------------------------------------------------------- suizo

describe("V1-C · suizo 4 bots de principio a fin", () => {
  it("V1C_SW_cycle · las rondas se generan según los resultados, sin repetir rival, y el torneo termina", async () => {
    const bots = await mkBots(4, "sw");
    const tid = await createTournament({ name: `v1c-sw-${++seq}`, format: "swiss" });
    await enter(tid, bots);
    await closeEntries(tid);

    await drainAll();
    const { t, matches } = await expectFinishedCleanly(tid, 4); // 2 rondas × 2 mesas
    expect(t.champion_bot_id).toBeTruthy();
    const rounds = [...new Set(matches.map((m) => Number(m.round)))].sort();
    expect(rounds).toEqual([1, 2]);
    // Nadie repite rival (4 bots, 2 rondas: perfectamente evitable).
    const seen = new Set<string>();
    for (const m of matches) {
      const p = typeof m.pairing === "string" ? JSON.parse(m.pairing) : m.pairing;
      const key = [p.home, p.away].sort().join("|");
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // Cada bot juega exactamente una vez por ronda.
    for (const b of bots) {
      const n = (await h
        .db("participants")
        .join("battles", "battles.id", "participants.battle_id")
        .where({ "battles.tournament_id": tid, "participants.bot_id": b.botId })
        .count("* as n")
        .first()) as Row;
      expect(Number(n.n)).toBe(2);
    }
    // La ronda 2 empareja por puntos tras la 1: ganadores entre sí y perdedores entre sí (sin empates).
    const r1 = await battleOutcomes(tid);
    const r1Battles = r1.filter((x) => matches.find((m) => m.id === x.battle.match_id)!.round === 1);
    const decisive = r1Battles.every((x) => x.parts.every((p) => p.outcome === "win" || p.outcome === "loss"));
    if (decisive) {
      const winners = new Set(
        r1Battles.flatMap((x) => x.parts.filter((p) => p.outcome === "win").map((p) => p.bot_id)),
      );
      const r2 = r1.filter((x) => matches.find((m) => m.id === x.battle.match_id)!.round === 2);
      for (const x of r2) {
        const ws = x.parts.map((p) => winners.has(p.bot_id as string));
        expect(ws[0]).toBe(ws[1]); // mismo grupo de puntos
      }
    }
    await expectStandingsMatchOracle(
      tid,
      bots.map((b) => b.botId),
      "deathmatch",
    );
    await expectEloLedgerCorrect(
      tid,
      bots.map((b) => b.botId),
      "deathmatch",
    );
    await expectReplaysServed((await h.db("battles").where({ tournament_id: tid })) as Row[]);
  });
});

describe("V1-C · suizo 8 bots: la ronda 2 empareja por RESULTADOS, no por semilla", () => {
  it("V1C_SW_pairing · tras la ronda 1 los ganadores juegan entre sí y los perdedores entre sí", async () => {
    // Semillas 1..8 en orden de inscripción; ganan 1, 4, 5 y 8 (los fuertes). Emparejar por semilla
    // (1-3, 2-4, 5-7, 6-8) mezclaría ganadores y perdedores: sólo emparejar por puntos separa los grupos.
    const bots = await mkBots(8, "sw8", null, [true, false, false, true, true, false, false, true]);
    const tid = await createTournament({ name: `v1c-sw8-${++seq}`, format: "swiss" });
    await enter(tid, bots);
    await closeEntries(tid);
    await drainAll();
    const { matches } = await expectFinishedCleanly(tid, 12); // 3 rondas x 4 mesas
    const rows = await battleOutcomes(tid);
    const roundOf = (r: { battle: Row }) => Number(matches.find((m) => m.id === r.battle.match_id)!.round);
    const r1 = rows.filter((r) => roundOf(r) === 1);
    expect(r1.length).toBe(4);
    // Cada mesa de la ronda 1 es fuerte contra débil y gana el fuerte.
    for (const r of r1) {
      expect(r.parts.filter((p) => strong.has(p.bot_id as string)).length).toBe(1);
      expect(r.parts.find((p) => strong.has(p.bot_id as string))!.outcome).toBe("win");
    }
    const winners = new Set(r1.map((r) => r.parts.find((p) => p.outcome === "win")!.bot_id as string));
    expect(winners.size).toBe(4);
    const r2 = rows.filter((r) => roundOf(r) === 2);
    expect(r2.length).toBe(4);
    for (const r of r2) {
      const g = r.parts.map((p) => winners.has(p.bot_id as string));
      expect(g[0]).toBe(g[1]);
    }
    await expectStandingsMatchOracle(
      tid,
      bots.map((b) => b.botId),
      "deathmatch",
    );
  });
});

// ------------------------------------------------- Team Deathmatch 2v2

/** ORÁCULO ELO por equipos: parejas cruzadas (K/N² cada una) con los ratings previos a la batalla. */
async function expectEloTeamsCorrect(tid: string, botIds: string[]) {
  const t = (await h.db("tournaments").where({ id: tid }).first()) as Row;
  const events = (await h
    .db("rating_events")
    .join("battles", "battles.id", "rating_events.battle_id")
    .where("battles.tournament_id", tid)
    .orderBy("rating_events.id")
    .select("rating_events.*")) as Row[];
  const rating = new Map<string, number>(botIds.map((id) => [id, 1000]));
  const order: string[] = [];
  for (const e of events) if (!order.includes(e.battle_id as string)) order.push(e.battle_id as string);
  const score = (o: unknown) => (o === "win" ? 1 : o === "draw" ? 0.5 : 0);
  for (const bid of order) {
    const parts = (await h.db("participants").where({ battle_id: bid })) as Row[];
    const side = (l: string) => parts.filter((p) => p.team === l);
    const letters = [...new Set(parts.map((p) => p.team as string))];
    expect(letters.length).toBe(2);
    const pairsN = side(letters[0]).length * side(letters[1]).length;
    const delta = new Map<string, number>(parts.map((p) => [p.bot_id as string, 0]));
    for (const a of side(letters[0])) {
      for (const b of side(letters[1])) {
        const ra = rating.get(a.bot_id as string)!;
        const rb = rating.get(b.bot_id as string)!;
        const sA = score(a.outcome) > score(b.outcome) ? 1 : score(a.outcome) < score(b.outcome) ? 0 : 0.5;
        const ch = (24 / pairsN) * (sA - 1 / (1 + 10 ** ((rb - ra) / 400)));
        delta.set(a.bot_id as string, delta.get(a.bot_id as string)! + ch);
        delta.set(b.bot_id as string, delta.get(b.bot_id as string)! - ch);
      }
    }
    const evs = events.filter((e) => e.battle_id === bid);
    expect(evs.length).toBe(parts.length);
    for (const e of evs) {
      expect(Number(e.rating_before)).toBeCloseTo(rating.get(e.bot_id as string)!, 6);
      expect(Number(e.delta)).toBeCloseTo(delta.get(e.bot_id as string)!, 6);
    }
    for (const [id, d] of delta) rating.set(id, rating.get(id)! + d);
  }
  for (const id of botIds) {
    const r = (await h
      .db("ratings")
      .where({ bot_id: id, season_id: t.season_id, mode: "team_deathmatch" })
      .first()) as Row;
    expect(Number(r.rating)).toBeCloseTo(rating.get(id)!, 4);
  }
}

describe("V1-C · criterios de orden de la tabla", () => {
  it("V1C_TDM_standings_sort · puntos, luego diferencia, luego semilla (con puntos y diferencia en conflicto)", () => {
    const row = (id: string, points: number, scoreDiff: number, seed: number): TableRow => ({
      id,
      points,
      wins: 0,
      losses: 0,
      draws: 0,
      scoreDiff,
      seed,
      byes: 0,
      technical: 0,
    });
    // R tiene la mejor diferencia pero menos puntos; P y Q empatan a puntos y los separa la diferencia;
    // S empata con Q en puntos y diferencia y sólo lo separa la semilla.
    const rows = [row("R", 5, 5, 1), row("P", 6, 1, 3), row("Q", 6, 2, 2), row("S", 6, 2, 4)];
    expect(sortTable(rows, new Map()).map((r) => r.id)).toEqual(["Q", "S", "P", "R"]);
  });
});

for (const n of [2, 3, 4])
  describe(`V1-C · Team Deathmatch por equipos ${n}v${n} de principio a fin`, () => {
    let tid: string;
    const teams: { teamId: string; bots: TestBot[] }[] = [];
    const teamOf = new Map<string, string>();
    /** Orden de inscripción (= semilla): del MÁS DÉBIL al más fuerte, para que semilla y clasificación difieran. */
    const enrolled: string[] = [];
    let started: Promise<void> | null = null;
    /** Ejecuta UNA vez el ciclo completo; cada test lo espera, así cada uno pasa también aislado con `-t`. */
    const ensure = () => (started ??= play());

    async function play(): Promise<void> {
      // 3 equipos de n bots; el developer es capitán/miembro de los tres.
      // Equipo 0 fuerte; equipos 1 y 2 débiles (empatan entre sí y pierden contra el 0).
      for (let i = 0; i < 3; i++) {
        const [team] = await h
          .db("teams")
          .insert({ name: `v1c-team-${++seq}`, captain_id: developerId })
          .returning("*");
        await h.db("team_members").insert({ team_id: team.id, user_id: developerId, role: "captain" });
        const strongCount = i === 0 ? n : 0;
        const bots = await mkBots(
          n,
          "tdm",
          team.id as string,
          Array.from({ length: n }, (_, k) => k < strongCount),
        );
        teams.push({ teamId: team.id as string, bots });
        for (const b of bots) teamOf.set(b.botId, team.id as string);
      }
      tid = await createTournament({
        name: `v1c-tdm-${++seq}`,
        format: "teams",
        mode: "team_deathmatch",
        rulesetId: "team-deathmatch-mvp",
        rules: { preset: "team_deathmatch", teamSize: n },
      });

      // Un bot suelto NO se puede inscribir en un torneo NvN (la unidad es el equipo completo).
      const loose = await request(app)
        .post(`/tournaments/${tid}/entries`)
        .set(as(developer))
        .send({ botId: teams[0].bots[0].botId, version: 1 });
      expect(loose.status).toBe(409);
      expect(JSON.stringify(loose.body)).toMatch(/team_enrollment_required/);

      // Un equipo de tamaño equivocado se rechaza.
      const wrong = await request(app)
        .post(`/tournaments/${tid}/team-entries`)
        .set(as(developer))
        .send({ teamId: teams[0].teamId, members: [{ botId: teams[0].bots[0].botId, version: 1 }] });
      expect(wrong.status).toBe(409);
      expect(JSON.stringify(wrong.body)).toMatch(/rules_team_size/);

      // Inscripción del más débil al más fuerte: semillas 1 y 2 para los débiles, 3 para el fuerte.
      for (const t of [teams[2], teams[1], teams[0]]) {
        const r = await request(app)
          .post(`/tournaments/${tid}/team-entries`)
          .set(as(developer))
          .send({ teamId: t.teamId, members: t.bots.map((b) => ({ botId: b.botId, version: 1 })) });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.entries.length).toBe(n);
        enrolled.push(t.teamId);
      }
      await closeEntries(tid);
      await drainAll();

      // 3 equipos → liguilla: 3 enfrentamientos reales (una batalla NvN cada uno) + 3 descansos (byes).
      const { matches } = await expectFinishedCleanly(tid, 3);
      const real = matches.filter((m) => !(typeof m.pairing === "string" ? JSON.parse(m.pairing) : m.pairing).bye);
      expect(real.length).toBe(3);
    }

    it(`V1C_TDM_cycle · ${n}v${n}: inscripción de EQUIPOS, cierre, ejecución con el motor y torneo terminado`, async () => {
      await ensure();
      expect(enrolled).toEqual([teams[2].teamId, teams[1].teamId, teams[0].teamId]);
    });

    it(`V1C_TDM_roster · ${n}v${n}: cada batalla enfrenta DOS bandos, cada uno la plantilla COMPLETA de un equipo inscrito`, async () => {
      await ensure();
      const rosterOf = new Map(
        teams.map((x) => [
          x.teamId,
          x.bots
            .map((b) => b.botId)
            .sort()
            .join(","),
        ]),
      );
      const rows = await battleOutcomes(tid);
      const pairsPlayed = new Set<string>();
      for (const { battle, parts } of rows) {
        expect(battle.mode).toBe("team_deathmatch");
        expect(parts.length).toBe(2 * n);
        const sides = new Map<string, string[]>();
        for (const p of parts)
          sides.set(p.team as string, [...(sides.get(p.team as string) ?? []), p.bot_id as string]);
        expect(sides.size).toBe(2);
        const rosters = [...sides.values()].map((b) => b.sort().join(","));
        for (const r of rosters) expect([...rosterOf.values()]).toContain(r);
        expect(new Set(rosters).size).toBe(2);
        pairsPlayed.add([...rosters].sort().join("|"));
        // Los dos miembros de un bando comparten resultado (gana un BANDO, no un bot).
        for (const members of sides.values()) {
          const outs = new Set(parts.filter((p) => members.includes(p.bot_id as string)).map((p) => p.outcome));
          expect(outs.size).toBe(1);
        }
      }
      expect(pairsPlayed.size).toBe(3); // todos contra todos, una vez
    });

    /**
     * Oráculo por equipos: 3/1/0 por BANDO desde participants.outcome (`played*`) y el descanso
     * (bye) contado APARTE (D-OP-24): no suma puntos ni victorias (docs/technical/tournaments.md y
     * docs/user/rankings.md).
     */
    async function teamOracle() {
      const oracle = new Map<
        string,
        {
          points: number;
          wins: number;
          losses: number;
          draws: number;
          scoreDiff: number;
          byes: number;
          playedPoints: number;
          playedWins: number;
        }
      >();
      for (const x of teams)
        oracle.set(x.teamId, {
          points: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          scoreDiff: 0,
          byes: 0,
          playedPoints: 0,
          playedWins: 0,
        });
      for (const { battle, parts } of await battleOutcomes(tid)) {
        const perTeam = new Map<string, { outcome: unknown; letter: string }>();
        for (const p of parts)
          perTeam.set(teamOf.get(p.bot_id as string)!, { outcome: p.outcome, letter: p.team as string });
        const res = typeof battle.result === "string" ? JSON.parse(battle.result) : (battle.result as Row);
        const score = (res.score ?? {}) as Record<string, number>;
        for (const [teamId, { outcome, letter }] of perTeam) {
          const r = oracle.get(teamId)!;
          if (outcome === "win") ((r.points += 3), r.wins++);
          else if (outcome === "draw") ((r.points += 1), r.draws++);
          else r.losses++;
          const other = letter === "A" ? "B" : "A";
          r.scoreDiff += Number(score[letter] ?? 0) - Number(score[other] ?? 0);
        }
      }
      for (const r of oracle.values()) {
        r.playedPoints = r.points;
        r.playedWins = r.wins;
      }
      const matches = (await h.db("matches").where({ tournament_id: tid })) as Row[];
      for (const m of matches) {
        const pr = typeof m.pairing === "string" ? JSON.parse(m.pairing) : m.pairing;
        // D-OP-24: el bye NO puntúa ni es victoria jugada: sólo se cuenta en `byes`.
        if (pr.bye && pr.home) oracle.get(pr.home as string)!.byes++;
      }
      return oracle;
    }

    it(`V1C_TDM_standings · ${n}v${n}: puntos, V-D-E, rank y orden (puntos, diferencia, semilla) coinciden con el oráculo`, async () => {
      await ensure();
      const st = await request(app).get(`/tournaments/${tid}/team-standings`);
      expect(st.status, JSON.stringify(st.body)).toBe(200);
      const body = st.body as Row[];
      expect(body.length).toBe(3);
      const oracle = await teamOracle();
      for (const row of body) {
        const o = oracle.get(row.teamId as string)!;
        expect({ p: row.points, w: row.wins, l: row.losses, d: row.draws }).toEqual({
          p: o.points,
          w: o.wins,
          l: o.losses,
          d: o.draws,
        });
      }
      // Orden esperado: puntos desc, diferencia desc, semilla (= orden de inscripción) asc.
      const seedOf = (id: string) => enrolled.indexOf(id);
      const expected = teams
        .map((x) => x.teamId)
        .sort((a, b) => {
          const A = oracle.get(a)!;
          const B = oracle.get(b)!;
          return B.points - A.points || B.scoreDiff - A.scoreDiff || seedOf(a) - seedOf(b);
        });
      expect(body.map((r) => r.teamId)).toEqual(expected);
      expect(body.map((r) => r.rank)).toEqual([1, 2, 3]);
      // El oráculo DISCRIMINA: el equipo fuerte lidera, los dos débiles empatan a puntos y diferencia
      // (sólo la SEMILLA los separa) y la semilla NO coincide con la clasificación final.
      expect(expected[0]).toBe(teams[0].teamId);
      const w1 = oracle.get(expected[1])!;
      const w2 = oracle.get(expected[2])!;
      expect({ p: w1.points, s: w1.scoreDiff }).toEqual({ p: w2.points, s: w2.scoreDiff });
      expect(seedOf(expected[1])).toBeLessThan(seedOf(expected[2]));
      expect(seedOf(expected[0])).toBe(2);
      expect(new Set([...oracle.values()].map((o) => o.points)).size).toBeGreaterThan(1);
    });

    // CONTRATO D-OP-24 (docs/technical/tournaments.md, docs/user/rankings.md): el descanso (bye) es un
    // avance administrativo: NO es victoria, derrota ni empate, suma 0 puntos y no cuenta como partida
    // disputada; va en su propia columna `byes`. Con 3 equipos cada uno descansa exactamente una vez.
    // (Antes de D-OP-24 la tabla lo contaba como 3 puntos y 1 victoria.)
    it(`V1C_TDM_bye_contract · ${n}v${n}: la tabla por equipos NO cuenta el bye como victoria ni puntos; va en \`byes\`, una vez por equipo`, async () => {
      await ensure();
      const st = await request(app).get(`/tournaments/${tid}/team-standings`);
      const oracle = await teamOracle();
      for (const row of st.body as Row[]) {
        const o = oracle.get(row.teamId as string)!;
        expect(o.byes).toBe(1);
        expect(Number(row.byes)).toBe(1);
        expect(Number(row.points)).toBe(o.playedPoints);
        expect(Number(row.wins)).toBe(o.playedWins);
        // partidas disputadas = V + E + D: el bye no suma; sin resultados técnicos en este ciclo.
        expect(Number(row.played)).toBe(Number(row.wins) + Number(row.draws) + Number(row.losses));
        expect(Number(row.played)).toBe(2);
        expect(Number(row.technical)).toBe(0);
      }
      // Ningún bye genera batalla ni rating_event.
      const byeMatches = ((await h.db("matches").where({ tournament_id: tid })) as Row[]).filter((m) => {
        const pr = typeof m.pairing === "string" ? JSON.parse(m.pairing) : m.pairing;
        return pr.bye === true;
      });
      expect(byeMatches).toHaveLength(3);
      for (const m of byeMatches) {
        expect(await h.db("battles").where({ match_id: m.id })).toHaveLength(0);
      }
    });

    it(`V1C_TDM_elo · ${n}v${n}: cada evento Elo coincide con la fórmula por parejas cruzadas (K/N² por pareja) y el rating final`, async () => {
      await ensure();
      for (const { battle } of await battleOutcomes(tid)) {
        const ev = (await h.db("rating_events").where({ battle_id: battle.id })) as Row[];
        expect(ev.length).toBe(2 * n);
        expect(ev.reduce((x, e) => x + Number(e.delta), 0)).toBeCloseTo(0, 6);
      }
      await expectEloTeamsCorrect(
        tid,
        teams.flatMap((x) => x.bots.map((b) => b.botId)),
      );
    });

    it(`V1C_TDM_replays · ${n}v${n}: cada batalla tiene replay servido y el torneo por equipos no escribe la tabla por bot`, async () => {
      await ensure();
      const battles = (await h.db("battles").where({ tournament_id: tid })) as Row[];
      await expectReplaysServed(battles);
      const t = (await h.db("tournaments").where({ id: tid }).first()) as Row;
      const botIds = teams.flatMap((x) => x.bots.map((b) => b.botId));
      const rows = await h
        .db("standings")
        .where({ season_id: t.season_id, mode: "team_deathmatch" })
        .whereIn("bot_id", botIds);
      expect(rows).toEqual([]);
    });
  });
