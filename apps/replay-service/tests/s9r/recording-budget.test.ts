/**
 * V1 REPLAYS PR-5 · presupuesto de almacenamiento del grabador (tope por batalla, reserva y cuota),
 * comprobado ANTES de cada fragmento, con disco real y sin base de datos.
 *
 * A1 CLASE A: el tope de la propia batalla (receta + vista juntas) cierra el replay TRUNCADO, verificable
 *    con `allowTruncated` y nunca «válido» sin él; el sink deja de aceptar registros (RAM acotada).
 * A2 CLASE A al CERRAR: el último fragmento supera el tope → truncado, no error de entorno.
 * A3 CLASE A con `append`s aún encolados al pedir el cierre (carrera): truncado, no `limit_hit` del cierre.
 * B1 CLASE B: reserva de espacio libre ⇒ aborta, borra los parciales y NO sella nada truncado.
 * B2 CLASE B: cuota del volumen (cuenta lo ya escrito por el propio intento) ⇒ igual.
 * B3 EN CALIENTE: cuota y reserva se releen en CADA fragmento; el tope por batalla queda fijado al empezar.
 * B6 (grabador) el volcado previo de finish() es de CIERRE: con el disco justo en la reserva, una batalla sana cierra.
 * B4 el CIERRE no aplica reserva ni cuota (sí el tope por batalla).
 * B5 compuerta previa (`preflightCheck`): hueco para una batalla máxima + reserva, y que quepa en la cuota.
 * W1 el escritor invoca `admit` sólo para fragmentos de DATOS (no resultado, índice ni pie), con `closing`.
 * W2 clase B envenena el escritor; clase A no.
 * Cada caso tiene su mutante en apps/replay-service/scripts/replay-pr5-mutants.mjs.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ReplayRecorder } from "../../src/s9r/recorder.js";
import {
  RecordingBudget,
  RecordingBudgetError,
  preflightCheck,
  type ReplayLimits,
  type StorageProbe,
} from "../../src/s9r/recording-budget.js";
import { ReplayLimitExceededError, StorageError } from "../../src/s9r/errors.js";
import { S9rWriter } from "../../src/s9r/writer.js";
import { verifyFile } from "../../src/s9r/verify.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pr5-budget-"));
  dirs.push(d);
  mkdirSync(join(d, ".partial"), { recursive: true });
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const BID = "b0f1e2d3-0000-4000-8000-0000000000a5";
const OWNER = "worker-pr5:job:1";
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const OK_LIMITS: ReplayLimits = { quotaMaxBytes: 20 * GiB, minFreeBytes: 5 * GiB, maxBytesPerBattle: 64 * MiB };
const PLENTY: StorageProbe = { freeBytes: async () => 100 * GiB, usedBytes: async () => 0 };

function budgetOf(limits: () => ReplayLimits, probe: StorageProbe | undefined, dir: string) {
  return new RecordingBudget({ limits, ...(probe ? { probe } : {}), ownPartials: [join(dir, ".partial", "x")] });
}

async function make(dir: string, budget: RecordingBudget) {
  return ReplayRecorder.create({
    dir,
    battleId: BID,
    attempt: 1,
    owner: OWNER,
    budget,
    recipeHeader: { seed: "s", ruleset: { rulesetId: "r@1" } },
    viewHeader: { mode: "deathmatch" },
    // Fragmentos pequeños: muchos fragmentos con pocos datos.
    recipeFragmentBytes: 4 * 1024,
    viewFragmentBytes: 4 * 1024,
    recipeMaxPendingBytes: 1024 * 1024,
    viewMaxPendingBytes: 1024 * 1024,
  });
}

/** Datos incompresibles: los bytes COMPRIMIDOS crecen casi como los de entrada. */
function noisy(t: number): string {
  return randomBytes(180).toString("hex") + t;
}

function feed(rec: ReplayRecorder, from: number, to: number): void {
  for (let t = from; t < to; t++) {
    rec.command({ tick: t, vehicleId: "veh_1", command: { n: noisy(t) } });
    if (t % 3 === 0) rec.snapshot({ tick: t, vehicles: [{ id: "veh_1", x: t, pad: noisy(t) }] });
    if (t % 30 === 0) rec.hash({ tick: t, hash: `h${t}` });
    if (t % 300 === 0) rec.checkpoint({ tick: t, hash: `k${t}`, components: { a: "1" } });
  }
}

/** Alimenta por tandas cediendo el bucle (los escritores son asíncronos) hasta que haya un fallo o se acabe. */
async function feedUntilFault(rec: ReplayRecorder, maxTicks: number): Promise<number> {
  let t = 0;
  while (t < maxTicks && !rec.recordingError) {
    try {
      feed(rec, t, t + 25);
    } catch {
      /* el sink lanza al detectar el fallo: eso es lo que se quiere observar */
    }
    t += 25;
    await new Promise((r) => setTimeout(r, 2));
  }
  return t;
}

const partialsOf = (d: string) => readdirSync(join(d, ".partial"));
const finalsOf = (d: string) => readdirSync(d).filter((f) => f.endsWith(".s9r") || f.endsWith(".s9v"));

describe("PR-5 · clase A: el tope de la propia batalla", () => {
  it("A1 tope por batalla (receta + vista): cierra TRUNCADO, verificable sólo con allowTruncated, y el sink deja de aceptar", async () => {
    const dir = tmp();
    const PER_BATTLE = 200 * 1024;
    const rec = await make(
      dir,
      budgetOf(() => ({ ...OK_LIMITS, maxBytesPerBattle: PER_BATTLE }), PLENTY, dir),
    );
    await feedUntilFault(rec, 20_000);
    expect(rec.battleLimit).toBeInstanceOf(ReplayLimitExceededError);
    expect(rec.recordingError).toBe(rec.battleLimit);
    // Desde el fallo, el sink LANZA (nunca acumula en RAM): los registros posteriores no entran.
    const before = rec.stats.recipe.records + rec.stats.view.records;
    for (let i = 0; i < 50; i++) expect(() => rec.command({ tick: 99_999, vehicleId: "veh_1", command: {} })).toThrow();
    expect(rec.stats.recipe.records + rec.stats.view.records).toBe(before);

    const closed = await rec.finish({ winner: null, ticks: 123, finalStateHash: "fh" });
    expect(closed.truncated).toBe(true);
    expect(closed.limit?.limit).toBe(PER_BATTLE);
    expect(closed.limit!.attempted).toBeGreaterThan(PER_BATTLE);
    expect(closed.recipe.summary.truncated || closed.view.summary.truncated).toBe(true);
    // Los datos escritos respetan el tope; sólo resultado, índice y pie usan el margen de emergencia (64 KiB por flujo).
    expect(closed.recipe.summary.bytes + closed.view.summary.bytes).toBeLessThanOrEqual(PER_BATTLE + 2 * 64 * 1024);
    // Truncado: íntegro pero NUNCA «válido» sin allowTruncated explícito.
    for (const s of [closed.recipe, closed.view]) {
      if (!s.summary.truncated) continue;
      const strict = await verifyFile(s.partial, { expectSha256: s.summary.sha256 });
      expect(strict.ok).toBe(false);
      expect(strict.reason).toBe("truncated");
      const lenient = await verifyFile(s.partial, { expectSha256: s.summary.sha256, allowTruncated: true });
      expect(lenient.ok).toBe(true);
      expect(lenient.truncated).toBe(true);
    }
  });

  it("A2 el ÚLTIMO fragmento (al cerrar) supera el tope: truncado (clase A), no fallo del entorno", async () => {
    const dir = tmp();
    // Tope que la batalla alcanza justo al volcar el búfer final (fragmentos de 64 KiB: nunca se llenan antes).
    const rec = await ReplayRecorder.create({
      dir,
      battleId: BID,
      attempt: 1,
      owner: OWNER,
      budget: budgetOf(() => ({ ...OK_LIMITS, maxBytesPerBattle: 8 * 1024 }), PLENTY, dir),
      recipeHeader: { seed: "s", ruleset: { rulesetId: "r@1" } },
      viewHeader: { mode: "deathmatch" },
      recipeFragmentBytes: 1 * MiB,
      viewFragmentBytes: 2 * MiB,
    });
    feed(rec, 0, 200); // ~100 KB de ruido sin comprimir, todo en el búfer del primer fragmento
    expect(rec.recordingError).toBeNull();
    const closed = await rec.finish({ winner: "A", ticks: 200, finalStateHash: "fh" });
    expect(closed.truncated).toBe(true);
    expect(rec.battleLimit).toBeInstanceOf(ReplayLimitExceededError);
    expect(readdirSync(join(dir, ".partial")).length).toBe(2); // los dos parciales cerrados, a la espera de publicar
  });
});

describe("PR-5 · clase A: carrera con el cierre", () => {
  it("A3 el tope se supera con `append`s aún ENCOLADOS cuando se llama a finish(): truncado, no «limit_hit» del cierre", async () => {
    const dir = tmp();
    const rec = await make(
      dir,
      budgetOf(() => ({ ...OK_LIMITS, maxBytesPerBattle: 20 * 1024 }), PLENTY, dir),
    );
    // Todo de golpe, SIN ceder el bucle: los escritores aún no han procesado nada cuando se pide el cierre.
    feed(rec, 0, 400);
    expect(rec.recordingError).toBeNull();
    const closed = await rec.finish({ winner: "A", ticks: 400, finalStateHash: "fh" });
    expect(closed.truncated).toBe(true);
    expect(rec.battleLimit).toBeInstanceOf(ReplayLimitExceededError);
    const lenient = await verifyFile(closed.recipe.partial, {
      expectSha256: closed.recipe.summary.sha256,
      allowTruncated: true,
    });
    expect(lenient.ok).toBe(true);
  });
});

describe("PR-5 · clase B: el límite es del entorno", () => {
  it("B1 reserva de espacio libre: aborta, borra los parciales y NO sella nada truncado", async () => {
    const dir = tmp();
    const probe: StorageProbe = { freeBytes: async () => 1 * GiB, usedBytes: async () => 0 }; // reserva 5 GiB
    const rec = await make(
      dir,
      budgetOf(() => OK_LIMITS, probe, dir),
    );
    await feedUntilFault(rec, 20_000);
    const err = rec.recordingError;
    expect(err).toBeInstanceOf(RecordingBudgetError);
    expect((err as RecordingBudgetError).denial).toBe("free_space_low");
    expect(err).toBeInstanceOf(StorageError);
    expect(rec.battleLimit).toBeNull();
    await expect(rec.finish({ winner: "A", ticks: 1, finalStateHash: "x" })).rejects.toBeInstanceOf(
      RecordingBudgetError,
    );
    expect(partialsOf(dir)).toEqual([]);
    expect(finalsOf(dir)).toEqual([]);
  });

  it("B2 cuota del volumen: cuenta lo ya escrito por el propio intento; aborta sin truncado", async () => {
    const dir = tmp();
    const probe: StorageProbe = { freeBytes: async () => 100 * GiB, usedBytes: async () => 1 * GiB - 30 * 1024 };
    const rec = await make(
      dir,
      budgetOf(() => ({ ...OK_LIMITS, quotaMaxBytes: 1 * GiB }), probe, dir),
    );
    await feedUntilFault(rec, 20_000);
    const err = rec.recordingError as RecordingBudgetError;
    expect(err).toBeInstanceOf(RecordingBudgetError);
    expect(err.denial).toBe("quota_exceeded");
    expect(err.phase).toBe("fragment");
    expect(rec.battleLimit).toBeNull();
    await expect(rec.finish({ winner: "A", ticks: 1, finalStateHash: "x" })).rejects.toBeInstanceOf(
      RecordingBudgetError,
    );
    expect(partialsOf(dir)).toEqual([]);
  });

  it("B3 EN CALIENTE: cuota y reserva se releen en cada fragmento; el tope por batalla queda fijado al empezar", async () => {
    const dir = tmp();
    const limits: ReplayLimits = { ...OK_LIMITS };
    const budget = budgetOf(() => limits, { freeBytes: async () => 10 * GiB, usedBytes: async () => 1 * GiB }, dir);
    await budget.admit(1000, { closing: false }, 0);
    limits.quotaMaxBytes = 1 * GiB; // se baja la cuota «desde la web»: el SIGUIENTE fragmento ya lo nota
    await expect(budget.admit(1000, { closing: false }, 0)).rejects.toMatchObject({ denial: "quota_exceeded" });
    limits.quotaMaxBytes = 20 * GiB;
    await budget.admit(1000, { closing: false }, 0);
    limits.minFreeBytes = 50 * GiB; // y lo mismo con la reserva
    await expect(budget.admit(1000, { closing: false }, 0)).rejects.toMatchObject({ denial: "free_space_low" });
    // El tope por batalla NO se mueve dentro del intento.
    limits.minFreeBytes = 5 * GiB;
    limits.maxBytesPerBattle = 1024;
    expect(budget.maxBytesPerBattle).toBe(64 * MiB);
    await budget.admit(1000, { closing: false }, 100 * 1024);
  });

  it("B4 el CIERRE no aplica reserva ni cuota, pero sí el tope por batalla", async () => {
    const dir = tmp();
    const starving: StorageProbe = { freeBytes: async () => 0, usedBytes: async () => 100 * GiB };
    const budget = budgetOf(() => ({ ...OK_LIMITS, maxBytesPerBattle: 10_000 }), starving, dir);
    await budget.admit(5_000, { closing: true }, 0); // volumen agotado, pero cerrar es lo que la reserva permite
    await expect(budget.admit(5_000, { closing: false }, 0)).rejects.toBeInstanceOf(RecordingBudgetError);
    await expect(budget.admit(5_000, { closing: true }, 6_000)).rejects.toBeInstanceOf(ReplayLimitExceededError);
  });

  it("B6 (grabador) con el disco JUSTO en la reserva al cerrar, el último fragmento se vuelca como cierre: batalla sana, sin free_space_low", async () => {
    const dir = tmp();
    // Libre = exactamente la reserva: cualquier fragmento NO de cierre se rechazaría (libre − fragmento < reserva).
    const probe: StorageProbe = { freeBytes: async () => OK_LIMITS.minFreeBytes, usedBytes: async () => 0 };
    const rec = await ReplayRecorder.create({
      dir,
      battleId: BID,
      attempt: 1,
      owner: OWNER,
      budget: budgetOf(() => OK_LIMITS, probe, dir),
      recipeHeader: { seed: "s", ruleset: { rulesetId: "r@1" } },
      viewHeader: { mode: "deathmatch" },
      // Fragmentos grandes: nada se vuelca a mitad; todo el contenido llega al volcado de cierre.
      recipeFragmentBytes: 1 * MiB,
      viewFragmentBytes: 2 * MiB,
    });
    feed(rec, 0, 60);
    expect(rec.recordingError).toBeNull();
    const closed = await rec.finish({ winner: "A", ticks: 60, finalStateHash: "fh" });
    expect(rec.recordingError).toBeNull();
    expect(closed.truncated).toBe(false);
    expect((await verifyFile(closed.recipe.partial, { expectSha256: closed.recipe.summary.sha256 })).ok).toBe(true);
    expect((await verifyFile(closed.view.partial, { expectSha256: closed.view.summary.sha256 })).ok).toBe(true);
    // control: a mitad de batalla (fragmento NO de cierre) el mismo disco sí se rechaza
    const dir2 = tmp();
    const rec2 = await make(
      dir2,
      budgetOf(() => OK_LIMITS, probe, dir2),
    );
    await feedUntilFault(rec2, 20_000);
    expect((rec2.recordingError as RecordingBudgetError).denial).toBe("free_space_low");
    await rec2.discard();
  });

  it("B5 compuerta previa: hueco para una batalla máxima + reserva, y que quepa en la cuota", async () => {
    const limits: ReplayLimits = { quotaMaxBytes: 10 * GiB, minFreeBytes: 5 * GiB, maxBytesPerBattle: 64 * MiB };
    await preflightCheck({ limits, probe: { freeBytes: async () => 6 * GiB, usedBytes: async () => 1 * GiB } });
    await expect(
      preflightCheck({
        limits,
        probe: { freeBytes: async () => 5 * GiB + 64 * MiB - 1, usedBytes: async () => 0 },
      }),
    ).rejects.toMatchObject({ denial: "free_space_low", phase: "preflight" });
    await expect(
      preflightCheck({
        limits,
        probe: { freeBytes: async () => 100 * GiB, usedBytes: async () => 10 * GiB - 64 * MiB + 1 },
      }),
    ).rejects.toMatchObject({ denial: "quota_exceeded", phase: "preflight" });
    // el borde exacto SÍ cabe
    await preflightCheck({
      limits,
      probe: { freeBytes: async () => 5 * GiB + 64 * MiB, usedBytes: async () => 10 * GiB - 64 * MiB },
    });
  });
});

describe("PR-5 · el escritor", () => {
  it("W1 `admit` sólo se invoca para fragmentos de DATOS (no resultado, índice ni pie) y el último lleva closing:true", async () => {
    const dir = tmp();
    const calls: { n: number; closing: boolean }[] = [];
    const w = await S9rWriter.create(join(dir, "w.s9r.part"), {
      kind: "R",
      header: { battleId: BID },
      maxBytes: 10 * MiB,
      fragmentBytes: 2048,
      admit: (n, ctx) => {
        calls.push({ n, closing: ctx.closing });
      },
    });
    for (let t = 0; t < 40; t++) await w.append(JSON.stringify({ k: "c", t, v: noisy(t) }), t);
    const dataFramesBeforeClose = calls.length;
    expect(dataFramesBeforeClose).toBeGreaterThan(1);
    expect(calls.every((c) => !c.closing)).toBe(true);
    await w.close({ result: { winner: "A" } });
    // el cierre vuelca el último búfer (un fragmento de datos más, con closing:true); resultado/índice/pie no admiten
    expect(calls.length).toBe(dataFramesBeforeClose + 1);
    expect(calls[calls.length - 1].closing).toBe(true);
  });

  it("W2 clase B envenena el escritor (no acepta más); clase A no (sólo closeTruncated)", async () => {
    const dir = tmp();
    const mk = (admit: () => void, name: string) =>
      S9rWriter.create(join(dir, name), {
        kind: "R",
        header: { battleId: BID },
        maxBytes: 10 * MiB,
        fragmentBytes: 1024,
        admit,
      });
    const b = await mk(() => {
      throw new RecordingBudgetError("quota_exceeded", "fragment", "cuota");
    }, "b.part");
    await expect(
      (async () => {
        for (let t = 0; t < 40; t++) await b.append(JSON.stringify({ t, v: noisy(t) }), t);
      })(),
    ).rejects.toBeInstanceOf(RecordingBudgetError);
    await expect(b.append("{}", 1)).rejects.toBeInstanceOf(RecordingBudgetError); // envenenado
    await b.abort();

    const a = await mk(() => {
      throw new ReplayLimitExceededError(1, 2);
    }, "a.part");
    await expect(
      (async () => {
        for (let t = 0; t < 40; t++) await a.append(JSON.stringify({ t, v: noisy(t) }), t);
      })(),
    ).rejects.toBeInstanceOf(ReplayLimitExceededError);
    const s = await a.closeTruncated({ result: { winner: null } }); // no envenena: se puede sellar truncado
    expect(s.truncated).toBe(true);
    expect(existsSync(join(dir, "a.part"))).toBe(true);
  });
});
