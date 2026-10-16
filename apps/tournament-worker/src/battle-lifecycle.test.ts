/**
 * DEV-B · Ciclo de vida de una batalla: reserva atómica, lease, finalización
 * EXACTAMENTE una vez y ausencia de agente por defecto (TD-002).
 *
 * BD: PostgreSQL embebido (startTestDb). Los ejecutores son guionizados donde
 * lo que se prueba es la cola/reserva; el motor real (driver en proceso) donde
 * lo que se prueba es la traducción vehículo→bot de las descalificaciones.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { enqueueJob, type JobRow } from "./queue.js";
import { TournamentWorker } from "./worker.js";
import {
  claimBattle,
  makeRunBattleHandler,
  markBattleForReview,
  type BattleContext,
  type BattleExecution,
} from "./battle-runner.js";
import { makeEngineExecutor } from "./engine-executor.js";
import { testStubAgents } from "./testing/stub-agents.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let h: TestDbHandle;
let bots: TestBot[];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  bots = await createBots(h.db, 4, "lc");
}, 120_000);

afterAll(async () => {
  await h.stop();
});

function scripted(log: Map<string, number>, gate?: Promise<void>, winner = "A") {
  return async (ctx: BattleContext): Promise<BattleExecution> => {
    log.set(ctx.battle.id, (log.get(ctx.battle.id) ?? 0) + 1);
    if (gate) await gate;
    return {
      winner,
      ticks: 42,
      score: { A: winner === "A" ? 1 : 0, B: winner === "B" ? 1 : 0 },
      finalStateHash: `h-${winner}`,
      disqualified: [],
      versions: { engine: "test" },
      cpuMsByBot: { [bots[0].botId]: 12.5 },
    };
  };
}

function fakeJob(battleId: string, id: string, attempts = 1): JobRow {
  return { id, kind: "run_battle", payload: { battleId }, attempts } as unknown as JobRow;
}

describe("B5 · reserva atómica", () => {
  it("8 reservas en paralelo sobre la misma batalla: exactamente UNA gana", async () => {
    const id = await insertScheduledBattle(h.db, bots[0], bots[1]);
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => claimBattle(h.db, id, `w${i}`)));
    expect(res.filter((r) => r !== null).length).toBe(1);
    const row = await h.db("battles").where({ id }).first();
    expect(row.status).toBe("running");
    expect(row.run_attempts).toBe(1);
    expect(row.lease_expires_at).toBeTruthy();
  });

  it("dos trabajos DUPLICADOS de la misma batalla con dos workers: se ejecuta UNA vez", async () => {
    const id = await insertScheduledBattle(h.db, bots[0], bots[1]);
    await enqueueJob(h.db, "run_battle", { battleId: id }, { dedupeKey: `dupA:${id}` });
    await enqueueJob(h.db, "run_battle", { battleId: id }, { dedupeKey: `dupB:${id}` });
    const log = new Map<string, number>();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const mk = (wid: string) =>
      new TournamentWorker({
        db: h.db,
        workerId: wid,
        handlers: { run_battle: makeRunBattleHandler({ executor: scripted(log, gate) }) },
        onExhausted: (job) => markBattleForReview(h.db, job),
      });
    const w1 = mk("dup-w1");
    const w2 = mk("dup-w2");
    const p1 = w1.runOnce();
    const p2 = w2.runOnce();
    setTimeout(open, 300);
    await Promise.all([p1, p2]);
    expect(log.get(id)).toBe(1);
    const row = await h.db("battles").where({ id }).first();
    expect(row.status).toBe("finished"); // el duplicado NO la tumbó a failed
    const jobs = await h.db("jobs").whereRaw("payload->>'battleId' = ?", [id]).where({ kind: "run_battle" });
    const busy = jobs.find((j: { last_error: string | null }) => String(j.last_error).includes("battle_busy"));
    expect(busy).toBeTruthy(); // el duplicado se reconoce como tal, no como bug
    const followUps = await h.db("jobs").where({ dedupe_key: `process_result:${id}` });
    expect(followUps.length).toBe(1);
  });
});

describe("B5 · finalización EXACTAMENTE una vez", () => {
  it("un titular cuya reserva caducó y fue recuperada por otro NO puede cerrar la batalla", async () => {
    const id = await insertScheduledBattle(h.db, bots[0], bots[1]);
    const log = new Map<string, number>();
    let openA!: () => void;
    const gateA = new Promise<void>((r) => (openA = r));
    // Lease largo: la renovación no interfiere; simulamos que "se pierde el tiempo"
    // del titular A caducando su lease a mano (es un test de reserva, no un E2E).
    const handlerA = makeRunBattleHandler({ executor: scripted(log, gateA, "A"), leaseMs: 600_000 });
    const handlerB = makeRunBattleHandler({ executor: scripted(log, undefined, "B"), leaseMs: 600_000 });

    const runA = handlerA(fakeJob(id, "00000000-0000-0000-0000-00000000000a"), { db: h.db, workerId: "A" });
    // Espera a que A tenga la reserva.
    for (let i = 0; i < 50; i++) {
      const r = await h.db("battles").where({ id }).first();
      if (r.status === "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await h.db("battles").where({ id }).update({ lease_expires_at: h.db.raw("now() - interval '1 second'") });
    await handlerB(fakeJob(id, "00000000-0000-0000-0000-00000000000b"), { db: h.db, workerId: "B" });
    openA();
    await expect(runA).rejects.toThrow(/battle_busy/);

    const row = await h.db("battles").where({ id }).first();
    expect(row.status).toBe("finished");
    expect(row.result.winner).toBe("B"); // el cierre de A NO pisó el de B
    expect(row.final_state_hash).toBe("h-B");
    expect(row.run_attempts).toBe(2);
    expect(log.get(id)).toBe(2);
    const followUps = await h.db("jobs").where({ dedupe_key: `process_result:${id}` });
    expect(followUps.length).toBe(1);
  });

  it("BATTLE_RESULT v1: shape, outcome por bot y cpu_ms en la misma transacción", async () => {
    const id = await insertScheduledBattle(h.db, bots[0], bots[1]);
    const handler = makeRunBattleHandler({ executor: scripted(new Map()) });
    await handler(fakeJob(id, "00000000-0000-0000-0000-0000000000c1"), { db: h.db, workerId: "R" });
    const row = await h.db("battles").where({ id }).first();
    expect(row.result).toEqual({
      schema: "battle-result/v1",
      winner: "A",
      ticks: 42,
      score: { A: 1, B: 0 },
      disqualified: [],
      endReason: "completed",
      agents: "scripted",
    });
    expect(row.started_at).toBeTruthy();
    expect(row.finished_at).toBeTruthy();
    expect(row.lease_expires_at).toBeNull();
    const ps = await h.db("participants").where({ battle_id: id }).orderBy("team");
    expect(ps.map((p: { outcome: string }) => p.outcome)).toEqual(["win", "loss"]);
    expect(Number(ps[0].cpu_ms)).toBe(12.5);
    expect(ps[1].cpu_ms).toBeNull(); // no medido ⇒ NULL, nunca un número inventado
  });

  it("una versión SUSPENDIDA tras agendar queda descalificada administrativamente (walkover)", async () => {
    const id = await insertScheduledBattle(h.db, bots[2], bots[3]);
    await h.db("bot_versions").where({ bot_id: bots[3].botId, version: 1 }).update({ state: "suspended" });
    const log = new Map<string, number>();
    const handler = makeRunBattleHandler({ executor: scripted(log) });
    await handler(fakeJob(id, "00000000-0000-0000-0000-0000000000d1"), { db: h.db, workerId: "S" });
    await h.db("bot_versions").where({ bot_id: bots[3].botId, version: 1 }).update({ state: "published" });
    expect(log.get(id)).toBeUndefined(); // no se lanzó nada
    const row = await h.db("battles").where({ id }).first();
    expect(row.result.endReason).toBe("walkover");
    const loser = await h.db("participants").where({ battle_id: id, bot_id: bots[3].botId }).first();
    expect(loser.outcome).toBe("disqualified");
  });
});

describe("B3 · sin agente por defecto", () => {
  it("makeEngineExecutor sin driver LANZA (ya no hay HunterBot implícito)", () => {
    expect(() => makeEngineExecutor({ db: h.db })).toThrow(/falta el driver de agentes/);
  });

  it("los stubs se niegan a construirse con NODE_ENV=production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => testStubAgents()).toThrow(/NODE_ENV=production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("main.ts (entrypoint de producción) no importa stubs ni testing/", () => {
    const src = readFileSync(join(__dirname, "main.ts"), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(5);
    for (const spec of imports) {
      expect(spec).not.toMatch(/stubs|testing\//);
    }
    expect(src).toMatch(/containerAgents\(/);
  });
});

describe("B6 · descalificación del MOTOR → participants.outcome del BOT", () => {
  it("un bot que nunca responde lo descalifica el motor y su outcome es `disqualified`", async () => {
    const id = await insertScheduledBattle(h.db, bots[0], bots[1]);
    const executor = makeEngineExecutor({
      db: h.db,
      rulesetOverrides: { timeLimitTicks: 600, maxConsecutiveTimeouts: 3 },
      agentResolver: (botId) => ({
        botId,
        decide: (obs: { tick: number }) =>
          botId === bots[1].botId ? null : { forTick: obs.tick, move: { throttle: 0, steer: 0 } },
      }),
    });
    const handler = makeRunBattleHandler({ executor });
    await handler(fakeJob(id, "00000000-0000-0000-0000-0000000000e1"), { db: h.db, workerId: "DQ" });
    const row = await h.db("battles").where({ id }).first();
    expect(row.result.disqualified).toContain(bots[1].botId);
    expect(row.result.disqualified.every((x: string) => !x.startsWith("veh_"))).toBe(true);
    const silent = await h.db("participants").where({ battle_id: id, bot_id: bots[1].botId }).first();
    expect(silent.outcome).toBe("disqualified");
  }, 120_000);
});
