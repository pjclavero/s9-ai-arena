/**
 * E12 · T12.1 — Suite E2E del criterio de éxito del MVP (dosier técnico 26.1).
 *
 * "El MVP funciona" como suite ejecutable de 6 pasos, cada uno con aserciones
 * propias y evidencia (ids, hashes, cifras) archivada en
 * tests/e2e/evidence/mvp-success.json (artefacto de CI).
 *
 * Composición del "staging" — HONESTIDAD sobre el entorno (sin docker/sudo ni
 * navegador, ver docs/entrega-E12.md):
 *  - En lugar del stack de Compose (T10.1), se compone EN PROCESO con las
 *    piezas REALES de cada equipo: API completa de E7 sobre PostgreSQL
 *    embebido (ADR-E7-002), pipeline de build REAL de E6
 *    (E6PipelineBotManager), motor REAL de E2 (Battle + replay T2.6), mapa MVP
 *    REAL de E4 desde la BD (map_versions → toEngineMap), catálogo REAL de E3,
 *    gateway de espectador REAL de E8 (WebSocket + ticket firmado por la API)
 *    y stats REALES de E8 (runStatsJob re-simulando el replay).
 *  - Los 4 bots de la batalla son los stubs deterministas del motor
 *    (HunterBot/FlagRunnerBot): la ejecución de código de usuario en
 *    contenedores es la parte de E6/T6.2 pendiente de entorno con Docker
 *    (igual que en las entregas de E6/E7/E9). Las etapas containerizadas del
 *    pipeline quedan `skipped`, y se afirma explícitamente que quedan así.
 *
 * Los 6 sabotajes deliberados (DoD) viven en mvp-sabotage.e2e.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import type { Express } from "express";
import { WebSocket } from "ws";

// --- piezas reales de los equipos (importadas, no reimplementadas) ----------
import { startTestDb, type TestDbHandle } from "../../apps/api/src/testing/test-db.js";
import { seedDev, DEFAULT_RULESET_ID } from "../../apps/api/src/db/seeds/dev.js";
import { createApp } from "../../apps/api/src/app.js";
import { E6PipelineBotManager } from "../../apps/api/src/services/e6-bot-manager.js";
import { getCatalog } from "../../apps/api/src/services/catalog.js";
import { SpectateGateway } from "../../apps/api/src/spectate/gateway.js";
import { goodCandidate, referenceAgent } from "../../apps/bot-manager/tests/fixtures.js";
import { pyGoodFiles } from "../../apps/bot-manager/tests/fixtures.js";
import { generateServiceKeypair, signArtifact } from "../../apps/bot-manager/src/signing.js";
import { loadRuleset } from "../../packages/game-rules/index.js";
import { CATALOG_VERSION } from "../../packages/module-catalog/loadCatalog.js";
import { resolveVehicle } from "../../packages/module-catalog/resolve/index.js";
import { ARCHETYPES } from "../../packages/module-catalog/resolve/archetypes.js";
import { initPhysics } from "../../apps/arena-engine/src/sim/physics.js";
import { Battle, type Participant } from "../../apps/arena-engine/src/sim/battle.js";
import { replayFromBattle, verify, type Replay } from "../../apps/arena-engine/src/replay.js";
import { HunterBot, FlagRunnerBot } from "../../apps/arena-engine/src/stubs.js";
import { toEngineMap } from "../../apps/map-service/src/to-engine-map.js";
import type { InternalMap } from "../../apps/map-service/src/types.js";
import { ingestReplay, type StoredReplay } from "../../apps/replay-service/src/store.js";
import { runStatsJob } from "../../apps/replay-service/src/stats.js";
import { createPublishedBot } from "../../apps/tournament-worker/src/testing/fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(__dirname, "evidence");

// ---------------------------------------------------------------- estado E2E
let h: TestDbHandle;
let app: Express;
let gateway: SpectateGateway;
let replaysDir: string;
const signer = generateServiceKeypair();

// Estado que fluye entre pasos (la gracia del E2E es que es UNA historia).
const state = {
  accessToken: "",
  userId: "",
  botId: "",
  botVersion: 0,
  artifactHash: "",
  battleDbId: "",
  battle: null as Battle | null,
  result: null as any,
  replay: null as Replay | null,
  stored: null as StoredReplay | null,
  spectatorMessages: [] as any[],
};

/** Evidencia acumulada por paso; se archiva como artefacto al terminar. */
const evidence: Record<string, unknown> = {
  suite: "T12.1 · criterio de éxito del MVP (26.1)",
  startedAt: new Date().toISOString(),
};

const REPLAY_BATTLE_ID = "e12_mvp_ctf_2v2";

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  // Sandbox EN PROCESO (T6.1), igual que apps/api/src/e6-integration.test.ts: sin
  // agentResolver el pipeline falla cerrado (R1.5) y ninguna versión llega a
  // validated, así que el paso 2 no podría ejercer el camino feliz. Que SIN
  // sandbox se rechaza lo cubren e6-integration ("SIN sandbox…") y pipeline.test.ts.
  app = createApp({
    db: h.db,
    botManager: new E6PipelineBotManager(h.db, { signer, agentResolver: () => goodCandidate, referenceAgent }),
    anonQuota: { max: 10_000, windowMs: 3600_000 },
  });
  gateway = new SpectateGateway({ port: 0 });
  replaysDir = mkdtempSync(join(tmpdir(), "e12-mvp-replays-"));
}, 180_000);

afterAll(async () => {
  gateway?.close();
  state.battle?.free();
  evidence.finishedAt = new Date().toISOString();
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, "mvp-success.json"), JSON.stringify(evidence, null, 2));
  await h?.stop();
});

describe("T12.1 · el MVP funciona (26.1), en 6 pasos con evidencia", () => {
  // ── Paso 1 · registro → bot → loadout del catálogo MVP → código ───────────
  it("paso 1: un usuario se registra, crea un bot, monta un loadout del catálogo MVP y sube código", async () => {
    const email = "jugadora-e12@example.com";
    const password = "una-clave-larga-de-verdad!";
    const reg = await request(app).post("/auth/register").send({ email, password, displayName: "Jugadora E12" });
    expect(reg.status).toBe(201);
    state.userId = reg.body.id;

    const login = await request(app).post("/auth/login").send({ email, password });
    expect(login.status).toBe(200);
    expect(login.body.accessToken).toBeTruthy();
    state.accessToken = login.body.accessToken;
    const auth = { Authorization: `Bearer ${state.accessToken}` };

    const bot = await request(app).post("/bots").set(auth).send({ name: "mvp-e2e-bot" });
    expect(bot.status).toBe(201);
    state.botId = bot.body.id;

    // Loadout REAL del catálogo MVP (ejemplo versionado de E3).
    const { readFileSync } = await import("node:fs");
    const loadout = JSON.parse(
      readFileSync(
        join(__dirname, "..", "..", "packages", "module-catalog", "examples", "loadout-medium-gunner.json"),
        "utf8",
      ),
    );
    const lo = await request(app).post(`/bots/${state.botId}/loadouts`).set(auth).send(loadout);
    expect(lo.status).toBe(201);

    // Sube el código de un bot de ejemplo (fixture "bueno" canónico de E6).
    const version = await request(app)
      .post(`/bots/${state.botId}/versions`)
      .set(auth)
      .field("runtime", "python")
      .field("loadoutRevision", "1")
      .attach("source", Buffer.from(JSON.stringify({ files: pyGoodFiles() })), "package.json");
    expect(version.status).toBe(201);
    state.botVersion = version.body.version;

    evidence.paso1 = { userId: state.userId, botId: state.botId, version: state.botVersion, loadout: loadout.chassis };
  });

  // ── Paso 2 · build y validación en aislamiento (pipeline E6) ──────────────
  it("paso 2: el sistema construye y valida el bot con el pipeline REAL de E6", async () => {
    const auth = { Authorization: `Bearer ${state.accessToken}` };
    const submit = await request(app)
      .post(`/bots/${state.botId}/versions/${state.botVersion}/actions/submit`)
      .set(auth);
    expect(submit.status).toBe(202);
    expect(submit.body.status).toBe("passed");

    const byName = Object.fromEntries(submit.body.stages.map((s: any) => [s.name, s.status]));
    for (const stage of ["structure", "static_analysis", "dependencies", "build", "secret_scan", "sign", "publish"]) {
      expect(byName[stage], stage).toBe("passed");
    }
    // Con el sandbox en proceso, las etapas que ejecutan el bot corren DE VERDAD.
    // Antes de R1.5 este test las esperaba `skipped` y aun así daba la versión por
    // validated: ese era justo el agujero ERR-SEC-03 (validar sin ejecutar nada).
    // Que sin sandbox NO se valida lo cubren e6-integration y pipeline.test.ts.
    for (const stage of ["protocol_test", "smoke_battle", "resource_limits"]) {
      expect(byName[stage], stage).toBe("passed");
    }

    const v = await h.db("bot_versions").where({ bot_id: state.botId, version: state.botVersion }).first();
    expect(v.state).toBe("validated");
    expect(v.artifact_hash).toMatch(/^[0-9a-f]{64}$/);
    state.artifactHash = v.artifact_hash;

    // Firma criptográfica REAL del servicio (E6/signing).
    const artifact = await h.db("artifacts").where({ hash: v.artifact_hash }).first();
    expect(artifact.signature).toBe(signArtifact(v.artifact_hash, signer.privateKey));

    evidence.paso2 = { artifactHash: state.artifactHash, stages: byName };
  });

  // ── Pasos 3 y 4 · batalla CTF 2v2 en el mapa MVP + espectador anónimo ─────
  it("pasos 3-4: CTF 2v2 con 4 bots en el mapa MVP (muros, zona de daño, destructibles) vista EN DIRECTO por un espectador anónimo", async () => {
    // Mapa MVP REAL desde la BD (como lo haría el worker de E9).
    const mapRow = await h.db("map_versions").where({ map_id: "mvp-arena-01", version: 1 }).first();
    expect(mapRow?.state).toBe("published");
    const mapDoc = (typeof mapRow.content === "string" ? JSON.parse(mapRow.content) : mapRow.content) as InternalMap;
    const doc = mapDoc as any;
    // El criterio 26.1 pide muros, zona de daño y destructibles: se COMPRUEBA, no se supone.
    expect(doc.layers.walls?.length ?? 0).toBeGreaterThan(0);
    expect(doc.layers.destructibles?.length ?? 0).toBeGreaterThan(0);
    expect(doc.layers.zones?.some((z: any) => z.zoneType === "damage")).toBe(true);
    expect(doc.layers.flags?.length).toBe(2); // CTF de verdad
    const arenaMap = toEngineMap(mapDoc);

    // Ruleset CTF con presupuesto del ruleset de BD (ADR-000: budget por ruleset).
    const rulesetRow = await h.db("rulesets").where({ id: DEFAULT_RULESET_ID }).first();
    const ruleset = loadRuleset("ctf_mvp@1", {
      budgetCredits: rulesetRow.budget_credits,
      timeLimitTicks: 900,
    });

    // 4 loadouts REALES del catálogo importado en BD (E3 vía E7).
    const catalog = await getCatalog(h.db, CATALOG_VERSION);
    expect(catalog.length).toBeGreaterThan(0);
    // Los otros 3 bots son bots publicados REALES de la BD (fixture de E9):
    // participants.bot_id es una FK uuid a bots.
    const rivals = await Promise.all([
      createPublishedBot(h.db, "mvp-e2e-red-runner"),
      createPublishedBot(h.db, "mvp-e2e-blue-hunter"),
      createPublishedBot(h.db, "mvp-e2e-blue-runner"),
    ]);
    const participants: Participant[] = [
      { id: "veh_1", botId: state.botId, team: "red", spec: resolveVehicle(ARCHETYPES.gunner, catalog) },
      { id: "veh_2", botId: rivals[0].botId, team: "red", spec: resolveVehicle(ARCHETYPES.scout, catalog) },
      { id: "veh_3", botId: rivals[1].botId, team: "blue", spec: resolveVehicle(ARCHETYPES.heavy, catalog) },
      { id: "veh_4", botId: rivals[2].botId, team: "blue", spec: resolveVehicle(ARCHETYPES.scout, catalog) },
    ];

    const battle = await Battle.create({
      battleId: REPLAY_BATTLE_ID,
      seed: "e12-mvp-e2e",
      ruleset,
      map: arenaMap,
      participants,
      recordReplay: true,
    });
    state.battle = battle;
    // Posiciones públicas de banderas del mapa MVP (para los FlagRunner).
    const flagPos = Object.fromEntries(doc.layers.flags.map((f: any) => [f.team, f.position]));
    battle.attachBot("veh_1", new HunterBot(state.botId));
    battle.attachBot("veh_2", new FlagRunnerBot(rivals[0].botId, flagPos.blue, flagPos.red));
    battle.attachBot("veh_3", new HunterBot(rivals[1].botId));
    battle.attachBot("veh_4", new FlagRunnerBot(rivals[2].botId, flagPos.red, flagPos.blue));

    // Fila de batalla en la BD ANTES de arrancar: el ticket de espectador es de la API.
    const [row] = await h
      .db("battles")
      .insert({
        status: "running",
        official: true,
        mode: "capture_the_flag",
        ruleset_id: DEFAULT_RULESET_ID,
        map_id: "mvp-arena-01",
        map_version: 1,
        seed: "e12-mvp-e2e",
      })
      .returning("*");
    state.battleDbId = row.id;
    await h
      .db("participants")
      .insert(participants.map((p) => ({ battle_id: row.id, bot_id: p.botId, version: 1, team: p.team })));

    // Espectador ANÓNIMO: ticket vía API pública (sin Authorization) + WS real de E8.
    const ticketRes = await request(app).post(`/battles/${state.battleDbId}/spectate-ticket`);
    expect(ticketRes.status).toBe(201);
    gateway.attachBattle(state.battleDbId, battle, {
      pollIntervalMs: 1,
      meta: { mode: "capture_the_flag", mapId: "mvp-arena-01" },
    });
    const ws = new WebSocket(
      `ws://127.0.0.1:${gateway.port}/spectate/${state.battleDbId}?ticket=${encodeURIComponent(ticketRes.body.ticket)}`,
    );
    ws.on("message", (data) => state.spectatorMessages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    // La batalla corre POR TICKS cediendo el bucle de eventos: el gateway bombea EN DIRECTO.
    let liveTicks = 0;
    while (!battle.isFinished() && liveTicks < 2000) {
      battle.step();
      liveTicks++;
      if (liveTicks % 25 === 0) await new Promise((r) => setTimeout(r, 2));
    }
    expect(battle.isFinished()).toBe(true);
    const result = battle.getResult()!;
    state.result = result;
    expect(result.finalStateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.ticks).toBeGreaterThan(0);

    // El espectador recibió el stream EN VIVO (init + snapshots) y el resultado.
    await new Promise((r) => setTimeout(r, 150)); // el pump entrega lo pendiente
    ws.close();
    const types = state.spectatorMessages.map((m) => m.type);
    expect(types[0]).toBe("init");
    expect(types.filter((t) => t === "snapshot").length).toBeGreaterThan(3);
    expect(types).toContain("result");
    // D8: canal de espectador SIN información privada ni capas debug (ticket anónimo).
    expect(types).not.toContain("debug");
    const raw = JSON.stringify(state.spectatorMessages);
    expect(raw).not.toContain("observation");
    expect(raw).not.toContain("privateEvents");
    const resultMsg = state.spectatorMessages.find((m) => m.type === "result");
    expect(resultMsg.result.finalStateHash).toBe(result.finalStateHash);

    evidence.paso3 = {
      battleDbId: state.battleDbId,
      seed: "e12-mvp-e2e",
      ticks: result.ticks,
      winner: result.winner,
      score: result.score,
      finalStateHash: result.finalStateHash,
      disqualified: result.disqualified,
    };
    evidence.paso4 = {
      spectatorAnonimo: true,
      mensajes: types.length,
      snapshots: types.filter((t) => t === "snapshot").length,
      eventos: types.filter((t) => t === "event").length,
    };
  }, 120_000);

  // ── Paso 5 · el replay se reproduce y coincide con el resultado ───────────
  it("paso 5: el replay ingerido por el replay-service verifica por la API pública y por re-simulación", async () => {
    const battle = state.battle!;
    state.replay = replayFromBattle(battle, state.result);
    battle.free();
    state.battle = null;

    // Ingesta REAL del replay-service (T8.1) + referencia en la BD (política 23.1).
    state.stored = ingestReplay(replaysDir, state.replay, { official: true });
    await h
      .db("battles")
      .where({ id: state.battleDbId })
      .update({
        status: "finished",
        replay_ref: state.stored.path,
        replay_hash: state.stored.index.sha256,
        final_state_hash: state.result.finalStateHash,
        engine_versions: JSON.stringify(state.replay.header.versions),
        result: JSON.stringify({ winner: state.result.winner, score: state.result.score, ticks: state.result.ticks }),
      });

    // Re-simulación directa con el motor (verify de E2): coincide tick a tick.
    const direct = await verify(state.replay);
    expect(direct.matches).toBe(true);
    expect(direct.divergedAtTick).toBeNull();

    // Y por la API pública, como visitante anónimo (operación verifyReplay de E8).
    const viaApi = await request(app).post(`/replays/${state.battleDbId}/verify`);
    expect(viaApi.status).toBe(200);
    expect(viaApi.body.matches).toBe(true);
    expect(viaApi.body.recomputedHash).toBe(state.result.finalStateHash);

    // El replay también se DESCARGA sin cuenta (23.1).
    const download = await request(app).get(`/replays/${state.battleDbId}`);
    expect(download.status).toBe(200);
    expect(download.body.length).toBeGreaterThan(0);

    evidence.paso5 = {
      replayPath: state.stored.path,
      replaySha256: state.stored.index.sha256,
      officialHash: viaApi.body.officialHash,
      recomputedHash: viaApi.body.recomputedHash,
      matches: viaApi.body.matches,
    };
  }, 120_000);

  // ── Paso 6 · estadísticas por bot, equipo y módulo ─────────────────────────
  it("paso 6: existen estadísticas por bot, por equipo y por módulo (pipeline T8.4 real)", async () => {
    const job = await runStatsJob(h.db, replaysDir, state.battleDbId, REPLAY_BATTLE_ID);
    expect(job.rowsWritten).toBe(4);

    // Por EQUIPO: el marcador de las stats coincide con el resultado oficial.
    for (const team of ["red", "blue"]) {
      expect(job.stats.perTeam[team]).toBeTruthy();
      expect(job.stats.perTeam[team].score).toBe(state.result.score[team] ?? 0);
    }

    // Por BOT y por MÓDULO, expuestas por la API pública (getBattleStats).
    const res = await request(app).get(`/battles/${state.battleDbId}/stats`);
    expect(res.status).toBe(200);
    const perBot = res.body.perBot;
    expect(Object.keys(perBot).length).toBe(4);
    const mine = perBot[state.botId];
    expect(mine).toBeTruthy();
    expect(mine.team).toBe("red");
    expect(typeof mine.survivedTicks).toBe("number");
    expect(mine.perModule && Object.keys(mine.perModule).length).toBeGreaterThan(0);
    const anyModule = Object.values(mine.perModule)[0] as any;
    expect(anyModule.moduleId).toBeTruthy();
    expect(anyModule.finalState).toBeTruthy();

    evidence.paso6 = {
      rowsWritten: job.rowsWritten,
      perTeam: job.stats.perTeam,
      botsConStats: Object.keys(perBot),
      modulosDelBot: Object.keys(mine.perModule),
    };
  }, 120_000);
});
