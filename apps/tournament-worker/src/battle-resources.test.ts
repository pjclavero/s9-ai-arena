/**
 * OLA2-MF · teardown único de batalla (battle-resources.ts), sin BD ni Docker.
 * Cada `it` tiene un mutante en tests/mutants/mf-lifecycle (ver informe MF).
 */
import { describe, expect, it } from "vitest";
import {
  BATTLE_END_REASONS,
  BattleAbort,
  BattleResourceRegistry,
  PHASES,
  classifyEnd,
  terminateContainer,
} from "./battle-resources.js";
import { InfrastructureFailure, SportingFailure } from "./errors.js";
import { LostBattleClaim } from "./battle-runner.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("cleanupBattleResources · orden, idempotencia y aislamiento", () => {
  it("libera en el ORDEN de las fases, sea cual sea el orden de registro", async () => {
    const reg = new BattleResourceRegistry();
    const seen: string[] = [];
    for (const phase of [...PHASES].reverse())
      reg.register("A", { kind: phase, phase, release: () => void seen.push(phase) });
    const r = await reg.cleanupBattleResources("A", "FINISHED");
    expect(seen).toEqual([...PHASES]);
    expect(r.clean).toBe(true);
    expect(reg.totalPending()).toBe(0);
  });

  it("dos llamadas (secuenciales o concurrentes) liberan cada recurso UNA vez y no fallan", async () => {
    const reg = new BattleResourceRegistry();
    let n = 0;
    reg.register("A", {
      kind: "c",
      phase: "containers",
      release: async () => {
        await sleep(20);
        n++;
      },
    });
    const [a, b] = await Promise.all([
      reg.cleanupBattleResources("A", "FAILED"),
      reg.cleanupBattleResources("A", "FAILED"),
    ]);
    const c = await reg.cleanupBattleResources("A", "FAILED");
    expect(n).toBe(1);
    expect([a.clean, b.clean, c.clean]).toEqual([true, true, true]);
    expect(c.steps).toEqual([]);
  });

  it("el teardown de una batalla NO toca los recursos de otra", async () => {
    const reg = new BattleResourceRegistry();
    const released: string[] = [];
    for (const id of ["A", "B"])
      for (const phase of PHASES)
        reg.register(id, { kind: `${id}:${phase}`, phase, release: () => void released.push(id) });
    await reg.cleanupBattleResources("A", "FINISHED");
    expect(new Set(released)).toEqual(new Set(["A"]));
    expect(reg.pending("B")).toHaveLength(PHASES.length);
    await reg.cleanupBattleResources("A", "FINISHED");
    expect(reg.pending("B")).toHaveLength(PHASES.length);
  });

  it("una liberación que FALLA no impide las demás, queda pendiente y se reintenta en la siguiente llamada", async () => {
    const reg = new BattleResourceRegistry();
    const done: string[] = [];
    let fail = true;
    reg.register("A", {
      kind: "roto",
      phase: "terminate",
      release: () => {
        if (fail) throw new Error("proxy caído");
        done.push("roto");
      },
    });
    reg.register("A", { kind: "host", phase: "streaming", release: () => void done.push("host") });
    reg.register("A", { kind: "motor", phase: "engine", release: () => void done.push("motor") });
    const r1 = await reg.cleanupBattleResources("A", "ENGINE_ERROR");
    expect(done).toEqual(["host", "motor"]);
    expect(r1.clean).toBe(false);
    expect(r1.remaining).toEqual([{ kind: "roto", phase: "terminate", state: "failed" }]);
    fail = false;
    const r2 = await reg.cleanupBattleResources("A", "ENGINE_ERROR");
    expect(done).toEqual(["host", "motor", "roto"]);
    expect(r2.clean).toBe(true);
  });

  it("scope: la capa interna limpia SÓLO lo suyo; la llamada sin scope, todo", async () => {
    const reg = new BattleResourceRegistry();
    const out: string[] = [];
    reg.register("A", {
      kind: "lease",
      phase: "stop_generation",
      scope: "runner",
      release: () => void out.push("lease"),
    });
    reg.register("A", { kind: "srv", phase: "stop_generation", scope: "agents", release: () => void out.push("srv") });
    await reg.cleanupBattleResources("A", "FAILED", { scope: "agents" });
    expect(out).toEqual(["srv"]);
    await reg.cleanupBattleResources("A", "FAILED");
    expect(out).toEqual(["srv", "lease"]);
  });

  it("drenaje: en FINISHED el feed se retira tras su plazo; en cualquier otro final, ya", async () => {
    const reg = new BattleResourceRegistry();
    let detached = 0;
    reg.register("A", { kind: "feed", phase: "streaming", drainMs: 60, release: () => void detached++ });
    const r = await reg.cleanupBattleResources("A", "FINISHED");
    expect(r.draining).toBe(1);
    expect(detached).toBe(0);
    await sleep(120);
    expect(detached).toBe(1);
    expect(reg.totalPending({ includeDraining: true })).toBe(0);

    reg.register("B", { kind: "feed", phase: "streaming", drainMs: 10_000, release: () => void detached++ });
    await reg.cleanupBattleResources("B", "BOT_CRASH");
    expect(detached).toBe(2);
  });

  it("flushDraining libera YA un feed drenando (reintento de la misma batalla)", async () => {
    const reg = new BattleResourceRegistry();
    let detached = 0;
    reg.register("A", { kind: "feed", phase: "streaming", drainMs: 10_000, release: () => void detached++ });
    await reg.cleanupBattleResources("A", "FINISHED");
    await reg.flushDraining("A");
    expect(detached).toBe(1);
    expect(reg.totalPending({ includeDraining: true })).toBe(0);
  });

  it("verificación externa: un contenedor que aún lista el proxy deja la batalla NO limpia", async () => {
    const reg = new BattleResourceRegistry();
    reg.setVerifier(async (id) => (id === "A" ? ["abc123"] : []));
    expect((await reg.cleanupBattleResources("A", "FINISHED")).clean).toBe(false);
    expect((await reg.cleanupBattleResources("B", "FINISHED")).clean).toBe(true);
  });

  it("cleanup nunca lanza aunque release lance de forma síncrona o asíncrona", async () => {
    const reg = new BattleResourceRegistry();
    reg.register("A", {
      kind: "s",
      phase: "terminate",
      release: () => {
        throw new Error("x");
      },
    });
    reg.register("A", {
      kind: "a",
      phase: "terminate",
      release: async () => {
        throw new Error("y");
      },
    });
    await expect(reg.cleanupBattleResources("A", "EXCEPTION")).resolves.toMatchObject({ clean: false });
  });
});

describe("abortos: MANUAL_ABORT / WORKER_ERROR", () => {
  it("abortBattle sólo aborta la batalla pedida; abortAll, todas", () => {
    const reg = new BattleResourceRegistry();
    const a = new AbortController();
    const b = new AbortController();
    reg.registerAborter("A", a);
    reg.registerAborter("B", b);
    expect(reg.abortBattle("A", "MANUAL_ABORT")).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect((a.signal.reason as BattleAbort).reason).toBe("MANUAL_ABORT");
    expect(reg.abortAll("WORKER_ERROR").sort()).toEqual(["A", "B"]);
    expect(b.signal.aborted).toBe(true);
    expect(reg.abortBattle("Z", "MANUAL_ABORT")).toBe(false);
  });
});

describe("terminateContainer · TERM → timeout corto → KILL sólo si no responde", () => {
  it("un contenedor que atiende TERM NO recibe KILL", async () => {
    const calls: (number | undefined)[] = [];
    let running = true;
    const out = await terminateContainer(
      {
        async stop(o) {
          calls.push(o?.timeoutSeconds);
          running = false;
        },
        async state() {
          return { running, gone: false };
        },
      },
      { termGraceS: 1 },
    );
    expect(out).toBe("terminated");
    expect(calls).toEqual([1]);
  });

  it("un runner que IGNORA TERM (stop no lo para) recibe KILL (t=0)", async () => {
    const calls: (number | undefined)[] = [];
    let running = true;
    const out = await terminateContainer(
      {
        async stop(o) {
          calls.push(o?.timeoutSeconds);
          if (o?.timeoutSeconds === 0) running = false;
        },
        async state() {
          return { running, gone: false };
        },
      },
      { termGraceS: 1 },
    );
    expect(out).toBe("killed");
    expect(calls).toEqual([1, 0]);
    expect(running).toBe(false);
  });

  it("un stop que no contesta en el plazo también escala a KILL", async () => {
    const calls: (number | undefined)[] = [];
    const out = await terminateContainer(
      {
        stop(o) {
          calls.push(o?.timeoutSeconds);
          return o?.timeoutSeconds === 0 ? Promise.resolve() : new Promise<void>(() => undefined);
        },
      },
      { termGraceS: 1, stopDeadlineMs: 50 },
    );
    expect(out).toBe("killed");
    expect(calls).toEqual([1, 0]);
  });
});

describe("classifyEnd · los nueve finales", () => {
  it("cada final se clasifica como se espera", () => {
    expect(classifyEnd({ ok: true })).toBe("FINISHED");
    expect(classifyEnd({ ok: false, error: new SportingFailure("bot_crash", "b", "x") })).toBe("BOT_CRASH");
    expect(classifyEnd({ ok: false, error: new SportingFailure("bot_timeout", "b", "x") })).toBe("TIMEOUT");
    expect(
      classifyEnd({
        ok: false,
        error: new InfrastructureFailure("engine_start_failure", "timeout global de la batalla tras 9 ms"),
      }),
    ).toBe("TIMEOUT");
    expect(classifyEnd({ ok: false, error: new InfrastructureFailure("engine_start_failure", "motor") })).toBe(
      "ENGINE_ERROR",
    );
    expect(classifyEnd({ ok: false, error: new InfrastructureFailure("container_unavailable", "x") })).toBe("FAILED");
    expect(classifyEnd({ ok: false, error: new InfrastructureFailure("battle_busy", "x") })).toBe("CANCELLED");
    expect(classifyEnd({ ok: false, error: new LostBattleClaim("b", "o") })).toBe("CANCELLED");
    expect(classifyEnd({ ok: false, abortReason: new BattleAbort("MANUAL_ABORT") })).toBe("MANUAL_ABORT");
    expect(classifyEnd({ ok: false, abortReason: new BattleAbort("WORKER_ERROR") })).toBe("WORKER_ERROR");
    expect(classifyEnd({ ok: false, error: new TypeError("bug") })).toBe("EXCEPTION");
    expect(BATTLE_END_REASONS).toHaveLength(9);
  });
});
