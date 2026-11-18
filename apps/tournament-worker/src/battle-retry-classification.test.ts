/**
 * Release 0.5.0 · PR A · lo que hace la COLA con cada clase (BD real embebida).
 *
 *  - error de pool/Knex en el ejecutor → se reintenta con backoff (no `unclassified`);
 *  - fallo permanente → agota los reintentos y la batalla queda para revisión;
 *  - battle_timeout → un solo reintento;
 *  - un bug real (TypeError) no se confunde con un fallo de BD.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { enqueueJob } from "./queue.js";
import { TournamentWorker } from "./worker.js";
import { InfrastructureFailure } from "./errors.js";
import {
  makeRunBattleHandler,
  markBattleForReview,
  type BattleContext,
  type BattleExecution,
} from "./battle-runner.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";

let h: TestDbHandle;
let bots: TestBot[];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  bots = await createBots(h.db, 4, "rc");
}, 120_000);
afterAll(async () => {
  await h.stop();
});

const knexTimeout = () =>
  Object.assign(new Error("Knex: Timeout acquiring a connection. The pool is probably full."), {
    name: "KnexTimeoutError",
  });

function workerWith(executor: (ctx: BattleContext) => Promise<BattleExecution>, id: string) {
  return new TournamentWorker({
    db: h.db,
    workerId: id,
    handlers: { run_battle: makeRunBattleHandler({ executor }) },
    onExhausted: (job) => markBattleForReview(h.db, job),
    lockTimeoutMs: 1000,
  });
}

const ok = async (ctx: BattleContext): Promise<BattleExecution> => ({
  winner: "A",
  ticks: 100,
  score: { A: 3, B: 1 },
  finalStateHash: `h-${ctx.battle.id}`,
  disqualified: [],
  versions: { engine: "test" },
});

async function setupJob(key: string, a = 0, b = 1) {
  const battleId = await insertScheduledBattle(h.db, bots[a], bots[b]);
  await enqueueJob(h.db, "run_battle", { battleId }, { dedupeKey: `${key}:${battleId}`, maxAttempts: 3 });
  return { battleId, key: `${key}:${battleId}` };
}
const jobOf = (key: string) => h.db("jobs").where({ dedupe_key: key }).first();
const battleOf = (id: string) => h.db("battles").where({ id }).first();

describe("F3 · error de pool de Knex: se reintenta, no queda `unclassified`", () => {
  it("el primer intento falla por pool, vuelve a la cola con backoff y el segundo termina la batalla", async () => {
    const { battleId, key } = await setupJob("pool");
    let n = 0;
    const w = workerWith(async (ctx) => {
      if (++n === 1) throw knexTimeout();
      return ok(ctx);
    }, "pool-w");

    const t0 = new Date();
    await w.runOnce(t0);
    const j1 = await jobOf(key);
    expect(j1.status).toBe("queued"); // NO needs_review
    expect(j1.error_class).toBe("infrastructure");
    expect(j1.last_error).toMatch(/^\[db_unavailable\]/);
    expect(new Date(j1.run_after).getTime()).toBeGreaterThan(t0.getTime() + 5_000); // backoff real
    expect((await battleOf(battleId)).status).toBe("scheduled"); // la reserva se devolvió

    // dentro del backoff no se reclama; pasado el backoff, sí
    expect(await w.runOnce(new Date(t0.getTime() + 1000))).toBe(false);
    await w.runOnce(new Date(t0.getTime() + 300_000));
    expect((await battleOf(battleId)).status).toBe("finished");
    expect((await jobOf(key)).status).toBe("done");
    expect(n).toBe(2);
  });

  it("un error de BD que llega al worker SIN pasar por el runner también se reintenta", async () => {
    await enqueueJob(h.db, "tournament_dry_run", {}, { dedupeKey: "dry-eai", maxAttempts: 3 });
    process.env.PGHOST = "postgres"; // el endpoint de la BD contra el que se compara el origen
    let n = 0;
    const w = new TournamentWorker({
      db: h.db,
      workerId: "eai-w",
      handlers: {
        tournament_dry_run: async () => {
          if (++n === 1)
            throw Object.assign(new Error("getaddrinfo EAI_AGAIN postgres"), {
              code: "EAI_AGAIN",
              hostname: "postgres",
            });
        },
      },
    });
    const t0 = new Date();
    await w.runOnce(t0);
    const j = await jobOf("dry-eai");
    expect(j.status).toBe("queued");
    expect(j.last_error).toMatch(/^\[db_unavailable\]/);
    await w.runOnce(new Date(t0.getTime() + 300_000));
    expect((await jobOf("dry-eai")).status).toBe("done");
    delete process.env.PGHOST;
  });
});

describe("fallo permanente: agota los reintentos y NO se reintenta sin fin", () => {
  it("un pool que nunca responde: exactamente el tope PROPIO de db_unavailable (8), luego revisión manual", async () => {
    const { battleId, key } = await setupJob("perm", 2, 3);
    let n = 0;
    const w = workerWith(async () => {
      n++;
      throw knexTimeout();
    }, "perm-w");
    let now = new Date();
    for (let i = 0; i < 14; i++) {
      await w.runOnce(now);
      now = new Date(now.getTime() + 600_000);
    }
    expect(n).toBe(8); // más que max_attempts=3 del trabajo: la BD tiene su ventana propia
    const j = await jobOf(key);
    expect(j.status).toBe("needs_review");
    expect(j.attempts).toBe(8);
    expect(j.error_class).toBe("infrastructure");
    const b = await battleOf(battleId);
    expect(b.status).toBe("failed");
    expect(b.failure_kind).toBe("infrastructure");
  });
});

describe("F2 · battle_timeout: UN solo reintento", () => {
  it("el primer timeout se reintenta tras una pausa larga; el segundo va a revisión manual", async () => {
    const { battleId, key } = await setupJob("bto", 0, 2);
    let n = 0;
    const w = workerWith(async () => {
      n++;
      throw new InfrastructureFailure(
        "battle_timeout",
        "timeout global de la batalla tras 397500 ms (jugó 8800/9000 ticks)",
      );
    }, "bto-w");

    const t0 = new Date();
    await w.runOnce(t0);
    const j1 = await jobOf(key);
    expect(j1.status).toBe("queued");
    expect(j1.last_error).toMatch(/^\[battle_timeout\]/);
    expect(new Date(j1.run_after).getTime()).toBeGreaterThanOrEqual(t0.getTime() + 60_000);

    await w.runOnce(new Date(t0.getTime() + 600_000));
    const j2 = await jobOf(key);
    expect(j2.status).toBe("needs_review"); // 2 intentos y se acabó, aunque max_attempts sea 3
    expect(j2.attempts).toBe(2);
    expect(n).toBe(2);
    expect((await battleOf(battleId)).status).toBe("failed");

    // y no hay un tercero aunque pase el tiempo
    expect(await w.runOnce(new Date(t0.getTime() + 3_600_000))).toBe(false);
    expect(n).toBe(2);
  });
});

describe("P2-3 · el reintento de battle_timeout se cuenta POR CLASE", () => {
  const timeout = () =>
    new InfrastructureFailure("battle_timeout", "timeout global de la batalla (jugó 8800/9000 ticks)");

  it("un fallo de OTRA clase en el intento 1 y un timeout en el 2 sigue dando UN reintento", async () => {
    const { battleId, key } = await setupJob("cls", 0, 3);
    let n = 0;
    const w = workerWith(async (ctx) => {
      n++;
      if (n === 1) throw new InfrastructureFailure("map_unavailable", "mapa no descargable");
      if (n === 2) throw timeout();
      return ok(ctx);
    }, "cls-w");
    const t0 = new Date();
    await w.runOnce(t0);
    expect((await jobOf(key)).status).toBe("queued");

    await w.runOnce(new Date(t0.getTime() + 600_000)); // intento 2: PRIMER timeout
    const j2 = await jobOf(key);
    expect(j2.last_error).toMatch(/^\[battle_timeout\]/);
    expect(j2.status).toBe("queued"); // conserva su reintento aunque ya van 2 intentos

    await w.runOnce(new Date(t0.getTime() + 1_200_000)); // intento 3 termina bien
    expect((await jobOf(key)).status).toBe("done");
    expect((await battleOf(battleId)).status).toBe("finished");
    expect(n).toBe(3);
  });

  it("dos timeouts intercalados con otra clase: el segundo timeout ya va a revisión", async () => {
    const { key } = await setupJob("cls2", 1, 2);
    let n = 0;
    const w = workerWith(async () => {
      n++;
      if (n === 2) throw new InfrastructureFailure("map_unavailable", "x");
      throw timeout();
    }, "cls2-w");
    const t0 = new Date();
    // max_attempts del trabajo = 3: timeout, otra clase, timeout → el contador por clase llega a 2
    await w.runOnce(t0);
    await w.runOnce(new Date(t0.getTime() + 600_000));
    await w.runOnce(new Date(t0.getTime() + 1_200_000));
    const j = await jobOf(key);
    expect(j.status).toBe("needs_review");
    expect(j.payload._failureCounts).toEqual({ battle_timeout: 2, map_unavailable: 1 });
    expect(n).toBe(3);
  });
});

describe("P2-2 · un error de red que NO viene de la BD no se etiqueta db_unavailable", () => {
  it("ECONNREFUSED del docker-proxy en el ejecutor → engine_start_failure (como antes), no db_unavailable", async () => {
    const { key } = await setupJob("dkr", 0, 1);
    const w = workerWith(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 10.9.0.5:2375"), {
        code: "ECONNREFUSED",
        address: "10.9.0.5",
        port: 2375,
      });
    }, "dkr-w");
    await w.runOnce(new Date());
    const j = await jobOf(key);
    expect(j.last_error).toMatch(/^\[engine_start_failure\]/);
    expect(j.last_error).not.toMatch(/db_unavailable/);
  });

  it("ECONNREFUSED de Redis/WS en un handler sin runner → unclassified (revisión inmediata), no db_unavailable", async () => {
    await enqueueJob(h.db, "tournament_dry_run", {}, { dedupeKey: "dry-redis", maxAttempts: 3 });
    const w = new TournamentWorker({
      db: h.db,
      workerId: "redis-w",
      handlers: {
        tournament_dry_run: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED 10.9.0.8:6379"), {
            code: "ECONNREFUSED",
            address: "10.9.0.8",
            port: 6379,
          });
        },
      },
    });
    await w.runOnce(new Date());
    const j = await jobOf("dry-redis");
    expect(j.status).toBe("needs_review");
    expect(j.last_error).toMatch(/^\[unclassified\]/);
  });
});

describe("regresión: un bug real no se confunde con un fallo de BD", () => {
  it("TypeError en el ejecutor → engine_start_failure como siempre, nunca db_unavailable", async () => {
    const { key } = await setupJob("bug", 1, 3);
    let n = 0;
    const w = workerWith(async () => {
      n++;
      throw new TypeError("Cannot read properties of undefined (reading 'x')");
    }, "bug-w");
    await w.runOnce(new Date());
    const j = await jobOf(key);
    expect(j.last_error).toMatch(/^\[engine_start_failure\]/);
    expect(j.last_error).not.toMatch(/db_unavailable/);
    expect(n).toBe(1);
  });
});
