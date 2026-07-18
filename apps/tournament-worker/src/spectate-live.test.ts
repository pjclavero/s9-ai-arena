/**
 * H2 (issue #6) · Cableado worker (E9) → gateway de espectador (E8) → stats
 * ricas (E8): lo que la auditoría 2026-07-16 señaló como "el hueco funcional
 * más visible". Este test NO compone las piezas a mano (eso ya lo hacía el E2E
 * de T12.1): comprueba que el PROPIO worker de producción, vía
 * makeDefaultHandlers({ spectate }), registra la batalla en vivo y genera las
 * stats ricas al archivar el replay.
 *
 *  - Un espectador ANÓNIMO (ticket real de la API de E7) ve la batalla del
 *    torneo EN DIRECTO: init + snapshots ANTES del resultado.
 *  - El attach lleva `meta.round` (sugerencia de E11, decisión 2) para que la
 *    vista broadcast muestre el progreso sin tocar el contrato.
 *  - Al terminar, el replay queda en el almacén REAL de E8 (T8.1) y
 *    `battle_stats` contiene las stats ricas de runStatsJob (T8.4).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import { WebSocket } from "ws";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { createApp } from "../../api/src/app.js";
import { FakeBotManager } from "../../api/src/services/bot-manager.js";
import { SpectateGateway, type AttachOptions, type SpectatableBattle } from "../../api/src/spectate/gateway.js";
import { readIndex } from "../../replay-service/src/store.js";
import { TournamentWorker } from "./worker.js";
import { makeDefaultHandlers } from "./engine-executor.js";
import { enqueueJob } from "./queue.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";

let h: TestDbHandle;
let app: Express;
let bots: TestBot[];
let worker: TournamentWorker;
let gateway: SpectateGateway;
let replaysDir: string;

/** Registro de attaches: verifica el meta (round) sin abrir la caja del gateway. */
const attached: { battleId: string; meta: Record<string, unknown> }[] = [];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new FakeBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  bots = await createBots(h.db, 2, "h2");
  replaysDir = mkdtempSync(join(tmpdir(), "h2-replays-"));

  gateway = new SpectateGateway(); // WS real en puerto efímero
  const wired = await makeDefaultHandlers({
    db: h.db,
    // Sin muerte súbita: la batalla dura timeLimitTicks para que el espectador
    // tenga tiempo real de conectarse EN VIVO (el motor cede el bucle por ticks).
    rulesetOverrides: { timeLimitTicks: 4800, scoreToWin: 999 },
    replaysDir,
    spectate: {
      attachBattle: (battleId: string, battle: SpectatableBattle, opts: AttachOptions = {}) => {
        attached.push({ battleId, meta: (opts.meta ?? {}) as Record<string, unknown> });
        gateway.attachBattle(battleId, battle, { ...opts, pollIntervalMs: 5 });
      },
      detachBattle: (battleId: string) => gateway.detachBattle(battleId),
    },
    spectateDetachDelayMs: 60_000, // el test lee el feed tras el final; el timer va unref()
  });
  worker = new TournamentWorker({
    db: h.db,
    workerId: "h2-worker",
    handlers: wired.handlers,
    onExhausted: (job, ctx) => wired.onExhausted(ctx.db, job),
  });
}, 180_000);

afterAll(async () => {
  gateway.close();
  await h.stop();
});

describe("H2 · el worker cablea el espectador en vivo y las stats ricas de E8", () => {
  let battleId: string;
  const messages: Array<Record<string, unknown>> = [];

  it("una batalla de torneo ejecutada por el worker se ve EN DIRECTO con ticket anónimo", async () => {
    // Torneo + match REALES en BD (round 2): el attach debe llevar meta.round.
    const [t] = await h
      .db("tournaments")
      .insert({
        name: "h2-live",
        format: "round_robin",
        mode: "deathmatch",
        ruleset_id: "mvp-default",
        state: "running",
      })
      .returning("id");
    const [m] = await h
      .db("matches")
      .insert({
        tournament_id: t.id,
        round: 2,
        state: "running",
        slot: "h2-r2m1",
        pairing: JSON.stringify({ home: bots[0].botId, away: bots[1].botId }),
      })
      .returning("id");
    battleId = await insertScheduledBattle(h.db, bots[0], bots[1], {
      official: true,
      tournamentId: t.id as string,
      matchId: m.id as string,
      seed: "h2-spectate-live",
    });
    await enqueueJob(h.db, "run_battle", { battleId }, { dedupeKey: `h2:${battleId}` });

    // La batalla corre en el worker; el espectador se conecta MIENTRAS corre.
    const drained = worker.drain();

    let ws: WebSocket | null = null;
    const deadline = Date.now() + 60_000;
    while (!ws && Date.now() < deadline) {
      // Ticket de UN SOLO USO: uno nuevo por intento (el jti se quema al conectar).
      const tk = await request(app).post(`/battles/${battleId}/spectate-ticket`);
      expect(tk.status).toBe(201);
      const candidate = new WebSocket(
        `ws://127.0.0.1:${gateway.port}/spectate/${battleId}?ticket=${encodeURIComponent(tk.body.ticket)}`,
      );
      const ok = await new Promise<boolean>((resolve) => {
        candidate.once("message", (d) => {
          messages.push(JSON.parse(d.toString()));
          resolve(true);
        });
        candidate.once("close", () => resolve(false));
        candidate.once("error", () => resolve(false));
      });
      if (ok) ws = candidate;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(ws, "el espectador no llegó a conectarse al feed en vivo").toBeTruthy();
    ws!.on("message", (d) => messages.push(JSON.parse(d.toString())));

    // Stream hasta el resultado (o hasta que la cola termine y el pump vacíe).
    await drained;
    await new Promise((r) => setTimeout(r, 300)); // el pump entrega lo pendiente
    ws!.close();

    const types = messages.map((msg) => msg.type);
    expect(types[0]).toBe("init");
    const init = messages[0] as { finished?: boolean; meta?: Record<string, unknown> };
    expect(init.finished, "el espectador llegó tarde: la batalla ya había terminado").toBe(false);
    expect(types.filter((x) => x === "snapshot").length).toBeGreaterThan(3); // directo real
    expect(types).toContain("result");
    // El resultado emitido es el oficial que persiste el worker.
    const battle = await h.db("battles").where({ id: battleId }).first();
    expect(battle.status).toBe("finished");
    const resultMsg = messages.find((msg) => msg.type === "result") as { result: { finalStateHash: string } };
    expect(resultMsg.result.finalStateHash).toBe(battle.final_state_hash);

    // D8: el canal público no filtra observaciones privadas ni capas debug.
    const raw = JSON.stringify(messages);
    expect(raw).not.toContain("observation");
    expect(raw).not.toContain("privateEvents");
    expect(types).not.toContain("debug");

    // meta.round de E11: la vista broadcast puede mostrar el progreso.
    expect(attached.length).toBe(1);
    expect(attached[0].battleId).toBe(battleId);
    expect(attached[0].meta.round).toBe(2);
    expect(attached[0].meta.mode).toBe("deathmatch");
    expect(attached[0].meta.tournamentId).toBe(t.id);
  }, 120_000);

  it("al archivar el replay quedan el almacén de E8 y las stats RICAS de runStatsJob", async () => {
    const battle = await h.db("battles").where({ id: battleId }).first();
    // Replay en el almacén REAL de E8 (T8.1): archivo comprimido + índice.
    expect(String(battle.replay_ref).endsWith(`${battleId}.replay`)).toBe(true);
    expect(existsSync(battle.replay_ref)).toBe(true);
    const index = readIndex(replaysDir, battleId);
    expect(index).not.toBeNull();
    expect(index!.official).toBe(true);
    expect(index!.sha256).toBe(battle.replay_hash);

    // Stats ricas de E8 (T8.4): los campos que leen los agregados de E9.
    const rows = await h.db("battle_stats").where({ battle_id: battleId });
    expect(rows.length).toBe(2);
    for (const r of rows) {
      const s = typeof r.stats === "string" ? JSON.parse(r.stats) : r.stats;
      for (const field of ["damageDealt", "shotsFired", "shotsHit", "died", "perModule", "battle"]) {
        expect(s, `battle_stats.${field}`).toHaveProperty(field);
      }
    }
  });
});
