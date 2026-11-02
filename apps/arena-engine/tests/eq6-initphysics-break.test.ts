/**
 * EQ6 · revisión independiente de #208 · intentos de ROTURA de la promesa compartida de
 * `initPhysics()`. Complementa los tests del autor con caminos que ellos no cubren:
 *
 *  1. fallo REAL de checksum (D4) —no de `RAPIER.init`—, con llamadas concurrentes:
 *     todas reciben el error D4 y `RAPIER.init` no llega a ejecutarse;
 *  2. dos fallos seguidos y después éxito: cada tanda comparte UNA inicialización;
 *  3. reentrada en el manejador del rechazo: quien reintenta DENTRO de su `catch` no
 *     recibe la promesa rechazada antigua, sino una inicialización nueva;
 *  4. llamadas que llegan MIENTRAS el reintento está en vuelo lo comparten;
 *  5. tras todo eso, N `Battle.create` concurrentes producen la misma simulación que
 *     ejecutadas en solitario (WASM real, sin mocks en la física).
 *
 * `node:fs.readFileSync` y `RAPIER.init` se envuelven sólo para inyectar fallos y contar;
 * el resto del módulo es el real.
 */
import { describe, expect, it, vi } from "vitest";

const ctl = vi.hoisted(() => ({ fsCorrupt: 0, initFail: 0, inits: 0, wasmReads: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const real: any = await importOriginal();
  const readFileSync = (p: any, ...rest: any[]) => {
    if (String(p).endsWith(".wasm")) {
      ctl.wasmReads++;
      if (ctl.fsCorrupt > 0) {
        ctl.fsCorrupt--;
        return Buffer.from("WASM corrupto inyectado por EQ6");
      }
    }
    return real.readFileSync(p, ...rest);
  };
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

vi.mock("@dimforge/rapier2d-compat", async (importOriginal) => {
  const real: any = await importOriginal();
  const RAPIER = real.default;
  const wrapped = { ...RAPIER };
  wrapped.init = async (...args: unknown[]) => {
    ctl.inits++;
    await new Promise((r) => setTimeout(r, 10));
    if (ctl.initFail > 0) {
      ctl.initFail--;
      throw new Error("EQ6: fallo inyectado en RAPIER.init");
    }
    return RAPIER.init(...args);
  };
  return { ...real, default: wrapped };
});

const { initPhysics } = await import("../src/sim/physics.js");
const { Battle } = await import("../src/sim/battle.js");
const { loadRuleset } = await import("../../../packages/game-rules/index.js");
const { emptyArena, gunnerLoadout, scoutLoadout } = await import("../src/fixtures.js");
const { HunterBot, CircleBot } = await import("../src/stubs.js");

function cfg(i: number) {
  return {
    battleId: `eq6_${i}`,
    seed: `eq6-seed-${i % 3}`,
    ruleset: loadRuleset("tdm_mvp@1", { timeLimitTicks: 400, scoreToWin: 99 }),
    map: emptyArena(80, 60),
    participants: [
      { id: "veh_1", botId: "a", team: "red", spec: gunnerLoadout() },
      { id: "veh_2", botId: "b", team: "blue", spec: scoutLoadout() },
    ],
  };
}
function attach(b: any) {
  b.attachBot("veh_1", new HunterBot("a"));
  b.attachBot("veh_2", new CircleBot("b"));
}
function sig(b: any) {
  return { h: b.stateHash(), t: b.tick, sh: b.stateHashes.map((x: any) => `${x.tick}:${x.hash}`).join(",") };
}

describe("EQ6 · #208 · rotura de la promesa compartida de initPhysics", () => {
  it("checksum D4 real, fallos repetidos, reentrada en catch, reintento en vuelo compartido y batallas idénticas", async () => {
    // 1 · checksum corrupto: 3 llamadas concurrentes, una sola lectura del WASM, ningún init.
    ctl.fsCorrupt = 1;
    const r1 = await Promise.allSettled([initPhysics(), initPhysics(), initPhysics()]);
    expect(r1.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    for (const r of r1) expect(String((r as PromiseRejectedResult).reason)).toContain("[D4]");
    expect(ctl.wasmReads).toBe(1);
    expect(ctl.inits).toBe(0);

    // 2 · fallo en RAPIER.init (el checksum ya es bueno): tanda compartida.
    ctl.initFail = 1;
    const r2 = await Promise.allSettled([initPhysics(), initPhysics()]);
    expect(r2.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(ctl.wasmReads).toBe(2);
    expect(ctl.inits).toBe(1);

    // 3 · reentrada: el que reintenta dentro de su catch debe arrancar una inicialización
    //     NUEVA (no recibir la promesa rechazada); esa nueva vuelve a fallar a propósito.
    ctl.initFail = 2;
    let reentry: Promise<void> | null = null;
    await initPhysics().catch(() => {
      reentry = initPhysics();
    });
    expect(reentry).not.toBeNull();
    const reentryResult = await Promise.allSettled([reentry!]);
    expect(reentryResult[0]!.status).toBe("rejected");
    expect(ctl.inits).toBe(3); // 1 (tanda 2) + 1 (fallo) + 1 (reentrada, fallo)

    // 4 · reintento con éxito; llamadas que llegan en vuelo (tras un macrotask) lo comparten.
    const inflight = initPhysics();
    await new Promise((r) => setTimeout(r, 2)); // RAPIER.init tarda 10 ms: sigue en vuelo
    const late = [initPhysics(), initPhysics(), initPhysics()];
    await Promise.all([inflight, ...late]);
    expect(ctl.inits).toBe(4);
    await initPhysics();
    expect(ctl.inits).toBe(4); // ya inicializado
    expect(ctl.wasmReads).toBe(5); // una lectura por inicialización real, ninguna después

    // 5 · física real tras la secuencia de fallos: concurrentes == en solitario.
    const N = 9;
    const conc = await Promise.all(Array.from({ length: N }, (_, i) => Battle.create(cfg(i) as any)));
    conc.forEach(attach);
    for (let t = 0; t < 400; t++) for (const b of conc) if (!b.isFinished()) b.step();
    const cs = conc.map(sig);
    conc.forEach((b) => b.free());
    for (let i = 0; i < N; i++) {
      const b = await Battle.create(cfg(i) as any);
      attach(b);
      for (let t = 0; t < 400 && !b.isFinished(); t++) b.step();
      expect(sig(b), `batalla ${i}`).toEqual(cs[i]);
      b.free();
    }
    expect(ctl.inits).toBe(4);
  }, 120_000);
});
