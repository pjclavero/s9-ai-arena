/**
 * OLA2-MF · teardown único de batalla (battle-resources.ts), sin BD ni Docker.
 * Cada `it` tiene un mutante en tests/mutants/mf-lifecycle (ver informe MF).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BATTLE_END_REASONS,
  BattleAbort,
  BattleResourceRegistry,
  DEFAULT_RELEASE_DEADLINE_MS,
  DEFAULT_VERIFY_DEADLINE_MS,
  PHASES,
  StopUnresponsiveError,
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

describe("G2 · MF_STOP_BOUNDED_TEARDOWN · toda espera de la parada está acotada", () => {
  it("un KILL (stop t=0) que tampoco contesta RECHAZA en su plazo (antes colgaba el teardown sin límite)", async () => {
    const calls: (number | undefined)[] = [];
    const t0 = performance.now();
    const p = terminateContainer(
      {
        stop(o) {
          calls.push(o?.timeoutSeconds);
          return new Promise<void>(() => undefined);
        },
      },
      { termGraceS: 1, stopDeadlineMs: 50, killDeadlineMs: 80 },
    );
    await expect(p).rejects.toBeInstanceOf(StopUnresponsiveError);
    expect(performance.now() - t0, "fuera de la cota stop+kill").toBeLessThan(1_000);
    expect(calls).toEqual([1, 0]);
  });

  it("un stop(TERM) que LANZA con el contenedor vivo escala a KILL; si el KILL lanza, se propaga (no se oculta)", async () => {
    const calls: (number | undefined)[] = [];
    const p = terminateContainer(
      {
        async stop(o) {
          calls.push(o?.timeoutSeconds);
          throw new Error("proxy caído");
        },
        async state() {
          return { running: true, gone: false };
        },
      },
      { termGraceS: 1 },
    );
    await expect(p).rejects.toThrow(/proxy caído/);
    expect(calls).toEqual([1, 0]);
  });

  it("un state() que nunca contesta no cuelga la parada (estado desconocido ⇒ no se inventa KILL)", async () => {
    const t0 = performance.now();
    const out = await terminateContainer(
      { stop: async () => undefined, state: () => new Promise(() => undefined) },
      { termGraceS: 1, stateDeadlineMs: 60 },
    );
    expect(out).toBe("terminated");
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  it("un release que nunca resuelve queda `failed` en su plazo, el resto del teardown sigue y el reintento lo libera", async () => {
    const reg = new BattleResourceRegistry({ releaseDeadlineMs: 80 });
    let hang = true;
    const seen: string[] = [];
    reg.register("A", {
      kind: "colgado",
      phase: "terminate",
      release: () => (hang ? new Promise<void>(() => undefined) : undefined),
    });
    reg.register("A", { kind: "siguiente", phase: "containers", release: () => void seen.push("siguiente") });
    const t0 = performance.now();
    const r = await reg.cleanupBattleResources("A", "FAILED");
    expect(performance.now() - t0, "el teardown esperó a un release colgado").toBeLessThan(1_000);
    expect(r.clean).toBe(false);
    expect(r.steps.find((x) => x.kind === "colgado")).toMatchObject({ outcome: "failed" });
    expect(r.steps.find((x) => x.kind === "colgado")!.error).toMatch(/sin respuesta en 80 ms/);
    expect(seen).toEqual(["siguiente"]);
    expect(reg.pending("A").map((x) => `${x.kind}:${x.state}`)).toEqual(["colgado:failed"]);
    expect(reg.stats.deadlineExpired).toBe(1);
    hang = false;
    expect((await reg.cleanupBattleResources("A", "FAILED")).clean).toBe(true);
    expect(reg.pending("A")).toEqual([]);
  });

  it("`deadlineMs` del recurso manda sobre el del registro", async () => {
    const reg = new BattleResourceRegistry({ releaseDeadlineMs: 10_000 });
    reg.register("A", {
      kind: "x",
      phase: "terminate",
      deadlineMs: 50,
      release: () => new Promise<void>(() => undefined),
    });
    const t0 = performance.now();
    const r = await reg.cleanupBattleResources("A", "FAILED");
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(r.steps[0]).toMatchObject({ outcome: "failed" });
  });
});

/** Resuelve «done» o «hung» si `p` no termina en `ms` (nunca cuelga el test). */
async function settles<T>(p: Promise<T>, ms: number): Promise<"done" | "hung"> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<"hung">((r) => (t = setTimeout(() => r("hung"), ms)));
  try {
    return await Promise.race([p.then(() => "done" as const, () => "done" as const), hung]);
  } finally {
    clearTimeout(t);
  }
}

describe("G2 · ronda 2 (P2-1) · la verificación externa del teardown completo está acotada", () => {
  it("un verificador que NO contesta (proxy colgado): el teardown acaba en su plazo, NO es limpio y queda pendiente de reverificar", async () => {
    const reg = new BattleResourceRegistry({ releaseDeadlineMs: 100, verifyDeadlineMs: 150 });
    reg.setVerifier(() => new Promise<string[]>(() => undefined));
    reg.register("A", { kind: "x", phase: "terminate", release: () => undefined });
    const t0 = performance.now();
    const p = reg.cleanupBattleResources("A", "FAILED");
    expect(await settles(p, 3_000), "el teardown completo quedó esperando al verificador").toBe("done");
    const r = await p;
    expect(performance.now() - t0).toBeLessThan(1_500);
    expect(r.clean, "una verificación sin respuesta se dio por limpia").toBe(false);
    expect(r.externalLeftovers).toEqual(["verificación externa sin respuesta en 150 ms"]);
    expect(reg.stats.verifyExpired).toBe(1);
    expect(reg.isUnverified("A")).toBe(true);
    expect(reg.retryIds(), "el reaper no vería la batalla sin verificar").toEqual(["A"]);
  });

  it("el siguiente teardown de la MISMA batalla no queda bloqueado detrás (serializado por battleId) y, si el verificador ya contesta, limpia la marca", async () => {
    const reg = new BattleResourceRegistry({ verifyDeadlineMs: 150 });
    let hang = true;
    reg.setVerifier(() => (hang ? new Promise<string[]>(() => undefined) : Promise.resolve([])));
    const first = reg.cleanupBattleResources("A", "FAILED");
    hang = false;
    const second = reg.cleanupBattleResources("A", "FAILED");
    expect(await settles(second, 3_000), "el segundo teardown quedó detrás del primero").toBe("done");
    expect((await first).clean).toBe(false);
    expect((await second).clean).toBe(true);
    expect(reg.isUnverified("A")).toBe(false);
    expect(reg.retryIds()).toEqual([]);
  });

  it("un verificador LENTO dentro del plazo se espera y su respuesta cuenta (restos ⇒ no limpio, pero verificado)", async () => {
    const reg = new BattleResourceRegistry({ verifyDeadlineMs: 2_000 });
    reg.setVerifier(async () => {
      await sleep(300);
      return ["abc123"];
    });
    const t0 = performance.now();
    const r = await reg.cleanupBattleResources("A", "FAILED");
    expect(performance.now() - t0, "no se esperó al verificador lento").toBeGreaterThanOrEqual(250);
    expect(r.externalLeftovers).toEqual(["abc123"]);
    expect(r.clean).toBe(false);
    expect(reg.isUnverified("A"), "una respuesta a tiempo SÍ es una verificación").toBe(false);
    expect(reg.stats.verifyExpired).toBe(0);
  });

  it("un verificador que LANZA (síncrono o asíncrono): no limpio, motivo nombrado y pendiente de reverificar", async () => {
    for (const verifier of [
      (): Promise<string[]> => {
        throw new Error("proxy caído (sync)");
      },
      () => Promise.reject(new Error("proxy caído (async)")),
    ]) {
      const reg = new BattleResourceRegistry({ verifyDeadlineMs: 500 });
      reg.setVerifier(verifier);
      const r = await reg.cleanupBattleResources("A", "FAILED");
      expect(r.clean).toBe(false);
      expect(r.externalLeftovers.join(" ")).toMatch(/verificación externa no disponible: proxy caído/);
      expect(reg.isUnverified("A")).toBe(true);
      expect(reg.stats.verifyExpired).toBe(0);
    }
  });

  it("un teardown con scope (capa interna) NO verifica ni marca nada", async () => {
    const reg = new BattleResourceRegistry({ verifyDeadlineMs: 50 });
    let calls = 0;
    reg.setVerifier(() => {
      calls++;
      return new Promise<string[]>(() => undefined);
    });
    const r = await reg.cleanupBattleResources("A", "FAILED", { scope: "agents" });
    expect(r.clean).toBe(true);
    expect(calls).toBe(0);
    expect(reg.isUnverified("A")).toBe(false);
  });
});

describe("G2 · ronda 2 (P3-5) · plazos de PRODUCCIÓN del registro (sin inyectar)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("DEFAULT_RELEASE_DEADLINE_MS = 60 s: un release colgado de un registro por defecto vence EXACTAMENTE a los 60 s", async () => {
    vi.useFakeTimers();
    const reg = new BattleResourceRegistry();
    reg.register("A", { kind: "colgado", phase: "terminate", release: () => new Promise<void>(() => undefined) });
    expect(reg.pending("A")[0]!.deadlineMs).toBe(60_000);
    let done = false;
    const p = reg.cleanupBattleResources("A", "FAILED").then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(done, "venció antes de 60 s").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done, "no venció a los 60 s").toBe(true);
    const r = await p;
    expect(r.steps[0]).toMatchObject({ kind: "colgado", outcome: "failed" });
    expect(r.steps[0]!.error).toMatch(/sin respuesta en 60000 ms/);
    expect(DEFAULT_RELEASE_DEADLINE_MS).toBe(60_000);
  });

  it("DEFAULT_VERIFY_DEADLINE_MS = 10 s: un verificador colgado de un registro por defecto vence EXACTAMENTE a los 10 s", async () => {
    vi.useFakeTimers();
    const reg = new BattleResourceRegistry();
    reg.setVerifier(() => new Promise<string[]>(() => undefined));
    let done = false;
    const p = reg.cleanupBattleResources("A", "FAILED").then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(done, "venció antes de 10 s").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done, "no venció a los 10 s").toBe(true);
    expect((await p).externalLeftovers).toEqual(["verificación externa sin respuesta en 10000 ms"]);
    expect(DEFAULT_VERIFY_DEADLINE_MS).toBe(10_000);
  });
});

describe("G2 · MF_LAUNCH_TIMEOUT_CLEANUP · recurso desprendido", () => {
  it("un release que devuelve `detached` suelta el recurso (no `failed`), lo informa y el teardown NO es limpio", async () => {
    const reg = new BattleResourceRegistry();
    reg.register("A", { kind: "en_vuelo", phase: "cancel_jobs", scope: "agents", release: () => "detached" as const });
    const scoped = await reg.cleanupBattleResources("A", "FAILED", { scope: "agents" });
    expect(scoped.steps).toEqual([expect.objectContaining({ kind: "en_vuelo", outcome: "detached" })]);
    expect(scoped.detached).toBe(1);
    expect(scoped.clean).toBe(false);
    expect(reg.pending("A")).toEqual([]);
    expect(reg.battleIds(), "el reaper no debe volver a esperar a lo desprendido").toEqual([]);
    // El teardown COMPLETO de la orquestación lo sigue informando (una vez).
    const full = await reg.cleanupBattleResources("A", "FAILED");
    expect(full.detached).toBe(1);
    expect(full.clean).toBe(false);
    const again = await reg.cleanupBattleResources("A", "FAILED");
    expect(again.detached).toBe(0);
    expect(again.clean).toBe(true);
    expect(reg.stats.detached).toBe(1);
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
