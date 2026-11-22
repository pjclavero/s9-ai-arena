/**
 * V1-P0 · estabilidad del tournament-worker (fase 2). PostgreSQL REAL embebida (harness de E7).
 *
 * Causa raíz (CTF 4v4 atascadas en `running`): `claimJob` re-reclamaba un trabajo `running` con
 * el lock vencido SIN mirar `max_attempts`; nada barría las batallas `running` con el lease
 * vencido; un OOM no ejecuta ningún `finally`. Cada `describe` lleva el nombre del test que mata
 * su mutante (ver tests/mutants/v1-worker-stability/run.py).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { claimJob, enqueueJob, parkExhaustedStaleJobs, type JobRow } from "./queue.js";
import { TournamentWorker } from "./worker.js";
import {
  claimBattle,
  makeRunBattleHandler,
  markBattleForReview,
  type BattleContext,
  type BattleExecution,
} from "./battle-runner.js";
import { onBattleJobExhausted } from "./battle-failure.js";
import { reapAtStartup, reapOnce } from "./battle-reaper.js";
import { sweepExpiredBattles } from "./orphan-recovery.js";
import { WorkerMetrics, workerMetrics } from "./worker-metrics.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";
import {
  LABEL_BATTLE_ID,
  LABEL_BATTLE_OWNER,
  LABEL_ROLE,
  ROLE_BATTLE_BOT,
  type ManagedContainer,
} from "../../bot-manager/src/container-runner.js";

let h: TestDbHandle;
let bots: TestBot[];

beforeAll(async () => {
  h = await startTestDb();
  await seedDev(h.db);
  bots = await createBots(h.db, 2, "v1w");
}, 120_000);
afterAll(async () => {
  await h.stop();
});
beforeEach(async () => {
  workerMetrics.reset();
  await h.db("jobs").del(); // aislamiento: claimJob elige por antigüedad entre TODOS los trabajos
});

const okExecution = (id: string): BattleExecution => ({
  winner: "A",
  ticks: 100,
  score: { A: 3, B: 1 },
  finalStateHash: `hash-${id}`,
  disqualified: [],
  versions: { engine: "test" },
});

function countingWorker(log: Map<string, number>, workerId: string, delayMs = 0) {
  return new TournamentWorker({
    db: h.db,
    workerId,
    handlers: {
      run_battle: makeRunBattleHandler({
        executor: async (ctx: BattleContext) => {
          log.set(ctx.battle.id, (log.get(ctx.battle.id) ?? 0) + 1);
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          return okExecution(ctx.battle.id);
        },
      }),
    },
    onExhausted: onBattleJobExhausted,
    lockTimeoutMs: 1000,
  });
}

async function newBattleWithJob(maxAttempts = 3): Promise<{ battleId: string; jobId: string }> {
  const battleId = await insertScheduledBattle(h.db, bots[0], bots[1]);
  const jobId = (await enqueueJob(
    h.db,
    "run_battle",
    { battleId },
    { dedupeKey: `run_battle:${battleId}`, maxAttempts },
  )) as string;
  return { battleId, jobId };
}

/**
 * Un worker que MUERE a mitad de batalla (OOM/kill -9): reclama el trabajo y la batalla y no pasa
 * por ningún `finally`. Después se envejecen el lock del trabajo y el lease de la batalla.
 */
async function dieMidBattle(battleId: string, workerId = "dead-worker", expireLease = true): Promise<JobRow> {
  const job = await claimJob(h.db, { workerId, kinds: ["run_battle"], lockTimeoutMs: 1000, now: new Date() });
  expect(job, "el trabajo debía ser reclamable").not.toBeNull();
  const claimed = await claimBattle(h.db, battleId, `${workerId}:${job!.id}:${job!.attempts}`, 45_000);
  expect(claimed, "la batalla debía poder reservarse").not.toBeNull();
  await h
    .db("jobs")
    .where({ id: job!.id })
    .update({ locked_at: h.db.raw("now() - interval '10 minutes'") });
  if (expireLease) {
    await h
      .db("battles")
      .where({ id: battleId })
      .update({ lease_expires_at: h.db.raw("now() - interval '5 minutes'") });
  }
  return job!;
}

const battleOf = (id: string) => h.db("battles").where({ id }).first();
const jobOf = (id: string) => h.db("jobs").where({ id }).first();
const auditFor = (battleId: string) =>
  h
    .db("audit_log")
    .where({ target: `battle:${battleId}` })
    .select("*");

describe("V1-P0 · reintentos agotados ⇒ terminal (claimJob respeta max_attempts)", () => {
  it("un huérfano que ya gastó max_attempts pasa a needs_review y su batalla a failed/infrastructure, con rastro", async () => {
    const { battleId, jobId } = await newBattleWithJob(2);
    await dieMidBattle(battleId);
    await dieMidBattle(battleId); // 2.º intento: attempts = 2 = max_attempts
    expect((await jobOf(jobId)).attempts).toBe(2);

    // El tercer claim NO re-reclama: aparca.
    const third = await claimJob(h.db, { workerId: "w3", kinds: ["run_battle"], lockTimeoutMs: 1000, now: new Date() });
    expect(third).toBeNull();
    const job = await jobOf(jobId);
    expect(job.status).toBe("needs_review");
    expect(job.attempts).toBe(2);
    expect(job.last_error).toMatch(/intentos agotados/);
    const battle = await battleOf(battleId);
    expect(battle.status).toBe("failed");
    expect(battle.failure_kind).toBe("infrastructure");
    expect(battle.claimed_by).toBeNull();
    const audit = await auditFor(battleId);
    expect(audit.map((a) => a.action)).toContain("worker.battle_failed_infrastructure");
    expect(JSON.stringify(audit[0].detail)).toMatch(/agotados/);
    expect(workerMetrics.counter("jobs_parked_total")).toBe(1);
  });

  it("es idempotente: repetir el claim/aparcado no duplica ni cambia nada", async () => {
    const { battleId, jobId } = await newBattleWithJob(1);
    await dieMidBattle(battleId);
    const opts = { workerId: "w", kinds: ["run_battle"] as const, lockTimeoutMs: 1000, now: new Date() };
    expect(await claimJob(h.db, { ...opts, kinds: ["run_battle"] })).toBeNull();
    const before = (await auditFor(battleId)).length;
    expect(await claimJob(h.db, { ...opts, kinds: ["run_battle"] })).toBeNull();
    expect(await parkExhaustedStaleJobs(h.db, { kinds: ["run_battle"], lockTimeoutMs: 1000 })).toEqual([]);
    expect((await auditFor(battleId)).length).toBe(before);
    expect((await jobOf(jobId)).status).toBe("needs_review");
  });

  it("con intentos disponibles SÍ se re-reclama (el límite no rompe la recuperación normal)", async () => {
    const { battleId, jobId } = await newBattleWithJob(3);
    await dieMidBattle(battleId);
    const again = await claimJob(h.db, { workerId: "w2", kinds: ["run_battle"], lockTimeoutMs: 1000, now: new Date() });
    expect(again?.id).toBe(jobId);
    expect(again?.attempts).toBe(2);
    expect(workerMetrics.counter("job_retries_total")).toBe(1);
  });

  it("markBattleForReview deja rastro en audit_log y no toca una batalla con lease vivo", async () => {
    const { battleId } = await newBattleWithJob(3);
    await claimBattle(h.db, battleId, "alive-owner", 45_000); // lease VIVO de otro titular
    await markBattleForReview(h.db, {
      kind: "run_battle",
      payload: { battleId },
      last_error: "x",
    } as unknown as JobRow);
    expect((await battleOf(battleId)).status).toBe("running");
    await h
      .db("battles")
      .where({ id: battleId })
      .update({ lease_expires_at: h.db.raw("now() - interval '1 minute'") });
    await markBattleForReview(h.db, {
      kind: "run_battle",
      payload: { battleId },
      last_error: "motivo-X",
    } as unknown as JobRow);
    expect((await battleOf(battleId)).status).toBe("failed");
    expect(JSON.stringify((await auditFor(battleId))[0].detail)).toContain("motivo-X");
  });
});

describe("V1-P0 · lease vencido ⇒ se recupera o pasa a terminal (barrido de huérfanos)", () => {
  it("quedan intentos: se reencola UNA vez (batalla scheduled + trabajo queued) y una 2.ª pasada no hace nada", async () => {
    const { battleId, jobId } = await newBattleWithJob(3);
    await dieMidBattle(battleId);
    const r1 = await sweepExpiredBattles(h.db, { lockTimeoutMs: 1000 });
    expect(r1.requeued).toContain(battleId);
    const battle = await battleOf(battleId);
    expect(battle.status).toBe("scheduled");
    expect(battle.claimed_by).toBeNull();
    expect(battle.lease_expires_at).toBeNull();
    expect((await jobOf(jobId)).status).toBe("queued");
    const r2 = await sweepExpiredBattles(h.db, { lockTimeoutMs: 1000 });
    expect([...r2.requeued, ...r2.failed]).not.toContain(battleId);
    expect((await auditFor(battleId)).filter((a) => a.action === "worker.battle_orphan_requeued")).toHaveLength(1);
  });

  it("intentos agotados: terminal (failed/infrastructure + job needs_review), sin resultado deportivo", async () => {
    const { battleId, jobId } = await newBattleWithJob(1);
    await dieMidBattle(battleId);
    const r = await sweepExpiredBattles(h.db, { lockTimeoutMs: 1000 });
    expect(r.failed).toContain(battleId);
    const battle = await battleOf(battleId);
    expect(battle.status).toBe("failed");
    expect(battle.failure_kind).toBe("infrastructure");
    expect(battle.result).toBeNull();
    expect((await h.db("participants").where({ battle_id: battleId })).every((p) => p.outcome === null)).toBe(true);
    expect((await jobOf(jobId)).status).toBe("needs_review");
    expect((await auditFor(battleId)).map((a) => a.action)).toContain("worker.battle_orphan_failed");
    expect(workerMetrics.counter("orphans_failed_total")).toBeGreaterThanOrEqual(1);
    expect(workerMetrics.gauge("jobs_needs_review")).toBeGreaterThanOrEqual(1);
  });

  it("titular posiblemente vivo (lock del trabajo fresco): no se toca", async () => {
    const { battleId, jobId } = await newBattleWithJob(3);
    await dieMidBattle(battleId);
    await h.db("jobs").where({ id: jobId }).update({ locked_at: h.db.fn.now() }); // lock fresco
    const r = await sweepExpiredBattles(h.db, { lockTimeoutMs: 60_000 });
    expect(r.skipped).toContain(battleId);
    expect((await battleOf(battleId)).status).toBe("running");
    expect((await jobOf(jobId)).status).toBe("running");
  });

  it("una batalla con lease VIGENTE no es huérfana", async () => {
    const { battleId } = await newBattleWithJob(3);
    await dieMidBattle(battleId, "alive", false);
    const r = await sweepExpiredBattles(h.db, { lockTimeoutMs: 1000 });
    expect([...r.requeued, ...r.failed, ...r.skipped]).not.toContain(battleId);
    expect((await battleOf(battleId)).status).toBe("running");
  });

  it("el worker aparca los agotados en runOnce y cierra con onExhausted (sin ejecutar nada)", async () => {
    const { battleId, jobId } = await newBattleWithJob(1);
    await dieMidBattle(battleId);
    const log = new Map<string, number>();
    const worker = countingWorker(log, "w-park");
    await worker.runOnce(new Date());
    expect(log.get(battleId) ?? 0).toBe(0);
    expect((await jobOf(jobId)).status).toBe("needs_review");
    expect((await battleOf(battleId)).status).toBe("failed");
  });
});

describe("V1-P0 · reinicio del worker a mitad de batalla ⇒ ni duplicado ni bucle", () => {
  it("tras morir una vez, el reemplazo la ejecuta EXACTAMENTE una vez y la termina", async () => {
    const { battleId, jobId } = await newBattleWithJob(3);
    await dieMidBattle(battleId);
    const log = new Map<string, number>();
    const b = countingWorker(log, "worker-b");
    await b.runOnce(new Date());
    await b.drain(5, new Date());
    expect(log.get(battleId)).toBe(1);
    expect((await battleOf(battleId)).status).toBe("finished");
    expect((await jobOf(jobId)).status).toBe("done");
  });

  it("si muere en cada intento no hay bucle: tras max_attempts es terminal y no se ejecuta más", async () => {
    const { battleId, jobId } = await newBattleWithJob(3);
    for (let i = 0; i < 3; i++) await dieMidBattle(battleId, `dead-${i}`);
    const log = new Map<string, number>();
    const b = countingWorker(log, "worker-b");
    for (let i = 0; i < 3; i++) await b.runOnce(new Date());
    expect(log.get(battleId) ?? 0).toBe(0);
    expect((await jobOf(jobId)).status).toBe("needs_review");
    expect((await jobOf(jobId)).attempts).toBe(3);
    expect((await battleOf(battleId)).status).toBe("failed");
  });

  it("barrido + reemplazo: reencolada una vez y ejecutada una vez", async () => {
    const { battleId } = await newBattleWithJob(3);
    await dieMidBattle(battleId);
    await sweepExpiredBattles(h.db, { lockTimeoutMs: 1000 });
    const log = new Map<string, number>();
    const b = countingWorker(log, "worker-b");
    await b.drain(5, new Date());
    await sweepExpiredBattles(h.db, { lockTimeoutMs: 1000 });
    await b.drain(5, new Date());
    expect(log.get(battleId)).toBe(1);
    expect((await battleOf(battleId)).status).toBe("finished");
  });
});

describe("V1-P0 · ejecuciones duplicadas imposibles", () => {
  it("cinco reservas simultáneas de la misma batalla: gana exactamente una", async () => {
    const { battleId } = await newBattleWithJob(3);
    const res = await Promise.all([1, 2, 3, 4, 5].map((i) => claimBattle(h.db, battleId, `o${i}`, 45_000)));
    expect(res.filter((r) => r !== null)).toHaveLength(1);
  });

  it("dos barridos simultáneos reencolan la batalla una sola vez", async () => {
    const { battleId } = await newBattleWithJob(3);
    await dieMidBattle(battleId);
    const [a, b] = await Promise.all([
      sweepExpiredBattles(h.db, { lockTimeoutMs: 1000 }),
      sweepExpiredBattles(h.db, { lockTimeoutMs: 1000 }),
    ]);
    expect([...a.requeued, ...b.requeued].filter((x) => x === battleId)).toHaveLength(1);
  });

  it("dos workers concurrentes sobre el mismo trabajo ejecutan la batalla una sola vez", async () => {
    const { battleId } = await newBattleWithJob(3);
    const log = new Map<string, number>();
    const w1 = countingWorker(log, "w1", 150);
    const w2 = countingWorker(log, "w2", 150);
    await Promise.all([w1.runOnce(new Date()), w2.runOnce(new Date())]);
    expect(log.get(battleId)).toBe(1);
  });

  it("el titular antiguo pierde la reserva al reencolar el barrido (no puede finalizar)", async () => {
    const { battleId } = await newBattleWithJob(3);
    await dieMidBattle(battleId, "slow-owner");
    await sweepExpiredBattles(h.db, { lockTimeoutMs: 1000 });
    const battle = await battleOf(battleId);
    expect(battle.claimed_by).toBeNull(); // renewBattleLease(owner viejo) ⇒ 0 filas ⇒ aborta
    const stale = await h.db("battles").where({ id: battleId, status: "running", claimed_by: "slow-owner:x:1" });
    expect(stale).toHaveLength(0);
  });
});

describe("V1-P0 · contenedores de bot retirados tras un fallo", () => {
  const NOW = Date.now();
  const container = (battleId: string, owner: string, ageMs = 600_000): ManagedContainer => ({
    id: `c-${battleId.slice(0, 6)}-${owner}`,
    labels: { [LABEL_ROLE]: ROLE_BATTLE_BOT, [LABEL_BATTLE_ID]: battleId, [LABEL_BATTLE_OWNER]: owner },
    state: "running",
    createdAtMs: NOW - ageMs,
  });
  const fakeRunner = (list: ManagedContainer[]) => {
    const removed: string[] = [];
    return {
      removed,
      runner: {
        list: async () => list,
        removeById: async (id: string) => void removed.push(id),
      },
    };
  };

  it("`failed` y `running` con el lease vencido se retiran; `running` con lease vigente se conserva", async () => {
    const failedId = (await newBattleWithJob()).battleId;
    await h.db("battles").where({ id: failedId }).update({ status: "failed", failure_kind: "infrastructure" });
    const expiredId = (await newBattleWithJob()).battleId;
    await claimBattle(h.db, expiredId, "dead-owner", 45_000);
    await h
      .db("battles")
      .where({ id: expiredId })
      .update({ lease_expires_at: new Date(NOW - 300_000) });
    const liveId = (await newBattleWithJob()).battleId;
    await claimBattle(h.db, liveId, "live-owner", 45_000);
    await h
      .db("battles")
      .where({ id: liveId })
      .update({ lease_expires_at: new Date(NOW + 600_000) });

    const { runner, removed } = fakeRunner([
      container(failedId, "x"),
      container(expiredId, "dead-owner"),
      container(liveId, "live-owner"),
    ]);
    const report = await reapOnce({ db: h.db, runner, now: () => NOW });
    expect(removed.sort()).toEqual([`c-${failedId.slice(0, 6)}-x`, `c-${expiredId.slice(0, 6)}-dead-owner`].sort());
    expect(report.removed.find((r) => r.battleId === expiredId)?.why).toMatch(/lease vencido/);
    expect(removed.some((id) => id.includes(liveId.slice(0, 6)))).toBe(false);
    expect(workerMetrics.counter("orphan_containers_removed_total")).toBe(2);
  });

  it("al arrancar (sin periodo de gracia) se retiran también los recién creados de una batalla no viva", async () => {
    const schedId = (await newBattleWithJob()).battleId; // scheduled: ningún intento vivo
    const liveId = (await newBattleWithJob()).battleId;
    await claimBattle(h.db, liveId, "owner-live", 45_000);
    const { runner, removed } = fakeRunner([container(schedId, "x", 1_000), container(liveId, "owner-live", 1_000)]);
    await reapAtStartup({ db: h.db, runner, now: () => NOW });
    expect(removed).toEqual([`c-${schedId.slice(0, 6)}-x`]);
  });
});

describe("V1-P0 · las CTF ya fallidas no se reactivan", () => {
  it("failed + job needs_review: ni el barrido, ni el claim, ni el handler, ni re-encolar las reviven", async () => {
    const { battleId, jobId } = await newBattleWithJob(3);
    await h
      .db("battles")
      .where({ id: battleId })
      .update({ status: "failed", failure_kind: "infrastructure", run_attempts: 4 });
    await h.db("jobs").where({ id: jobId }).update({ status: "needs_review", attempts: 4 });

    await sweepExpiredBattles(h.db, { lockTimeoutMs: 1000 });
    const log = new Map<string, number>();
    const w = countingWorker(log, "w-ctf");
    await w.drain(5, new Date());
    // re-encolar el mismo trabajo lógico (p. ej. POST /battles/:id/run) es idempotente: no crea otro
    expect(await enqueueJob(h.db, "run_battle", { battleId }, { dedupeKey: `run_battle:${battleId}` })).toBeNull();
    // aunque el handler se invoque directamente, una batalla `failed` no se ejecuta
    await makeRunBattleHandler({
      executor: async () => {
        log.set(battleId, (log.get(battleId) ?? 0) + 1);
        return okExecution(battleId);
      },
    })({ id: "j", kind: "run_battle", payload: { battleId }, attempts: 1 } as unknown as JobRow, {
      db: h.db,
      workerId: "x",
    });

    expect(log.get(battleId) ?? 0).toBe(0);
    expect((await battleOf(battleId)).status).toBe("failed");
    expect((await jobOf(jobId)).status).toBe("needs_review");
  });

  it("una batalla `running` huérfana cuyo trabajo ya está en needs_review se cierra, NO se reencola", async () => {
    const { battleId, jobId } = await newBattleWithJob(3);
    await dieMidBattle(battleId);
    await h.db("jobs").where({ id: jobId }).update({ status: "needs_review", locked_by: null, locked_at: null });
    const r = await sweepExpiredBattles(h.db, { lockTimeoutMs: 1000 });
    expect(r.failed).toContain(battleId);
    expect(r.requeued).not.toContain(battleId);
    expect((await battleOf(battleId)).status).toBe("failed");
    expect((await jobOf(jobId)).status).toBe("needs_review");
  });
});

describe("V1-P0 · memoria y métricas", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, "..", "..", "..");
  const compose = parse(readFileSync(join(repo, "infrastructure", "docker-compose.yml"), "utf8"));
  const worker = compose.services["tournament-worker"];

  it("--max-old-space-size del worker es coherente con el mem_limit del contenedor", () => {
    const m = /--max-old-space-size=(\d+)/.exec(String(worker.environment.NODE_OPTIONS ?? ""));
    expect(m, "NODE_OPTIONS debe fijar --max-old-space-size").not.toBeNull();
    const heapMiB = Number(m![1]);
    const limit = String(worker.deploy.resources.limits.memory);
    const limitMiB = /G$/.test(limit) ? Number(limit.slice(0, -1)) * 1024 : Number(limit.slice(0, -1));
    expect(heapMiB).toBeGreaterThan(512); // por encima del defecto de V8
    expect(heapMiB).toBeLessThanOrEqual(limitMiB * 0.7); // deja ≥30 % para no-heap: si no, lo mata el kernel
  });

  it("el registro renderiza heap/RSS/límite, contadores y sólo los gauges medidos", () => {
    const m = new WorkerMetrics();
    m.inc("job_retries_total", 2);
    m.set("jobs_needs_review", 3);
    const text = m.render();
    expect(text).toMatch(/^s9_worker_heap_used_bytes \d+$/m);
    expect(text).toMatch(/^s9_worker_heap_limit_bytes \d+$/m);
    expect(text).toMatch(/^s9_worker_rss_bytes \d+$/m);
    expect(text).toMatch(/^s9_worker_job_retries_total 2$/m);
    expect(text).toMatch(/^s9_worker_jobs_needs_review 3$/m);
    expect(text).not.toMatch(/s9_worker_battles_lease_expired \d/); // sin medir ≠ 0
  });

  it("alertas y scrape existen y cada alerta tiene caso promtool", () => {
    const alerts = parse(readFileSync(join(repo, "infrastructure/observability/prometheus/alerts.yml"), "utf8"));
    const prom = parse(readFileSync(join(repo, "infrastructure/observability/prometheus/prometheus.yml"), "utf8"));
    const tests = readFileSync(join(repo, "infrastructure/observability/prometheus/alerts-worker.test.yml"), "utf8");
    const rules = alerts.groups.flatMap((g: { rules: { alert: string; expr: string }[] }) => g.rules);
    for (const name of [
      "WorkerHeapNearLimit",
      "WorkerRssHigh",
      "WorkerJobRetries",
      "WorkerJobsNeedReview",
      "WorkerBattlesLeaseExpired",
      "WorkerMetricsDown",
    ]) {
      expect(
        rules.find((r: { alert: string }) => r.alert === name),
        name,
      ).toBeDefined();
      expect(tests).toContain(`alertname: ${name}`);
    }
    expect(prom.scrape_configs.some((j: { job_name: string }) => j.job_name === "tournament-worker")).toBe(true);
  });
});
