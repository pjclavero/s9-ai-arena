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
import { makeDefaultHandlers, inProcessAgents } from "./engine-executor.js";
import { HunterBot, IdleBot } from "../../arena-engine/src/stubs.js";
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
 * Dos niveles de agente EN PROCESO: los bots "fuertes" (HunterBot) ganan a los "débiles" (IdleBot,
 * que no dispara); entre iguales hay empate. Así hay victorias, derrotas y empates reales que el
 * oráculo puede contar (con todos iguales el motor empata a 0-0 y nada discrimina).
 */
const strong = new Set<string>();

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
    agents: inProcessAgents((botId) => (strong.has(botId) ? new HunterBot(botId) : new IdleBot())),
    rulesetOverrides: { timeLimitTicks: 360, scoreToWin: 1 },
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
  // Orden: el puesto sigue al rating (la temporada agrega torneos; los bots de este son propios).
  const byRank = [...rows].sort((a, b) => Number(a.rank) - Number(b.rank));
  const ratings = byRank.map((r) => Number(r.rating));
  expect(ratings).toEqual([...ratings].sort((a, b) => b - a));
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
    // 3 rondas del método del círculo: 3 enfrentamientos reales + 3 descansos (byes) sin batalla.
    expect(matches.filter((m) => !(typeof m.pairing === "string" ? JSON.parse(m.pairing) : m.pairing).bye).length).toBe(
      3,
    );
    const final = matches.find((m) => m.final)!;
    expect(final).toBeTruthy();
    expect(final.winner_bot_id).toBe(t.champion_bot_id);
    // Cada match lo gana quien el MOTOR declaró vencedor; si la batalla fue empate, desempata el seed.
    const rows = await battleOutcomes(tid);
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

// ------------------------------------------------- Team Deathmatch 2v2

for (const n of [2, 3, 4])
  describe(`V1-C · Team Deathmatch por equipos ${n}v${n} de principio a fin`, () => {
    let tid: string;
    const teams: { teamId: string; bots: TestBot[] }[] = [];
    const teamOf = new Map<string, string>();

    it(`V1C_TDM_cycle · ${n}v${n}: inscripción de EQUIPOS, cierre, ejecución con el motor y torneo terminado`, async () => {
      // 3 equipos de 2 bots; el developer es capitán/miembro de los tres.
      for (let i = 0; i < 3; i++) {
        const [team] = await h
          .db("teams")
          .insert({ name: `v1c-team-${++seq}`, captain_id: developerId })
          .returning("*");
        await h.db("team_members").insert({ team_id: team.id, user_id: developerId, role: "captain" });
        // Equipo 0: todos fuertes; equipo 1: mitad y mitad; equipo 2: todos débiles (hay victorias, derrotas y empates).
        const strongCount = [n, Math.floor(n / 2), 0][i];
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

      for (const t of teams) {
        const r = await request(app)
          .post(`/tournaments/${tid}/team-entries`)
          .set(as(developer))
          .send({ teamId: t.teamId, members: t.bots.map((b) => ({ botId: b.botId, version: 1 })) });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.entries.length).toBe(n);
      }
      await closeEntries(tid);
      await drainAll();

      // 3 equipos → liguilla: 3 enfrentamientos reales (una batalla NvN cada uno) + 3 descansos (byes).
      const { matches } = await expectFinishedCleanly(tid, 3);
      const real = matches.filter((m) => !(typeof m.pairing === "string" ? JSON.parse(m.pairing) : m.pairing).bye);
      expect(real.length).toBe(3);
    });

    it(`V1C_TDM_roster · ${n}v${n}: cada batalla enfrenta DOS bandos, cada uno la plantilla COMPLETA de un equipo inscrito`, async () => {
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

    /** Oráculo por equipos: 3/1/0 por BANDO desde participants.outcome. */
    async function teamOracle() {
      const oracle = new Map<string, { points: number; wins: number; losses: number; draws: number }>();
      for (const x of teams) oracle.set(x.teamId, { points: 0, wins: 0, losses: 0, draws: 0 });
      for (const { parts } of await battleOutcomes(tid)) {
        const perTeam = new Map<string, unknown>();
        for (const p of parts) perTeam.set(teamOf.get(p.bot_id as string)!, p.outcome);
        for (const [teamId, outcome] of perTeam) {
          const r = oracle.get(teamId)!;
          if (outcome === "win") ((r.points += 3), r.wins++);
          else if (outcome === "draw") ((r.points += 1), r.draws++);
          else r.losses++;
        }
      }
      return oracle;
    }

    it(`V1C_TDM_standings · ${n}v${n}: derrotas, empates y orden de la clasificación por equipos coinciden con el oráculo`, async () => {
      const st = await request(app).get(`/tournaments/${tid}/team-standings`);
      expect(st.status, JSON.stringify(st.body)).toBe(200);
      expect(st.body.length).toBe(3);
      const oracle = await teamOracle();
      for (const row of st.body as Row[]) {
        const o = oracle.get(row.teamId as string)!;
        expect({ l: row.losses, d: row.draws }).toEqual({ l: o.losses, d: o.draws });
        // Con 3 equipos cada uno descansa UNA ronda (bye): la tabla le suma 3 puntos y una victoria
        // (defecto V1C-D01). Aquí se verifica el resto: puntos y victorias = oráculo + el descanso.
        expect({ p: row.points, w: row.wins }).toEqual({ p: o.points + 3, w: o.wins + 1 });
      }
      // Orden por puntos descendente y líder = máximo del oráculo.
      const pts = (st.body as Row[]).map((r) => Number(r.points));
      expect(pts).toEqual([...pts].sort((a, b) => b - a));
      const maxPts = Math.max(...[...oracle.values()].map((o) => o.points));
      expect(oracle.get((st.body as Row[])[0].teamId as string)!.points).toBe(maxPts);
    });

    // V1C-D01 · el descanso (bye) de un round robin de equipos puntúa como victoria disputada.
    // `it.fails`: pasa MIENTRAS el defecto exista y se pone rojo cuando se corrija (entonces hay que
    // quitar `.fails` y la compensación `+ 3` del test anterior).
    it.fails(
      `V1C_TDM_bye_defect · ${n}v${n}: el descanso NO debería sumar puntos ni victorias a la tabla por equipos`,
      async () => {
        const st = await request(app).get(`/tournaments/${tid}/team-standings`);
        const oracle = await teamOracle();
        for (const row of st.body as Row[]) {
          const o = oracle.get(row.teamId as string)!;
          expect({ p: row.points, w: row.wins }).toEqual({ p: o.points, w: o.wins });
        }
      },
    );

    it(`V1C_TDM_elo · ${n}v${n}: cada batalla escribe ${2 * n} eventos Elo de suma cero; los del bando vencedor suben y los del vencido bajan`, async () => {
      for (const { battle, parts } of await battleOutcomes(tid)) {
        const ev = (await h.db("rating_events").where({ battle_id: battle.id })) as Row[];
        expect(ev.length).toBe(2 * n);
        expect(ev.reduce((x, e) => x + Number(e.delta), 0)).toBeCloseTo(0, 6);
        for (const e of ev) {
          const o = parts.find((p) => p.bot_id === e.bot_id)!.outcome;
          // Con rating inicial parejo, un bando que gana nunca baja y uno que pierde nunca sube.
          if (o === "win") expect(Number(e.delta)).toBeGreaterThanOrEqual(0);
          if (o === "loss") expect(Number(e.delta)).toBeLessThanOrEqual(0);
        }
      }
    });

    it(`V1C_TDM_replays · ${n}v${n}: cada batalla tiene replay servido y el torneo por equipos no escribe la tabla por bot`, async () => {
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
