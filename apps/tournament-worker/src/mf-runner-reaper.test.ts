/**
 * OLA2-MF · orquestación (battle-runner) y REAPER contra PostgreSQL embebido.
 *
 *  - El teardown único se ejecuta en TODOS los finales del handler con el motivo
 *    correcto, y deja el registro de la batalla vacío (FINISHED, BOT_CRASH,
 *    FAILED, ENGINE_ERROR, EXCEPTION, MANUAL_ABORT, WORKER_ERROR, excepción antes
 *    de crear nada).
 *  - El reaper borra contenedores de batallas terminadas, inexistentes, sin
 *    intento vivo o de un intento anterior, y NUNCA los del intento en curso.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import type { JobRow } from "./queue.js";
import { makeRunBattleHandler, type BattleClosed, type BattleContext, type BattleExecution } from "./battle-runner.js";
import { BattleResourceRegistry, type BattleEndReason } from "./battle-resources.js";
import { reapOnce } from "./battle-reaper.js";
import { createBots, insertScheduledBattle, type TestBot } from "./testing/fixtures.js";
import { InfrastructureFailure, SportingFailure } from "./errors.js";
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
  bots = await createBots(h.db, 2, "mf");
}, 120_000);
afterAll(async () => {
  await h.stop();
});

const job = (battleId: string, id: string = randomUUID()) =>
  ({ id, kind: "run_battle", payload: { battleId }, attempts: 1 }) as unknown as JobRow;

const okExecution = (): BattleExecution => ({
  winner: "A",
  ticks: 10,
  score: { A: 1, B: 0 },
  finalStateHash: "h",
  disqualified: [],
  versions: { engine: "test" },
});

/** Ejecutor que REGISTRA recursos como lo haría el real y luego hace `then`. */
function executorWith(res: BattleResourceRegistry, released: string[], then: (ctx: BattleContext) => Promise<BattleExecution>) {
  return async (ctx: BattleContext) => {
    for (const kind of ["protocol_server", "container:veh_1", "container_remove:veh_1", "sandbox_host"]) {
      const phase = kind.startsWith("container_remove") ? "containers" : kind === "protocol_server" ? "stop_generation" : "terminate";
      res.register(ctx.battle.id, { kind, phase, release: () => void released.push(kind) });
    }
    return then(ctx);
  };
}

async function runCase(then: (ctx: BattleContext) => Promise<BattleExecution>, opts: { abort?: (res: BattleResourceRegistry, id: string) => void } = {}) {
  const res = new BattleResourceRegistry();
  const released: string[] = [];
  const closed: BattleClosed[] = [];
  const id = await insertScheduledBattle(h.db, bots[0], bots[1]);
  const handler = makeRunBattleHandler({
    executor: executorWith(res, released, then),
    resources: res,
    memorySampleMs: 20,
    onBattleClosed: (c) => closed.push(c),
  });
  const p = handler(job(id), { db: h.db, workerId: "mf-w" });
  if (opts.abort) setTimeout(() => opts.abort!(res, id), 100);
  const err = await p.then(
    () => null,
    (e) => e,
  );
  return { id, res, released, closed, err };
}

describe("OLA2-MF · battle-runner: teardown único en todos los finales", () => {
  const cases: [string, BattleEndReason, (ctx: BattleContext) => Promise<BattleExecution>][] = [
    ["normal", "FINISHED", async () => okExecution()],
    ["bot crash", "BOT_CRASH", async () => { throw new SportingFailure("bot_crash", bots[0].botId, "x", "container"); }],
    ["bot timeout", "TIMEOUT", async () => { throw new SportingFailure("bot_timeout", bots[0].botId, "x", "container"); }],
    ["infra", "FAILED", async () => { throw new InfrastructureFailure("container_unavailable", "proxy caído"); }],
    ["motor", "ENGINE_ERROR", async () => { throw new InfrastructureFailure("engine_start_failure", "motor"); }],
    ["bug", "EXCEPTION", async () => { throw new TypeError("bug"); }],
  ];
  for (const [name, reason, then] of cases) {
    it(`${name} → cleanupBattleResources(${reason}) y no queda nada registrado`, async () => {
      const r = await runCase(then);
      expect(r.closed).toHaveLength(1);
      expect(r.closed[0].reason).toBe(reason);
      expect(r.closed[0].cleanup.clean).toBe(true);
      // Orden de fases: stop_generation → terminate → containers.
      expect(r.released).toEqual(["protocol_server", "container:veh_1", "sandbox_host", "container_remove:veh_1"]);
      expect(r.res.totalPending({ includeDraining: true })).toBe(0);
      const m = r.closed[0].memory;
      expect(m.RAM_AFTER_FINISH).not.toBeNull();
      expect(m.RAM_AFTER_CLEANUP).not.toBeNull();
      expect(m.RAM_PEAK.rssMb).toBeGreaterThanOrEqual(m.RAM_IDLE_BEFORE.rssMb);
    });
  }

  it("MANUAL_ABORT a mitad → teardown con MANUAL_ABORT y la batalla vuelve a scheduled", async () => {
    const r = await runCase(
      (ctx) =>
        new Promise<BattleExecution>((_ok, ko) => ctx.signal!.addEventListener("abort", () => ko(ctx.signal!.reason))),
      { abort: (res, id) => res.abortBattle(id, "MANUAL_ABORT", "operador") },
    );
    expect(r.err).toBeInstanceOf(InfrastructureFailure);
    expect(r.closed[0].reason).toBe("MANUAL_ABORT");
    expect(r.res.totalPending()).toBe(0);
    const row = await h.db("battles").where({ id: r.id }).first();
    expect(row.status).toBe("scheduled");
  });

  it("WORKER_ERROR (parada del worker: abortAll) → teardown con WORKER_ERROR", async () => {
    const r = await runCase(
      (ctx) =>
        new Promise<BattleExecution>((_ok, ko) => ctx.signal!.addEventListener("abort", () => ko(ctx.signal!.reason))),
      { abort: (res) => res.abortAll("WORKER_ERROR", "SIGTERM") },
    );
    expect(r.closed[0].reason).toBe("WORKER_ERROR");
    expect(r.res.totalPending()).toBe(0);
  });

  it("excepción ANTES de crear nada (el ejecutor revienta al entrar) → teardown igual, sin timers vivos", async () => {
    const res = new BattleResourceRegistry();
    const closed: BattleClosed[] = [];
    const id = await insertScheduledBattle(h.db, bots[0], bots[1]);
    const handler = makeRunBattleHandler({
      executor: async () => {
        throw new Error("antes de nada");
      },
      resources: res,
      onBattleClosed: (c) => closed.push(c),
    });
    await handler(job(id), { db: h.db, workerId: "mf-w" }).catch(() => undefined);
    expect(closed[0].reason).toBe("EXCEPTION");
    // lease_renewer y memory_sampler (los timers de la orquestación) también se liberaron.
    expect(res.totalPending({ includeDraining: true })).toBe(0);
    expect(closed[0].cleanup.steps.map((s) => s.kind).sort()).toEqual(["timer:lease_renewer", "timer:memory_sampler"]);
  });
});

/** Proxy falso para el reaper: lista y borra. */
function fakeRunner(cs: ManagedContainer[]) {
  const removed: string[] = [];
  return {
    removed,
    runner: {
      async list(labels: Record<string, string>) {
        return cs.filter((c) => !removed.includes(c.id) && Object.entries(labels).every(([k, v]) => c.labels[k] === v));
      },
      async removeById(id: string) {
        removed.push(id);
      },
    },
  };
}

describe("OLA2-MF · REAPER (segunda barrera)", () => {
  it("borra lo de batallas terminadas, inexistentes, sin intento vivo o de un intento anterior; respeta el intento en curso", async () => {
    const finished = await insertScheduledBattle(h.db, bots[0], bots[1]);
    await h.db("battles").where({ id: finished }).update({ status: "finished" });
    const failed = await insertScheduledBattle(h.db, bots[0], bots[1]);
    await h.db("battles").where({ id: failed }).update({ status: "failed" });
    const scheduled = await insertScheduledBattle(h.db, bots[0], bots[1]);
    const running = await insertScheduledBattle(h.db, bots[0], bots[1]);
    await h.db("battles").where({ id: running }).update({ status: "running", claimed_by: "w2:job:2" });
    const now = 10_000_000;
    const c = (id: string, battleId: string, owner: string | null, ageMs: number): ManagedContainer => ({
      id,
      state: "running",
      createdAtMs: now - ageMs,
      labels: {
        [LABEL_ROLE]: ROLE_BATTLE_BOT,
        [LABEL_BATTLE_ID]: battleId,
        ...(owner ? { [LABEL_BATTLE_OWNER]: owner } : {}),
      },
    });
    const ghost = "00000000-0000-4000-8000-00000000dead";
    const { runner, removed } = fakeRunner([
      c("fin", finished, "w1:job:1", 1),
      c("fail", failed, "w1:job:1", 1),
      c("ghost", ghost, "w1:job:1", 1),
      c("sched-old", scheduled, "w1:job:1", 600_000),
      c("sched-young", scheduled, "w1:job:1", 1_000),
      c("run-current", running, "w2:job:2", 600_000),
      c("run-stale", running, "w1:job:1", 600_000),
      c("run-stale-young", running, "w1:job:1", 1_000),
      { id: "build", state: "running", createdAtMs: 0, labels: { "arena.role": "build" } },
    ]);
    const res = new BattleResourceRegistry();
    const r = await reapOnce({ db: h.db, runner, resources: res, now: () => now, graceMs: 120_000 });
    expect(removed.sort()).toEqual(["fail", "fin", "ghost", "run-stale", "sched-old"]);
    expect(r.errors).toEqual([]);
    // Segunda pasada: nada más que hacer (idempotente).
    const again = await reapOnce({ db: h.db, runner, resources: res, now: () => now, graceMs: 120_000 });
    expect(again.removed).toEqual([]);
  });

  it("no toca contenedores de una batalla con ejecución VIVA en este proceso, aunque la BD diga terminada", async () => {
    const id = await insertScheduledBattle(h.db, bots[0], bots[1]);
    await h.db("battles").where({ id }).update({ status: "finished" });
    const res = new BattleResourceRegistry();
    res.registerAborter(id, new AbortController());
    const { runner, removed } = fakeRunner([
      { id: "x", state: "running", createdAtMs: 0, labels: { [LABEL_ROLE]: ROLE_BATTLE_BOT, [LABEL_BATTLE_ID]: id } },
    ]);
    await reapOnce({ db: h.db, runner, resources: res });
    expect(removed).toEqual([]);
  });

  it("en proceso: repite el teardown de recursos que quedaron de un teardown fallido", async () => {
    const res = new BattleResourceRegistry();
    let tries = 0;
    res.register("b-stale", {
      kind: "container:veh_1",
      phase: "terminate",
      release: () => {
        if (++tries === 1) throw new Error("proxy caído");
      },
    });
    await res.cleanupBattleResources("b-stale", "FAILED");
    expect(res.pending("b-stale")).toHaveLength(1);
    const r = await reapOnce({ db: h.db, resources: res });
    expect(r.inProcessRetried).toEqual(["b-stale"]);
    expect(res.pending("b-stale")).toEqual([]);
  });
});
