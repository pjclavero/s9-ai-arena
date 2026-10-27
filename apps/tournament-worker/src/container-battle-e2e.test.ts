/**
 * DEV-B · B8 + REVIEW (cierre funcional, R4.1) · E2E REAL A+B integrado: el
 * código que un usuario sube por la API se BUILDEA en el sandbox real de DEV-A,
 * se publica con su artefacto FIRMADO, y una batalla creada por la API la
 * ejecuta el tournament-worker de DEV-B lanzando ESE artefacto (createBattleLaunchHost),
 * no una imagen construida al vuelo.
 *
 * Piezas REALES de punta a punta (ningún stub de servicio de S9):
 *   API (POST /bots, /loadouts, /versions multipart, submit, publish) → jobs.bot_build
 *   → build worker (createBuildExecutor, mismo cableado que build-worker-main) →
 *   ContainerBuildSandbox → s9-docker-proxy → Docker ROOTLESS local → artefacto
 *   `arena-artifact/v1` firmado → published;
 *   API (POST /battles, checkBattleContent, propiedad) → jobs.run_battle →
 *   TournamentWorker (reserva atómica + lease) → engine-executor → containerAgents →
 *   artifactLaunchProvider (resolveBotLaunch: estado, artefacto de SU build, sha256,
 *   firma ed25519) → SandboxHost sirve el artefacto → bootstrap del runtime python
 *   FIJADO en runtimes/DIGESTS.lock lo descarga, verifica y ejecuta → protocolo
 *   arena/1 → motor → finishBattle (resultado, outcome, replay, cpu_ms) → stats.
 *
 * Los dos bots tienen comportamiento DISTINTO y reconocible:
 *   - «Artillero» navega por waypoints y DISPARA a todo contacto de radar.
 *   - «Pacifista» se queda quieto y NUNCA envía `fire`.
 * Con HunterBot (el stub antiguo) los dos dispararían: el test se pone ROJO.
 *
 * Opt-in: S9_RUN_REAL_DOCKER_E2E=1 (necesita Docker). Variables opcionales:
 *   DOCKER_HOST/DOCKER_SOCKET (socket; def. el rootless del usuario),
 *   S9_SANDBOX_ADVERTISE_HOST (IP de este host alcanzable desde los contenedores).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { DEFAULT_RULESET_ID, DEV_USERS, seedDev } from "../../api/src/db/seeds/dev.js";
import { tokenFor } from "../../api/src/testing/helpers.js";
import { createApp } from "../../api/src/app.js";
import { battleCodeProvenance } from "../../api/src/services/bot-provenance.js";
import { ProxyContainerRunner } from "../../bot-manager/src/docker-proxy.js";
import { runBuildWorkerOnce } from "../../bot-manager/src/build-worker.js";
import { createBuildExecutor } from "../../bot-manager/src/build-worker-wiring.js";
import { generateServiceKeypair } from "../../bot-manager/src/signing.js";
import { loadRuntimeImages } from "../../bot-manager/src/bot-launch.js";
import {
  leftoverBotContainers,
  startDockerSandboxEnv,
  type DockerSandboxEnv,
} from "../../bot-manager/tests/docker-sandbox-env.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { TournamentWorker } from "./worker.js";
import { makeDefaultHandlers } from "./engine-executor.js";
import { containerAgents } from "./container-agents.js";
import { artifactLaunchProvider } from "./bot-launch-provider.js";

const ENABLED = process.env.S9_RUN_REAL_DOCKER_E2E === "1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");

/** Lo que un usuario pegaría en la web: una subclase de ArenaBot (el bootstrap la instancia). */
export const ARTILLERO = `from arena_sdk import ArenaBot, angle_diff, angle_to

WAYPOINTS = [(30.0, 64.0), (88.0, 64.0), (100.0, 40.0)]


class Artillero(ArenaBot):
    """Navega por waypoints rodeando el muro central y DISPARA a todo contacto."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.wp = 0

    def on_observation(self, observation):
        me = observation["self"]
        pos = me["position"]
        contacts = [c for r in observation.get("sensors", {}).get("radar", []) for c in r.get("contacts", [])]
        enemies = [c for c in contacts if not c.get("team")]
        if enemies:
            t = min(enemies, key=lambda c: (c["position"]["x"] - pos["x"]) ** 2 + (c["position"]["y"] - pos["y"]) ** 2)
            turn = angle_diff(me["heading"], angle_to(pos, t["position"]))
            return {
                "move": {"throttle": 0.3, "steer": max(-1.0, min(1.0, turn * 1.5))},
                "turret": {"targetPoint": t["position"]},
                "fire": ["turret_main"],
            }
        tx, ty = WAYPOINTS[min(self.wp, len(WAYPOINTS) - 1)]
        if (tx - pos["x"]) ** 2 + (ty - pos["y"]) ** 2 < 16 and self.wp < len(WAYPOINTS) - 1:
            self.wp += 1
        turn = angle_diff(me["heading"], angle_to(pos, {"x": tx, "y": ty}))
        return {"move": {"throttle": 0.9 if abs(turn) < 1.0 else 0.3, "steer": max(-1.0, min(1.0, turn * 2.0))}}
`;

export const PACIFISTA = `from arena_sdk import ArenaBot


class Pacifista(ArenaBot):
    """Se queda quieto. NUNCA dispara."""

    def on_observation(self, observation):
        return {"move": {"throttle": 0.0, "steer": 0.0}}
`;

/**
 * Loadout con RADAR (el de ejemplo lleva lidar, que no ve vehículos), VALIDADO por
 * la API. REVIEW: el E2E de B insertaba por SQL tracks+radar+cannon con batería
 * (8.5 EU/s de consumo pasivo con 8 EU/s de generación), que la API rechaza con
 * 422 energy_deficit; aquí se usan ruedas (1.5 EU/s) para que el loadout sea legal.
 */
function radarLoadout() {
  const base = JSON.parse(
    readFileSync(join(REPO, "packages", "module-catalog", "examples", "loadout-medium-gunner.json"), "utf8"),
  );
  base.modules = base.modules.map((m: { slot: string; moduleId: string }) =>
    m.slot === "sensor_a"
      ? { ...m, moduleId: "sensor.radar@1" }
      : m.slot === "drive"
        ? { ...m, moduleId: "movement.wheels@1" }
        : m,
  );
  return base;
}

let h: TestDbHandle;
let app: Express;
let env: DockerSandboxEnv;
let devTok: string;
const signer = generateServiceKeypair();
const hdr = () => ({ Authorization: `Bearer ${devTok}` });
let artillero: { botId: string; version: number };
let pacifista: { botId: string; version: number };

/** Crea el bot POR LA API, buildea en el sandbox REAL y publica. Nada de UPDATE manual. */
async function publishBotFromCode(name: string, code: string) {
  const bot = await request(app).post("/bots").set(hdr()).send({ name });
  expect(bot.status, JSON.stringify(bot.body)).toBe(201);
  const ld = await request(app).post(`/bots/${bot.body.id}/loadouts`).set(hdr()).send(radarLoadout());
  expect(ld.status, JSON.stringify(ld.body)).toBe(201);
  const v = await request(app)
    .post(`/bots/${bot.body.id}/versions`)
    .set(hdr())
    .field("runtime", "python")
    .field("loadoutRevision", String(ld.body.revision ?? 1))
    .attach("source", Buffer.from(code), "bot.py");
  expect(v.status, JSON.stringify(v.body)).toBe(201);
  const submit = await request(app).post(`/bots/${bot.body.id}/versions/${v.body.version}/actions/submit`).set(hdr());
  expect(submit.status).toBe(202);
  const { executor, sandbox } = createBuildExecutor(h.db, signer, {
    DOCKER_PROXY_URL: env.proxyUrl,
    BUILD_SANDBOX_HOST: env.advertiseHost,
    ARENA_NETWORK: "arena",
  });
  expect(sandbox).not.toBeNull();
  expect((await runBuildWorkerOnce(h.db, executor, { workerId: "fc-rev-e2e-build" })).outcome).toBe("done");
  const build = await request(app).get(`/builds/${submit.body.id}`).set(hdr());
  expect(build.body.status, JSON.stringify(build.body.stages)).toBe("passed");
  const pub = await request(app)
    .post(`/bots/${bot.body.id}/versions/${v.body.version}/actions/publish`)
    .set(hdr())
    .send({});
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  expect(pub.body.state).toBe("published");
  return { botId: bot.body.id as string, version: v.body.version as number };
}

describe.skipIf(!ENABLED)("B8+A · batalla REAL con el ARTEFACTO FIRMADO de dos bots buildeados de verdad", () => {
  beforeAll(async () => {
    await initPhysics();
    h = await startTestDb();
    await seedDev(h.db);
    app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
    devTok = await tokenFor(h.db, DEV_USERS.developer);
    env = await startDockerSandboxEnv();
    artillero = await publishBotFromCode("fcrev-artillero", ARTILLERO);
    pacifista = await publishBotFromCode("fcrev-pacifista", PACIFISTA);
  }, 600_000);

  afterAll(async () => {
    await env?.stop();
    await h?.stop();
  }, 120_000);

  it("la API agenda, el worker lanza EL ARTEFACTO FIRMADO de cada versión y lo demuestran resultado y stats", async () => {
    const created = await request(app)
      .post("/battles")
      .set(hdr())
      .send({
        mode: "deathmatch",
        rulesetId: DEFAULT_RULESET_ID,
        mapId: "mvp-arena-02",
        seed: "fc-rev-e2e",
        participants: [
          { botId: artillero.botId, version: artillero.version, team: "red" },
          { botId: pacifista.botId, version: pacifista.version, team: "blue" },
        ],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const battleId = created.body.id as string;

    const replaysDir = mkdtempSync(join(tmpdir(), "fcrev-replays-"));
    const decisionsBefore = env.decisions.length;
    const wired = await makeDefaultHandlers({
      db: h.db,
      replaysDir,
      rulesetOverrides: { timeLimitTicks: 2400, scoreToWin: 1 },
      agents: containerAgents({
        runner: new ProxyContainerRunner(env.proxyUrl),
        // Camino de PRODUCCIÓN (main.ts): verifica con la clave PÚBLICA del firmante.
        provider: artifactLaunchProvider(h.db, env.advertiseHost, { publicKey: signer.publicKey }),
        network: "arena",
        engineHost: env.advertiseHost,
        tickIntervalMs: 12,
        connectTimeoutMs: 60_000,
      }),
    });
    const worker = new TournamentWorker({
      db: h.db,
      workerId: "fc-rev-e2e",
      handlers: wired.handlers,
      onExhausted: (job, ctx) => wired.onExhausted(ctx.db, job),
    });
    await worker.drain(20);

    const battle = await h.db("battles").where({ id: battleId }).first();
    const jobs = await h.db("jobs").whereRaw("payload->>'battleId' = ?", [battleId]);
    expect(battle.status, `jobs: ${JSON.stringify(jobs.map((j: any) => [j.kind, j.status, j.last_error]))}`).toBe(
      "finished",
    );
    expect(battle.failure_kind).toBe("none");
    expect(battle.result.agents).toBe("container");
    expect(battle.result.schema).toBe("battle-result/v1");
    expect(battle.run_attempts).toBe(1);

    // Se lanzó la IMAGEN DE RUNTIME fijada (no una imagen por bot) con el bootstrap.
    const runtimePy = loadRuntimeImages().python;
    const creates = env.decisions
      .slice(decisionsBefore)
      .filter((d) => d.allowed && d.path.startsWith("/containers/create"));
    expect(creates.length).toBe(2);

    // Procedencia: cada participante jugó SU versión exacta, con el artefacto de SU build.
    const prov = await battleCodeProvenance(h.db, battleId);
    for (const p of prov) {
      const row = await h.db("bot_versions").where({ bot_id: p.botId, version: p.version }).first();
      expect(p.artifactHash).toBe(row.artifact_hash);
      expect(p.buildId).toBe(row.validated_build_id);
      expect(row.runtime).toBe("python");
    }
    expect(runtimePy).toMatch(/@sha256:[0-9a-f]{64}$/);

    const parts = await h.db("participants").where({ battle_id: battleId });
    const pA = parts.find((p: any) => p.bot_id === artillero.botId);
    const pP = parts.find((p: any) => p.bot_id === pacifista.botId);
    expect(Number(pA.cpu_ms)).toBeGreaterThan(0);
    expect(Number(pP.cpu_ms)).toBeGreaterThan(0);

    // UX-D (G-08 · TD-047) · stats y detalle siguen la política de lectura de la
    // batalla: bots privados ⇒ el anónimo recibe 404; su dueño, 200.
    expect((await request(app).get(`/battles/${battleId}/stats`)).status).toBe(404);
    const statsRes = await request(app).get(`/battles/${battleId}/stats`).set(hdr());
    expect(statsRes.status).toBe(200);
    const sA = statsRes.body.perBot[artillero.botId];
    const sP = statsRes.body.perBot[pacifista.botId];
    // EL CÓDIGO SE EJECUTÓ: el Pacifista jamás intentó disparar; el Artillero sí.
    const triesA = sA.perModule.turret_main.uses + sA.perModule.turret_main.rejections;
    const triesP = sP.perModule.turret_main.uses + sP.perModule.turret_main.rejections;
    expect(triesP).toBe(0);
    expect(sP.shotsFired).toBe(0);
    expect(triesA).toBeGreaterThan(0);
    expect(sA.shotsFired).toBeGreaterThan(0);
    expect(sP.damageDealt).toBe(0);
    expect(pP.outcome).not.toBe("win");
    expect(["win", "draw"]).toContain(pA.outcome);

    // PRC REVIEW (TD-004): verificar un replay revela su resultado ⇒ misma política
    // que la lectura. El anónimo recibe el 404 uniforme; el dueño de los bots, 200.
    const anonVerify = await request(app).post(`/replays/${battleId}/verify`);
    expect(anonVerify.status).toBe(404);
    const verify = await request(app).post(`/replays/${battleId}/verify`).set(hdr());
    expect(verify.status).toBe(200);
    expect(verify.body.matches).toBe(true);

    const got = await request(app).get(`/battles/${battleId}`).set(hdr());
    expect(got.body.result.agents).toBe("container");
    expect(got.body.replayAvailable).toBe(true);

    const rerun = await request(app).post(`/battles/${battleId}/run`).set(hdr());
    expect(rerun.status).toBe(409);

    if (process.env.S9_E2E_EVIDENCE) {
      writeFileSync(
        process.env.S9_E2E_EVIDENCE,
        JSON.stringify({
          e2e: "fc-review-a+b",
          battleId,
          result: battle.result,
          outcomes: { artillero: pA.outcome, pacifista: pP.outcome },
          cpuMs: { artillero: Number(pA.cpu_ms), pacifista: Number(pP.cpu_ms) },
          shots: { artillero: sA.shotsFired, pacifista: sP.shotsFired },
          tries: { artillero: triesA, pacifista: triesP },
          provenance: prov.map((p) => ({ version: p.version, artifactHash: p.artifactHash, buildId: p.buildId })),
        }) + "\n",
      );
    }
  }, 600_000);

  it("NEGATIVO · un artefacto manipulado en BD NO se lanza: la batalla falla como infraestructura", async () => {
    // Se clona la versión publicada del Pacifista en otra batalla y se corrompen los
    // bytes de SU artefacto por SQL (es el ataque, no un atajo de la prueba).
    const row = await h.db("bot_versions").where({ bot_id: pacifista.botId, version: pacifista.version }).first();
    const art = await h.db("artifacts").where({ build_id: row.validated_build_id }).first();
    const original = Buffer.from(art.bytes);
    const tampered = Buffer.concat([original, Buffer.from("\n# manipulado\n")]);
    await h.db("artifacts").where({ id: art.id }).update({ bytes: tampered });
    try {
      const created = await request(app)
        .post("/battles")
        .set(hdr())
        .send({
          mode: "deathmatch",
          rulesetId: DEFAULT_RULESET_ID,
          mapId: "mvp-arena-02",
          participants: [
            { botId: artillero.botId, version: artillero.version, team: "red" },
            { botId: pacifista.botId, version: pacifista.version, team: "blue" },
          ],
        });
      expect(created.status).toBe(202);
      const decisionsBefore = env.decisions.length;
      const wired = await makeDefaultHandlers({
        db: h.db,
        replaysDir: mkdtempSync(join(tmpdir(), "fcrev-replays-")),
        rulesetOverrides: { timeLimitTicks: 300, scoreToWin: 1 },
        agents: containerAgents({
          runner: new ProxyContainerRunner(env.proxyUrl),
          provider: artifactLaunchProvider(h.db, env.advertiseHost, { publicKey: signer.publicKey }),
          network: "arena",
          engineHost: env.advertiseHost,
          tickIntervalMs: 12,
          connectTimeoutMs: 20_000,
        }),
      });
      const worker = new TournamentWorker({
        db: h.db,
        workerId: "fc-rev-e2e-neg",
        handlers: wired.handlers,
        onExhausted: (job, ctx) => wired.onExhausted(ctx.db, job),
      });
      await worker.drain(20);
      const battle = await h.db("battles").where({ id: created.body.id }).first();
      expect(battle.status).not.toBe("finished");
      const jobs = await h.db("jobs").whereRaw("payload->>'battleId' = ?", [created.body.id]);
      expect(JSON.stringify(jobs.map((j: any) => j.last_error))).toMatch(/manipulado|firma/);
      // El bot manipulado nunca llegó a crearse como contenedor.
      const creates = env.decisions
        .slice(decisionsBefore)
        .filter((d) => d.allowed && d.path.startsWith("/containers/create"));
      expect(creates.length).toBeLessThan(2);
    } finally {
      // Restaura (la versión es inmutable, el artefacto no lo es: el test lo deja como estaba).
      await h.db("artifacts").where({ id: art.id }).update({ bytes: original });
    }
  }, 300_000);

  it("no quedan contenedores de bot", async () => {
    expect(await leftoverBotContainers(30_000)).toEqual([]);
  }, 60_000);
});
