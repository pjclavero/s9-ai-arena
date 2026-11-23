/**
 * V1 REPLAYS PR-4 · correcciones de la revisión de #340 (PostgreSQL embebida + API real).
 *
 * L1 (P1-1) descarga pública con CONTRAPRESIÓN: con un cliente que no lee, lo encolado en el proceso
 *    queda acotado (writableLength <= highWaterMark + un trozo) y la descarga se aborta por atasco;
 *    con un cliente lento que sí lee, el documento es idéntico al de uno rápido.
 * L2 (P1-2) tope de rango del segmento: sin parámetros, 600 ticks; más de 1200, 400
 *    `segment_range_too_large`; `rawSegment` nunca devuelve más de 1200 ticks.
 * L3 (P2-1) una referencia de formato anterior es «sin replay»: replayAvailable=false, fuera de los
 *    listados y estadísticas «unavailable»; la S9R/1 sí cuenta.
 * L4 (P2-2) una vista reescrita (sha distinto de view_sha256) no se sirve: índice, segmento y
 *    descarga pública dan 404.
 * L5 (P2-3) memoria: verify, estadísticas y descarga de un replay de 9 000 ticks x 4 vehículos con
 *    heapUsed acotado (muestreo durante la operación). La medición pesada es del LAB.
 * Mutantes: apps/replay-service/scripts/replay-pr4-mutants.mjs (M-L*).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import v8 from "node:v8";
import vm from "node:vm";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { seedDev, DEV_USERS, DEFAULT_RULESET_ID } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot, IdleBot } from "../../arena-engine/src/stubs.js";
import { registerS9rReplay, writeS9rReplay, type S9rFixture } from "../../replay-service/src/testing/s9r-fixture.js";
import { ViewReader } from "../../replay-service/src/s9r/view.js";
import { verifyRecipePath } from "../../replay-service/src/recipe-verify.js";
import { computeBattleStatsFrom, recipeStatsSource } from "../../replay-service/src/stats.js";
import {
  ClientStalledError,
  MAX_SEGMENT_TICKS,
  parseRange,
  rawSegment,
  streamPublicDocument,
  viewerMetaFromView,
} from "./replay-s9r.js";

let h: TestDbHandle;
let app: Express;
let admin: string;
let dir: string;
let small: Replay;
let big: Replay;
let fxSmall: S9rFixture;
let fxBig: S9rFixture;
let bigId: string;
let smallId: string;

const RED = "bot_red";
const BLUE = "bot_blue";

async function battleRow(fx: S9rFixture | null, ref?: string): Promise<string> {
  const id = randomUUID();
  await h.db("battles").insert({
    id,
    status: "finished",
    official: false,
    mode: "deathmatch",
    ruleset_id: DEFAULT_RULESET_ID,
    map_id: "mvp-arena-01",
    map_version: 1,
    replay_ref: ref ?? fx?.path ?? null,
    replay_hash: fx?.sha256 ?? null,
    result: JSON.stringify({ score: {}, ticks: 3000 }),
    finished_at: h.db.fn.now(),
  });
  if (fx && !ref) await registerS9rReplay(h.db, id, fx);
  return id;
}

/** Cliente que NO lee nunca (como el de la sonda de la revisión). */
function stalledRes(hwm = 16 * 1024): any {
  const w: any = new Writable({ highWaterMark: hwm, write(_c, _e, _cb) {} });
  return Object.assign(w, {
    status: () => w,
    setHeader: () => w,
  });
}

/** Cliente LENTO que sí lee (cada trozo tarda un tick de E/S); `keep` acumula lo recibido. */
function slowRes(keep = true): any {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let peak = 0;
  const w: any = new Writable({
    highWaterMark: 16 * 1024,
    write(c, _e, cb) {
      bytes += c.length;
      if (keep) chunks.push(Buffer.from(c));
      setImmediate(cb);
    },
  });
  const orig = w.write.bind(w);
  w.write = (c: any, ...r: any[]) => {
    const ok = orig(c, ...r);
    if (w.writableLength > peak) peak = w.writableLength;
    return ok;
  };
  return Object.assign(w, {
    status: () => w,
    setHeader: () => w,
    body: () => Buffer.concat(chunks).toString("utf8"),
    bytes: () => bytes,
    peak: () => peak,
    finished: () => new Promise((r) => (w.writableFinished ? r(undefined) : w.once("finish", r))),
  });
}

async function play(seed: string, ticks: number, n: number, hunters: boolean): Promise<Replay> {
  const participants = Array.from({ length: n }, (_, i) => ({
    id: `v_${i}`,
    botId: i % 2 ? BLUE : RED,
    team: `t${i}`,
    spec: i % 2 ? scoutLoadout() : gunnerLoadout(),
  }));
  return record(
    {
      battleId: seed,
      seed,
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: ticks }),
      map: emptyArena(),
      participants,
    },
    (b) => {
      for (const p of participants) b.attachBot(p.id, hunters ? new HunterBot(p.botId) : new IdleBot(p.botId));
    },
  );
}

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, publicReplaysEnabled: true, anonQuota: { max: 100_000, windowMs: 3600_000 } });
  admin = await tokenFor(h.db, DEV_USERS.admin);
  dir = mkdtempSync(join(tmpdir(), "pr340-"));
  small = await play("pr340_small", 3000, 2, true);
  fxSmall = await writeS9rReplay(dir, small, { viewFragmentBytes: 16 * 1024 });
  smallId = await battleRow(fxSmall);
  big = await play("pr340_big", 9000, 4, false);
  // Fragmentos de vista pequeños: lo que el lector retiene por fragmento es despreciable y la
  // medición de L5 distingue «streaming» de «documento retenido» sin depender del muestreo.
  fxBig = await writeS9rReplay(dir, big, { viewFragmentBytes: 64 * 1024 });
  bigId = await battleRow(fxBig);
}, 300_000);
afterAll(async () => {
  await h.stop();
  rmSync(dir, { recursive: true, force: true });
});

const auth = () => ({ Authorization: `Bearer ${admin}` });

describe("L1 (P1-1) · descarga pública con contrapresión", () => {
  it("cliente que no lee: lo encolado queda acotado y la descarga se aborta por atasco", async () => {
    const res = stalledRes();
    const view = await ViewReader.open(fxSmall.viewPath);
    const battle = { id: smallId, replay_ref: fxSmall.path };
    await expect(streamPublicDocument(res, battle, view, null, { stallMs: 200 })).rejects.toBeInstanceOf(
      ClientStalledError,
    );
    await view.close();
    // Un frame proyectado de este replay pesa < 4 KiB: hwm (16 KiB) + un trozo.
    expect(res.writableLength).toBeLessThanOrEqual(16 * 1024 + 8 * 1024);
  });

  it("cliente lento que lee: documento completo, idéntico al de la API, con el búfer siempre acotado", async () => {
    const res = slowRes();
    const view = await ViewReader.open(fxSmall.viewPath);
    const meta = await viewerMetaFromView(h.db, view.header); // la misma meta que usa la API
    await streamPublicDocument(res, { id: smallId, replay_ref: fxSmall.path }, view, meta, { stallMs: 5_000 });
    await view.close();
    await res.finished();
    const doc = JSON.parse(res.body());
    expect(doc.snapshots.length).toBe(small.snapshots.length);
    expect(res.peak()).toBeLessThanOrEqual(16 * 1024 + 8 * 1024);
    const viaApi = await request(app).get(`/public/replays/${smallId}/download`);
    expect(viaApi.status).toBe(200);
    expect(viaApi.body.snapshots).toEqual(doc.snapshots);
    expect(viaApi.body.events).toEqual(doc.events);
  });
});

describe("L2 (P1-2) · tope de rango del segmento", () => {
  it("parseRange: por defecto 600 ticks, tope 1200, más ⇒ too_large", () => {
    expect(parseRange(undefined, undefined, 45_000)).toEqual({ from: 0, to: 599 });
    expect(parseRange("1000", undefined, 45_000)).toEqual({ from: 1000, to: 1599 });
    expect(parseRange("0", String(MAX_SEGMENT_TICKS - 1), 45_000)).toEqual({ from: 0, to: 1199 });
    expect(parseRange("0", String(MAX_SEGMENT_TICKS), 45_000)).toBe("too_large");
    expect(parseRange("5", "1", 45_000)).toBeNull();
  });

  it("rawSegment nunca devuelve más de 1200 ticks aunque se le pida la batalla entera", async () => {
    const view = await ViewReader.open(fxBig.viewPath);
    const seg: any = await rawSegment({ id: bigId }, view, { from: 0, to: 9000 });
    await view.close();
    const ticks = seg.snapshots.map((s: any) => s.tick);
    expect(big.result.ticks).toBe(9000);
    expect(Math.max(...ticks)).toBeLessThan(MAX_SEGMENT_TICKS);
    expect(seg.snapshots.length).toBeLessThan(big.snapshots.length / 4);
  });

  it("HTTP: sin parámetros 200 acotado; más de 1200 ticks ⇒ 400 segment_range_too_large", async () => {
    const def = await request(app).get(`/replays/${bigId}/segment`).set(auth());
    expect(def.status).toBe(200);
    expect(Math.max(...def.body.snapshots.map((s: any) => s.tick))).toBeLessThan(600);
    const wide = await request(app).get(`/replays/${smallId}/segment?fromTick=0&toTick=3000`).set(auth());
    expect(wide.status).toBe(400);
    expect(wide.body.error).toBe("segment_range_too_large");
    const ok = await request(app).get(`/replays/${smallId}/segment?fromTick=0&toTick=1199`).set(auth());
    expect(ok.status).toBe(200);
  });
});

describe("L3 (P2-1) · referencia de formato anterior = «sin replay»", () => {
  it("replayAvailable=false, fuera de los listados y estadísticas «unavailable»; la S9R/1 sí cuenta", async () => {
    const legacyId = await battleRow(null, join(dir, "legacy.replay"));
    const d = await request(app).get(`/battles/${legacyId}`).set(auth());
    expect(d.status).toBe(200);
    expect(d.body.replayAvailable).toBe(false);
    const s9r = await request(app).get(`/battles/${smallId}`).set(auth());
    expect(s9r.body.replayAvailable).toBe(true);
    const list = await request(app).get(`/replays?limit=100`).set(auth());
    const ids = list.body.items.map((i: any) => i.battleId);
    expect(ids).toContain(smallId);
    expect(ids).not.toContain(legacyId);
    const pub = await request(app).get(`/public/replays?limit=50`);
    expect(pub.body.items.map((i: any) => i.battleId ?? i.id)).not.toContain(legacyId);
    expect((await request(app).get(`/public/replays/${legacyId}`)).status).toBe(404);
    const st = await request(app).get(`/battles/${legacyId}/stats`).set(auth());
    expect(st.body.status).toBe("unavailable");
  });
});

describe("L4 (P2-2) · la vista se contrasta con view_sha256", () => {
  it("una vista sustituida (S9R/1 válida, otro contenido) no se sirve", async () => {
    const other = await writeS9rReplay(mkdtempSync(join(tmpdir(), "pr340-o-")), big, { battleId: "other" });
    const fx = await writeS9rReplay(mkdtempSync(join(tmpdir(), "pr340-v-")), small, { battleId: "victim" });
    const id = await battleRow(fx);
    expect((await request(app).get(`/replays/${id}/index`).set(auth())).status).toBe(200);
    copyFileSync(other.viewPath, fx.viewPath); // vista coherente (pie, índice, cadena) pero ajena
    for (const p of [`/replays/${id}/index`, `/replays/${id}/segment`]) {
      expect((await request(app).get(p).set(auth())).status, p).toBe(404);
    }
    expect((await request(app).get(`/public/replays/${id}/download`)).status).toBe(404);
  });
});

describe("L5 (P2-3) · memoria acotada de verify, estadísticas y descarga", () => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  const MiB = 1024 * 1024;

  async function peakDuring(fn: () => Promise<unknown>): Promise<number> {
    gc();
    const base = process.memoryUsage().heapUsed;
    let peak = 0;
    // Se mide lo RETENIDO (tras gc), no la basura transitoria entre recolecciones.
    const t = setInterval(() => {
      gc();
      const d = process.memoryUsage().heapUsed - base;
      if (d > peak) peak = d;
    }, 25);
    try {
      await fn();
    } finally {
      clearInterval(t);
    }
    const d = process.memoryUsage().heapUsed - base;
    return Math.max(peak, d);
  }

  it("9 000 ticks x 4 vehículos: verify, estadísticas y descarga sin cargar el replay", async () => {
    const rawView = JSON.stringify(big.snapshots).length + JSON.stringify(big.events).length;
    const vPeak = await peakDuring(async () => {
      const v = await verifyRecipePath(fxBig.path);
      expect(v.verification.matches).toBe(true);
    });
    const sPeak = await peakDuring(async () => {
      const s = await computeBattleStatsFrom(await recipeStatsSource(fxBig.path));
      expect(s.durationTicks).toBe(9000);
    });
    const res = slowRes(false); // descarta lo recibido: sólo se mide el lado del servidor
    const dPeak = await peakDuring(async () => {
      const view = await ViewReader.open(fxBig.viewPath);
      await streamPublicDocument(res, { id: bigId, replay_ref: fxBig.path }, view, null);
      await view.close();
      await res.finished();
    });
    expect(res.bytes()).toBeGreaterThan(rawView / 4); // no vacuo: el documento entero pasó
    // La descarga: el documento entero (proyección del orden de rawView, ~6 MiB) NO pasa por la
    // memoria; lo retenido (medido: ~0,4 MiB) queda muy por debajo de 2 MiB.
    expect(res.peak()).toBeLessThanOrEqual(16 * 1024 + 8 * 1024);
    expect(
      dPeak,
      `descarga ${(dPeak / MiB).toFixed(1)} MiB; vista cruda ${(rawView / MiB).toFixed(1)} MiB`,
    ).toBeLessThan(2 * MiB);
    expect(vPeak, `verify ${(vPeak / MiB).toFixed(1)} MiB`).toBeLessThan(48 * MiB);
    expect(sPeak, `stats ${(sPeak / MiB).toFixed(1)} MiB`).toBeLessThan(48 * MiB);
    if (process.env.S9_PR4_METRICS) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(
        process.env.S9_PR4_METRICS,
        `L5 rawView_MiB=${(rawView / MiB).toFixed(2)} verify_MiB=${(vPeak / MiB).toFixed(2)} ` +
          `stats_MiB=${(sPeak / MiB).toFixed(2)} download_MiB=${(dPeak / MiB).toFixed(2)} ` +
          `download_buffer_peak_B=${res.peak()}\n`,
      );
    }
  }, 300_000);
});
