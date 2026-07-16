/**
 * E12 · T12.1 — DoD: "la suite falla correctamente si se sabotea cualquier
 * pieza (verificado con 6 sabotajes deliberados, uno por paso)".
 *
 * Cada test sabotea UNA pieza del flujo de mvp-success.e2e.test.ts y afirma
 * que el sistema (y por tanto la suite E2E) lo DETECTA: la detección es la
 * aserción. Si algún día un sabotaje deja de detectarse, este archivo se pone
 * rojo — que es exactamente lo que pide la DoD.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import type { Express } from "express";
import jwt from "jsonwebtoken";
import { WebSocket } from "ws";

import { startTestDb, type TestDbHandle } from "../../apps/api/src/testing/test-db.js";
import { seedDev, DEFAULT_RULESET_ID, DEV_USERS } from "../../apps/api/src/db/seeds/dev.js";
import { tokenFor } from "../../apps/api/src/testing/helpers.js";
import { createApp } from "../../apps/api/src/app.js";
import { E6PipelineBotManager } from "../../apps/api/src/services/e6-bot-manager.js";
import { SpectateGateway } from "../../apps/api/src/spectate/gateway.js";
import { pySecretFiles } from "../../apps/bot-manager/tests/fixtures.js";
import { loadRuleset } from "../../packages/game-rules/index.js";
import { initPhysics } from "../../apps/arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../apps/arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../apps/arena-engine/src/fixtures.js";
import { HunterBot } from "../../apps/arena-engine/src/stubs.js";
import { toEngineMap } from "../../apps/map-service/src/to-engine-map.js";
import { ingestReplay, type StoredReplay } from "../../apps/replay-service/src/store.js";
import { runStatsJob } from "../../apps/replay-service/src/stats.js";

let h: TestDbHandle;
let app: Express;
let dev: string;
let replay: Replay;
let stored: StoredReplay;
let dir: string;
let battleId: string;

async function insertFinishedBattle(extra: Record<string, unknown> = {}): Promise<string> {
  const [row] = await h.db("battles")
    .insert({
      status: "finished",
      official: true,
      mode: "deathmatch",
      ruleset_id: DEFAULT_RULESET_ID,
      map_id: "mvp-arena-01",
      map_version: 1,
      seed: "e12-sabotage",
      ...extra,
    })
    .returning("*");
  return row.id as string;
}

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({
    db: h.db,
    botManager: new E6PipelineBotManager(h.db),
    anonQuota: { max: 10_000, windowMs: 3600_000 },
  });
  dev = await tokenFor(h.db, DEV_USERS.developer);

  // Batalla corta REAL del motor: víctima de los sabotajes de replay/stats.
  replay = await record(
    {
      battleId: "e12_sabotage_dm",
      seed: "e12_sabotage_dm",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 240 }),
      map: emptyArena(),
      participants: [
        { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
        { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_red", new HunterBot("bot_red"));
      b.attachBot("v_blue", new HunterBot("bot_blue"));
    },
  );
  dir = mkdtempSync(join(tmpdir(), "e12-sabotage-replays-"));
  stored = ingestReplay(dir, replay, { official: true });
  battleId = await insertFinishedBattle({
    replay_ref: stored.path,
    replay_hash: stored.index.sha256,
    final_state_hash: replay.result.finalStateHash,
    result: JSON.stringify({ winner: replay.result.winner, ticks: replay.result.ticks }),
  });
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe("T12.1 · 6 sabotajes deliberados, uno por paso del criterio 26.1", () => {
  it("sabotaje 1 (registro/identidad): credenciales falsas y contraseñas débiles se rechazan", async () => {
    // Contraseña < 12 chars: el registro NO cuela.
    const weak = await request(app)
      .post("/auth/register")
      .send({ email: "saboteador@example.com", password: "corta", displayName: "Saboteador" });
    expect(weak.status).toBe(400);

    // Login con contraseña equivocada contra un usuario real: 401, sin token.
    const bad = await request(app)
      .post("/auth/login")
      .send({ email: DEV_USERS.developer, password: "no-es-la-contraseña" });
    expect(bad.status).toBe(401);
    expect(bad.body.accessToken).toBeUndefined();
  });

  it("sabotaje 2 (pipeline E6): un secreto plantado en el código deja la versión rejected", async () => {
    const auth = { Authorization: `Bearer ${dev}` };
    const bot = await request(app).post("/bots").set(auth).send({ name: "sabotaje-secreto" });
    const loadout = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "packages", "module-catalog", "examples", "loadout-medium-gunner.json"), "utf8"),
    );
    await request(app).post(`/bots/${bot.body.id}/loadouts`).set(auth).send(loadout);
    const version = await request(app)
      .post(`/bots/${bot.body.id}/versions`)
      .set(auth)
      .field("runtime", "python")
      .field("loadoutRevision", "1")
      .attach("source", Buffer.from(JSON.stringify({ files: pySecretFiles() })), "package.json");
    const submit = await request(app)
      .post(`/bots/${bot.body.id}/versions/${version.body.version}/actions/submit`)
      .set(auth);
    expect(submit.status).toBe(202);
    expect(submit.body.status).toBe("failed");
    const v = await h.db("bot_versions").where({ bot_id: bot.body.id, version: version.body.version }).first();
    expect(v.state).toBe("rejected");
  });

  it("sabotaje 3 (mapa de la batalla): un mapa saboteado en BD no se convierte en arena jugable", async () => {
    // El saboteador vacía las capas del mapa publicado (copia local, la BD no se toca).
    const mapRow = await h.db("map_versions").where({ map_id: "mvp-arena-01", version: 1 }).first();
    const doc = JSON.parse(typeof mapRow.content === "string" ? mapRow.content : JSON.stringify(mapRow.content));
    delete doc.layers;
    expect(() => toEngineMap(doc)).toThrow();
  });

  it("sabotaje 4 (espectador): tickets falsificados o reutilizados no abren el canal", async () => {
    const gateway = new SpectateGateway({ port: 0 });
    const fakeBattle = { snapshots: [], publicEvents: [], isFinished: () => false, getResult: () => null };
    gateway.attachBattle(battleId, fakeBattle, { pollIntervalMs: 5 });

    const closeCode = (ticket: string) =>
      new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/spectate/${battleId}?ticket=${encodeURIComponent(ticket)}`);
        ws.on("close", (code) => resolve(code));
        ws.on("error", () => {/* el close llega igualmente */});
        setTimeout(() => reject(new Error("sin cierre")), 5000);
      });

    try {
      // Ticket FIRMADO CON OTRA CLAVE (falsificación): rechazado.
      const forged = jwt.sign({ kind: "spectate", battleId, jti: "x" }, "clave-del-saboteador", { expiresIn: 60 });
      expect(await closeCode(forged)).toBe(4401);

      // Ticket legítimo REUTILIZADO (robado del historial): la 2ª conexión no entra.
      const ticketRes = await request(app).post(`/battles/${battleId}/spectate-ticket`);
      expect(ticketRes.status).toBe(201);
      const first = new WebSocket(`ws://127.0.0.1:${gateway.port}/spectate/${battleId}?ticket=${encodeURIComponent(ticketRes.body.ticket)}`);
      await new Promise<void>((resolve, reject) => {
        first.on("open", () => resolve());
        first.on("error", reject);
      });
      expect(await closeCode(ticketRes.body.ticket)).toBe(4403);
      first.close();
    } finally {
      gateway.close();
    }
  });

  it("sabotaje 5 (replay): un replay manipulado byte a byte o un resultado oficial falso NO verifican", async () => {
    // 5a · bytes alterados en disco: checksum_mismatch, sin re-simular.
    const tampered = Buffer.from(readFileSync(stored.path));
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    const tPath = join(dir, "tampered.replay");
    writeFileSync(tPath, tampered);
    const tamperedId = await insertFinishedBattle({ replay_ref: tPath, replay_hash: stored.index.sha256 });
    const r1 = await request(app).post(`/replays/${tamperedId}/verify`);
    expect(r1.status).toBe(200);
    expect(r1.body.matches).toBe(false);
    expect(r1.body.reason).toBe("checksum_mismatch");

    // 5b · resultado oficial falseado en la BD: el archivo no lo respalda.
    const fakedId = await insertFinishedBattle({
      replay_ref: stored.path,
      replay_hash: stored.index.sha256,
      final_state_hash: "f".repeat(64),
    });
    const r2 = await request(app).post(`/replays/${fakedId}/verify`);
    expect(r2.body.matches).toBe(false);
    expect(r2.body.reason).toBe("final_state_hash_mismatch_with_db");
  }, 120_000);

  it("sabotaje 6 (estadísticas): sin replay archivado no se fabrican stats", async () => {
    // El saboteador borra el archivo del almacén: el job de stats NO inventa datos.
    const dir2 = mkdtempSync(join(tmpdir(), "e12-sabotage-stats-"));
    const stored2 = ingestReplay(dir2, replay, { official: true });
    rmSync(stored2.path);
    const ghostId = await insertFinishedBattle({ replay_ref: stored2.path });
    await expect(runStatsJob(h.db, dir2, ghostId, "e12_sabotage_dm")).rejects.toThrow(/replay_not_found|No se puede procesar/);
    // Y la API sigue sin stats para esa batalla (no hay filas fantasma).
    const res = await request(app).get(`/battles/${ghostId}/stats`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.perBot)).toEqual([]);
  });
});
