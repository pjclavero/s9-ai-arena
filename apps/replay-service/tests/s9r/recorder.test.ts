/**
 * V1 REPLAYS PR-3 · `ReplayRecorder` (adaptador ReplaySink → S9rWriter) y `publishRecording`.
 *
 * RC1 ida y vuelta real a disco (receta y vista verifican ok:true, comandos con elisión "=").
 * RC2 cola ACOTADA: con el disco atascado el sink lanza SÍNCRONO al llenarse; nunca crece.
 * RC3 ENOSPC a mitad: la SIGUIENTE llamada del sink lanza (no se espera al cierre) y no quedan parciales.
 * RC4 fallo al cerrar (índice/pie): finish rechaza y borra los parciales.
 * RC5 drenaje con el escritor atascado: fallo `recording_stall`, no espera infinita.
 * RC6 nombres por batalla, intento y titular (sha8; el titular no aparece en claro).
 * RC7 publicación con prueba de cierre REAL: una copia del summary no publica (nunca sin prueba).
 * RC8 memoria acotada: batalla sintética larga (S9_PR3_TICKS, defecto 45 000 ticks x 8 vehículos)
 *     con escritura real; heapUsed tras gc() sin pendiente y por debajo del umbral.
 * Cada caso tiene su mutante en apps/replay-service/scripts/replay-pr3-mutants.mjs.
 */
import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import {
  ReplayRecorder,
  RecordingBackpressureError,
  RecordingStallError,
  owner8,
  recordingPaths,
} from "../../src/s9r/recorder.js";
import { S9rReader } from "../../src/s9r/reader.js";
import { verifyFile } from "../../src/s9r/verify.js";
import { StorageFullError } from "../../src/s9r/errors.js";
import { publishRecording } from "../../src/artifacts.js";
import { faultFs } from "./fault-fs.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pr3-rec-"));
  dirs.push(d);
  mkdirSync(join(d, ".partial"), { recursive: true });
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const BID = "b0f1e2d3-0000-4000-8000-000000000001";
const OWNER = "worker-abc:job-123:1";

function make(dir: string, extra: Record<string, unknown> = {}) {
  return ReplayRecorder.create({
    dir,
    battleId: BID,
    attempt: 2,
    owner: OWNER,
    recipeHeader: { seed: "s", ruleset: { rulesetId: "r@1" } },
    viewHeader: { mode: "deathmatch" },
    ...extra,
  });
}

/** Comandos de un tick (2 vehículos): veh_1 repite comando, veh_2 cambia. */
function feed(rec: ReplayRecorder, ticks: number): { tick: number; vehicleId: string; command: any }[] {
  const sent: { tick: number; vehicleId: string; command: any }[] = [];
  for (let t = 0; t < ticks; t++) {
    for (const v of ["veh_1", "veh_2"]) {
      const command = v === "veh_1" ? { move: { throttle: 1 } } : { move: { throttle: t % 3 } };
      rec.command({ tick: t, vehicleId: v, command });
      sent.push({ tick: t, vehicleId: v, command });
    }
    if (t % 3 === 0) rec.snapshot({ tick: t, vehicles: [{ id: "veh_1", x: t }] });
    if (t % 30 === 0) rec.hash({ tick: t, hash: `h${t}` });
    if (t % 300 === 0) rec.checkpoint({ tick: t, hash: `k${t}`, components: { a: "1" } });
  }
  rec.event({ tick: ticks - 1, kind: "vehicle_eliminated", targetId: "veh_2" });
  return sent;
}

function partials(dir: string): string[] {
  return readdirSync(join(dir, ".partial"));
}

describe("ReplayRecorder", () => {
  it("RC1 ida y vuelta: receta y vista se cierran con prueba, verifican ok:true y la receta reconstruye los comandos", async () => {
    const dir = tmp();
    const rec = await make(dir);
    const sent = feed(rec, 1000);
    const closed = await rec.finish({ winner: "A", ticks: 1000, finalStateHash: "fh" });
    expect((await verifyFile(closed.recipe.partial, { expectSha256: closed.recipe.summary.sha256 })).ok).toBe(true);
    expect((await verifyFile(closed.view.partial, { expectSha256: closed.view.summary.sha256 })).ok).toBe(true);
    const r = await S9rReader.open(closed.recipe.partial, { expectBattleId: BID });
    expect(r.header.seed).toBe("s");
    expect((r.header.s9r as any).attempt).toBe(2);
    expect(await r.readResult()).toEqual({ winner: "A", ticks: 1000, finalStateHash: "fh" });
    const last = new Map<string, any>();
    const got: { tick: number; vehicleId: string; command: any }[] = [];
    let elided = 0;
    for await (const line of r.records()) {
      const x = JSON.parse(line);
      if (x.k !== "c") continue;
      if (x["="] === 1) elided++;
      const command = x["="] === 1 ? last.get(x.v) : x.c;
      last.set(x.v, command);
      got.push({ tick: x.t, vehicleId: x.v, command });
    }
    await r.close();
    expect(got).toEqual(sent);
    expect(elided).toBeGreaterThan(900); // veh_1 repite siempre: la elisión actúa
    const v = await S9rReader.open(closed.view.partial);
    let snaps = 0;
    let events = 0;
    for await (const line of v.records()) {
      const x = JSON.parse(line);
      if (x.k === "s") snaps++;
      if (x.k === "e") events++;
    }
    await v.close();
    expect(snaps).toBe(334);
    expect(events).toBe(1);
  });

  it("RC2 cola acotada: con el disco atascado el sink lanza SÍNCRONO al llenarse y la cola nunca supera su tope", async () => {
    const dir = tmp();
    const fs = faultFs({ hangWriteAfterBytes: 2048, match: ".s9r.part" });
    const max = 64 * 1024;
    const rec = await make(dir, { fs, recipeMaxPendingBytes: max, recipeFragmentBytes: 16 * 1024 });
    let thrown: unknown = null;
    let n = 0;
    try {
      for (; n < 100_000; n++) rec.command({ tick: n, vehicleId: "veh_1", command: { n } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RecordingBackpressureError);
    expect(n).toBeLessThan(100_000);
    expect(rec.stats.recipe.peakPendingBytes).toBeLessThanOrEqual(max);
    // Desde el primer fallo, todo lanza (el motor fija recordingFault y para).
    expect(() => rec.hash({ tick: n + 1, hash: "x" })).toThrow(RecordingBackpressureError);
    fs.release();
    await expect(rec.finish({})).rejects.toBeInstanceOf(RecordingBackpressureError);
    expect(partials(dir)).toEqual([]);
  });

  it("RC3 ENOSPC a mitad: la siguiente llamada del sink lanza (sin esperar al cierre) y no quedan parciales", async () => {
    const dir = tmp();
    const fs = faultFs({ failWriteAfterBytes: 4096, match: ".s9v.part", errCode: "ENOSPC" });
    const rec = await make(dir, { fs, viewFragmentBytes: 2048, viewMaxPendingBytes: 1024 * 1024 });
    let thrown: unknown = null;
    for (let t = 0; t < 5000 && !thrown; t++) {
      try {
        rec.snapshot({ tick: t, blob: randomBytes(100).toString("hex") });
      } catch (e) {
        thrown = e;
      }
      if (t % 10 === 0) await new Promise((r) => setImmediate(r));
    }
    expect(thrown).toBeInstanceOf(StorageFullError);
    expect(rec.recordingError).toBe(thrown);
    expect(() => rec.command({ tick: 1, vehicleId: "veh_1", command: {} })).toThrow(StorageFullError);
    await expect(rec.finish({})).rejects.toBeInstanceOf(StorageFullError);
    expect(partials(dir)).toEqual([]);
  });

  it("RC4 fallo al cerrar (índice/pie): finish rechaza, no hay prueba y no quedan parciales", async () => {
    const dir = tmp();
    const fs = faultFs({ failWriteAfterBytes: 600, match: ".s9r.part", errCode: "ENOSPC" });
    const rec = await make(dir, { fs });
    // Pocos registros incompresibles: caben en el búfer (1 MiB) y el disco se llena en el cierre.
    for (let t = 0; t < 10; t++)
      rec.command({ tick: t, vehicleId: "veh_1", command: { pad: randomBytes(80).toString("hex"), t } });
    await new Promise((r) => setImmediate(r));
    expect(rec.recordingError).toBeNull();
    await expect(rec.finish({ winner: "A" })).rejects.toBeInstanceOf(StorageFullError);
    expect(partials(dir)).toEqual([]);
  });

  it("RC5 drenaje con el escritor atascado: fallo recording_stall en vez de esperar para siempre", async () => {
    const dir = tmp();
    const fs = faultFs({ hangWriteAfterBytes: 400, match: ".s9v.part" });
    const rec = await make(dir, { fs, viewMaxPendingBytes: 16 * 1024, viewFragmentBytes: 1024, stallMs: 50 });
    for (let t = 0; t < 60; t++) rec.snapshot({ tick: t, blob: randomBytes(100).toString("hex") });
    await rec.drain();
    expect(rec.recordingError).toBeInstanceOf(RecordingStallError);
    expect(() => rec.snapshot({ tick: 99 })).toThrow(RecordingStallError);
    fs.release();
    await expect(rec.finish({})).rejects.toBeInstanceOf(RecordingStallError);
  }, 5_000);

  it("RC6 ficheros por batalla, intento y titular: el titular sólo aparece como sha8", async () => {
    const p = recordingPaths("/d", BID, 7, OWNER);
    expect(p.recipePartial).toBe(`/d/.partial/${BID}.7.${owner8(OWNER)}.s9r.part`);
    expect(p.viewPartial).toBe(`/d/.partial/${BID}.7.${owner8(OWNER)}.s9v.part`);
    expect(p.recipeFinal).toBe(`/d/${BID}.7.s9r`);
    expect(p.viewFinal).toBe(`/d/${BID}.7.s9v`);
    expect(p.recipePartial).not.toContain("worker-abc");
    expect(recordingPaths("/d", BID, 7, "otro").recipePartial).not.toBe(p.recipePartial);
    expect(() => recordingPaths("/d", "../x", 1, OWNER)).toThrow(RangeError);
  });

  it("RC7 publicación: con la prueba real publica receta y vista; con una COPIA del summary no publica nada", async () => {
    const calls: string[] = [];
    const trx: any = (table: string) => ({
      insert: async () => calls.push(`insert:${table}`),
      where: () => ({ update: async () => (calls.push(`update:${table}`), 1) }),
    });
    const dir = tmp();
    const rec = await make(dir);
    feed(rec, 50);
    const closed = await rec.finish({ ticks: 50 });
    const forged = { ...closed, recipe: { ...closed.recipe, summary: { ...closed.recipe.summary } } };
    await expect(publishRecording(trx, { id: BID }, forged)).rejects.toMatchObject({ code: "proof_invalid" });
    expect(existsSync(closed.recipe.final)).toBe(false);
    expect(existsSync(closed.view.final)).toBe(false);
    const out = await publishRecording(trx, { id: BID }, closed);
    expect(out.replayRef).toBe(closed.recipe.final);
    expect(existsSync(closed.recipe.final) && existsSync(closed.view.final)).toBe(true);
    expect(partials(dir)).toEqual([]);
    expect(calls).toEqual(["insert:replay_artifacts", "update:battles", "insert:replay_artifacts", "update:battles"]);
  });

  it("RC8 memoria acotada: batalla sintética larga con escritura real; heapUsed tras gc() sin pendiente", async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const TICKS = Number(process.env.S9_PR3_TICKS ?? 45_000);
    const VEH = 8;
    const dir = tmp();
    const rec = await make(dir);
    const frame = (t: number) => ({
      tick: t,
      vehicles: Array.from({ length: VEH }, (_, i) => ({
        id: `veh_${i + 1}`,
        position: { x: (t * 0.01 + i) % 100, y: (t * 0.02 + i) % 60 },
        heading: (t % 628) / 100,
        hp: 100 - (t % 50),
        armor: [10, 10, 10, 10],
        modules: [{ id: "turret_main", heat: t % 7 }],
      })),
      projectiles: [],
    });
    gc();
    const base = process.memoryUsage().heapUsed;
    const samples: number[] = [];
    for (let t = 0; t < TICKS; t++) {
      for (let i = 0; i < VEH; i++) {
        const command = {
          forTick: t,
          move: { throttle: 1, steer: ((t >> 5) % 3) - 1 },
          fire: t % 9 === 0 ? ["turret_main"] : [],
        };
        rec.command({ tick: t, vehicleId: `veh_${i + 1}`, command });
      }
      if (t % 3 === 0) {
        rec.snapshot(frame(t));
      }
      if (t % 30 === 0) rec.hash({ tick: t, hash: "0".repeat(64) });
      if (t % 300 === 0) rec.checkpoint({ tick: t, hash: "1".repeat(64), components: { a: "2".repeat(64) } });
      if (t % 25 === 0) {
        await new Promise((r) => setImmediate(r));
        await rec.drain();
      }
      if (t > 0 && t % 5000 === 0) {
        gc();
        samples.push(process.memoryUsage().heapUsed - base);
      }
    }
    const closed = await rec.finish({ ticks: TICKS });
    gc();
    const end = process.memoryUsage().heapUsed - base;
    const MiB = 1024 * 1024;
    const peak = Math.max(...samples, end);
    const growth = samples.length > 1 ? samples[samples.length - 1] - samples[0] : 0;
    // Umbrales: el grabador retiene como máximo colas + un fragmento por flujo (≈ 12 MiB).
    expect(peak, `pico ${(peak / MiB).toFixed(1)} MiB`).toBeLessThan(24 * MiB);
    expect(growth, `crecimiento ${(growth / MiB).toFixed(1)} MiB`).toBeLessThan(6 * MiB);
    expect(rec.stats.view.peakPendingBytes).toBeLessThanOrEqual(4 * MiB);
    expect((await verifyFile(closed.recipe.partial)).ok).toBe(true);
    expect((await verifyFile(closed.view.partial)).ok).toBe(true);
    expect(closed.recipe.summary.records).toBe(TICKS * VEH + Math.ceil(TICKS / 30) + Math.ceil(TICKS / 300));
    const line =
      `RC8 ticks=${TICKS} heap_peak_MiB=${(peak / MiB).toFixed(2)} growth_MiB=${(growth / MiB).toFixed(2)} ` +
      `recipe_bytes=${closed.recipe.summary.bytes} view_bytes=${closed.view.summary.bytes} rss_MiB=${(process.memoryUsage().rss / MiB).toFixed(0)}`;
    if (process.env.S9_PR3_METRICS) appendFileSync(process.env.S9_PR3_METRICS, line + "\n");
  }, 300_000);
});
