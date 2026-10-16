/**
 * DEV-B · B8 · E2E REAL: una batalla creada por la API la ejecuta el
 * tournament-worker con el CÓDIGO de dos bots, cada uno en su contenedor del
 * sandbox, y el resultado + las estadísticas demuestran que se ejecutó SU código.
 *
 * Piezas REALES de punta a punta (ningún stub de servicio de S9):
 *   API (POST /battles, propiedad, alta transaccional) → jobs.run_battle →
 *   TournamentWorker (reserva atómica + lease) → engine-executor (mapa, ruleset,
 *   loadout reales de la BD) → containerAgents → ProxyContainerRunner →
 *   s9-docker-proxy (createDockerProxyServer, misma política que producción) →
 *   Docker ROOTLESS de la máquina de pruebas → contenedores con el runtime Python
 *   FIJADO en runtimes/DIGESTS.lock + el source guardado en bot_versions.source →
 *   protocolo arena/1 contra el ProtocolServer del worker → motor → finishBattle
 *   (resultado, outcome, replay, cpu_ms) → runStatsJob (stats re-simuladas).
 *
 * Los dos bots tienen comportamiento DISTINTO y reconocible:
 *   - «Artillero» navega por waypoints y DISPARA a todo contacto de radar.
 *   - «Pacifista» se queda quieto y NUNCA envía `fire`.
 * Con HunterBot (el stub antiguo) los dos dispararían: el test se pone ROJO.
 *
 * Imagen por versión: `FROM <runtime python@digest>` + main.py (el source de la
 * BD), publicada en un registry local efímero para tener REPO DIGEST (el proxy
 * sólo acepta `@sha256:`). Es el proveedor `registryImageProvider`; el de
 * producción (artefacto firmado servido al runtime) es el de DEV-A.
 *
 * Opt-in: S9_RUN_REAL_DOCKER_E2E=1 (necesita Docker). Variables opcionales:
 *   S9_E2E_DOCKER_SOCKET (def. /run/user/<uid>/docker.sock),
 *   S9_E2E_ENGINE_HOST   (IP de este host alcanzable desde los contenedores; def. autodetección),
 *   S9_E2E_REGISTRY_PORT (def. 5057).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import type { Express } from "express";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { DEFAULT_RULESET_ID, DEV_USERS, seedDev } from "../../api/src/db/seeds/dev.js";
import { tokenFor } from "../../api/src/testing/helpers.js";
import { createApp } from "../../api/src/app.js";
import {
  DEFAULT_POLICY,
  ProxyContainerRunner,
  createDockerProxyServer,
  createSocketBackend,
} from "../../bot-manager/src/docker-proxy.js";
import { TournamentWorker } from "./worker.js";
import { makeDefaultHandlers } from "./engine-executor.js";
import { containerAgents } from "./container-agents.js";
import { registryImageProvider } from "./testing/registry-image-provider.js";

const run = promisify(execFile);
const ENABLED = process.env.S9_RUN_REAL_DOCKER_E2E === "1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");

const ARTILLERO = `from arena_sdk import ArenaBot, angle_diff, angle_to
import os

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


Artillero(bot_id=os.environ.get("BOT_ID", "bot_0")).run(os.environ["WS_URL"], os.environ["BATTLE_TOKEN"])
`;

const PACIFISTA = `from arena_sdk import ArenaBot
import os


class Pacifista(ArenaBot):
    """Se queda quieto. NUNCA dispara."""

    def on_observation(self, observation):
        return {"move": {"throttle": 0.0, "steer": 0.0}}


Pacifista(bot_id=os.environ.get("BOT_ID", "bot_1")).run(os.environ["WS_URL"], os.environ["BATTLE_TOKEN"])
`;

/** Loadout con RADAR (el de ejemplo lleva lidar, que no ve vehículos). */
const RADAR_MODULES = [
  { slot: "drive", moduleId: "movement.tracks@1" },
  { slot: "power", moduleId: "power.battery@1" },
  { slot: "sensor_a", moduleId: "sensor.radar@1" },
  { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
  { slot: "armor_front", moduleId: "armor.steel_front@1" },
];

function pythonRuntimeDigest(): string {
  const lock = readFileSync(join(REPO, "runtimes", "DIGESTS.lock"), "utf8");
  const line = lock.split("\n").find((l) => l.startsWith("python "));
  if (!line) throw new Error("runtimes/DIGESTS.lock sin entrada python");
  return line.trim().split(/\s+/)[2];
}

function engineHost(): string {
  if (process.env.S9_E2E_ENGINE_HOST) return process.env.S9_E2E_ENGINE_HOST;
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/^(docker|br-|veth|tailscale|lo)/.test(name)) continue;
    const v4 = (addrs ?? []).find((a) => a.family === "IPv4" && !a.internal);
    if (v4) return v4.address;
  }
  throw new Error("no se encontró una IPv4 de este host alcanzable desde los contenedores (S9_E2E_ENGINE_HOST)");
}

const docker = (...args: string[]) => run("docker", args, { maxBuffer: 16 * 1024 * 1024 });

let h: TestDbHandle;
let app: Express;
let proxy: Server;
let proxyUrl: string;
const myBattles: string[] = [];
const REG_PORT = Number(process.env.S9_E2E_REGISTRY_PORT ?? 5057);
const REG_NAME = "s9fcb-e2e-registry";
const images = new Map<string, string>();
let owner: { id: string };
let artillero: string;
let pacifista: string;
const proxyDecisions: { allowed: boolean; path: string }[] = [];

async function insertBot(name: string, source: string): Promise<string> {
  const [bot] = await h.db("bots").insert({ name, owner_id: owner.id, visibility: "private" }).returning("id");
  const catalogVersion = (await h.db("catalog_versions").orderBy("imported_at", "desc").first()).catalog_version;
  await h.db("bot_loadouts").insert({
    bot_id: bot.id,
    revision: 1,
    name: `${name}-radar`,
    catalog_version: catalogVersion,
    chassis: "chassis.medium@1",
    modules: JSON.stringify(RADAR_MODULES),
  });
  await h.db("bot_versions").insert({
    bot_id: bot.id,
    version: 1,
    state: "published",
    runtime: "python",
    loadout_revision: 1,
    source: Buffer.from(source, "utf8"),
    source_filename: "main.py",
  });
  return bot.id as string;
}

/** Construye la imagen DE ESA VERSIÓN desde el source que hay EN LA BD (no desde la constante). */
async function buildVersionImage(botId: string, version: number): Promise<string> {
  const v = await h.db("bot_versions").where({ bot_id: botId, version }).first();
  const dir = mkdtempSync(join(tmpdir(), "s9fcb-img-"));
  writeFileSync(join(dir, "main.py"), Buffer.from(v.source));
  writeFileSync(
    join(dir, "Dockerfile"),
    `FROM ${pythonRuntimeDigest()}\nCOPY --chown=10001:10001 main.py /bot/main.py\n`,
  );
  const tag = `127.0.0.1:${REG_PORT}/s9fcb-bot-${botId.slice(0, 8)}:v${version}`;
  await docker("build", "-q", "-t", tag, dir);
  await docker("push", "-q", tag);
  const { stdout } = await docker("inspect", "--format", "{{index .RepoDigests 0}}", tag);
  return stdout.trim();
}

describe.skipIf(!ENABLED)("B8 · batalla REAL con el código de dos bots en contenedores", () => {
  beforeAll(async () => {
    h = await startTestDb();
    await seedDev(h.db);
    app = createApp({ db: h.db, anonQuota: { max: 10_000, windowMs: 3600_000 } });
    owner = await h.db("users").where({ email: DEV_USERS.user }).first();

    // Red de los bots: compliance exige el nombre literal "arena". En la máquina
    // de pruebas NO es internal (los contenedores tienen que llegar a la IP de
    // este host, donde escucha el ProtocolServer del worker). En producción es
    // internal y el worker está dentro de ella.
    const nets = (await docker("network", "ls", "--format", "{{.Name}}")).stdout.split("\n");
    if (!nets.includes("arena")) await docker("network", "create", "arena").catch(() => undefined);
    await docker("rm", "-f", REG_NAME).catch(() => undefined);
    await docker("run", "-d", "--restart", "no", "-p", `127.0.0.1:${REG_PORT}:5000`, "--name", REG_NAME, "registry:2");
    await new Promise((r) => setTimeout(r, 1500));

    artillero = await insertBot("artillero", ARTILLERO);
    pacifista = await insertBot("pacifista", PACIFISTA);
    images.set(`${artillero}@1`, await buildVersionImage(artillero, 1));
    images.set(`${pacifista}@1`, await buildVersionImage(pacifista, 1));

    const socketPath = process.env.S9_E2E_DOCKER_SOCKET ?? `/run/user/${process.getuid?.()}/docker.sock`;
    proxy = createDockerProxyServer({
      backend: createSocketBackend(socketPath),
      policy: DEFAULT_POLICY,
      onDecision: (d) => proxyDecisions.push({ allowed: d.allowed, path: d.path }),
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  }, 600_000);

  afterAll(async () => {
    proxy?.close();
    await docker("rm", "-f", REG_NAME).catch(() => undefined);
    // Los contenedores de bots los PARA el runner (el proxy no expone DELETE): se
    // retiran aquí SÓLO los de las batallas de este test (otros procesos de la
    // máquina pueden tener los suyos). La red `arena` NO se borra aunque la hayamos
    // creado: es compartida con otros arneses de la misma máquina.
    for (const bid of myBattles) {
      const { stdout } = await docker("ps", "-aq", "--filter", `name=${bid}`).catch(() => ({ stdout: "" }));
      for (const id of stdout.split("\n").filter(Boolean)) await docker("rm", "-f", id).catch(() => undefined);
    }
    await h?.stop();
  }, 120_000);

  it("la API agenda, el worker ejecuta EL CÓDIGO de cada bot y lo demuestran el resultado y las stats", async () => {
    // La red puede haberla retirado otro arnés de la máquina entre beforeAll y aquí.
    await docker("network", "inspect", "arena").catch(() => docker("network", "create", "arena"));
    const token = await tokenFor(h.db, DEV_USERS.user);
    const created = await request(app)
      .post("/battles")
      .set("Authorization", `Bearer ${token}`)
      .send({
        mode: "deathmatch",
        rulesetId: DEFAULT_RULESET_ID,
        mapId: "mvp-arena-01",
        seed: "fc-b-e2e",
        participants: [
          { botId: artillero, version: 1, team: "red" },
          { botId: pacifista, version: 1, team: "blue" },
        ],
      });
    expect(created.status).toBe(202);
    const battleId = created.body.id as string;
    myBattles.push(battleId);

    const replaysDir = mkdtempSync(join(tmpdir(), "s9fcb-replays-"));
    const wired = await makeDefaultHandlers({
      db: h.db,
      replaysDir,
      rulesetOverrides: { timeLimitTicks: 2400, scoreToWin: 1 },
      agents: containerAgents({
        runner: new ProxyContainerRunner(proxyUrl),
        provider: registryImageProvider(images),
        network: "arena",
        engineHost: engineHost(),
        tickIntervalMs: 12,
        connectTimeoutMs: 60_000,
      }),
    });
    const worker = new TournamentWorker({
      db: h.db,
      workerId: "fc-b-e2e",
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
    expect(battle.replay_ref).toMatch(new RegExp(`${battleId}\\.replay$`));
    expect(battle.started_at).toBeTruthy();
    expect(battle.finished_at).toBeTruthy();

    // El sandbox de verdad: el proxy aceptó create/start y nada se coló.
    expect(proxyDecisions.some((d) => d.allowed && d.path.startsWith("/containers/create"))).toBe(true);

    const parts = await h.db("participants").where({ battle_id: battleId });
    const pA = parts.find((p: any) => p.bot_id === artillero);
    const pP = parts.find((p: any) => p.bot_id === pacifista);
    // CPU real del cgroup de cada contenedor (antes null siempre en este camino).
    expect(Number(pA.cpu_ms)).toBeGreaterThan(0);
    expect(Number(pP.cpu_ms)).toBeGreaterThan(0);

    const statsRes = await request(app).get(`/battles/${battleId}/stats`);
    expect(statsRes.status).toBe(200);
    const sA = statsRes.body.perBot[artillero];
    const sP = statsRes.body.perBot[pacifista];
    // EL CÓDIGO SE EJECUTÓ: el Pacifista jamás intentó disparar; el Artillero sí.
    const triesA = sA.perModule.turret_main.uses + sA.perModule.turret_main.rejections;
    const triesP = sP.perModule.turret_main.uses + sP.perModule.turret_main.rejections;
    expect(triesP).toBe(0);
    expect(sP.shotsFired).toBe(0);
    expect(triesA).toBeGreaterThan(0);
    expect(sA.shotsFired).toBeGreaterThan(0);
    expect(sP.damageDealt).toBe(0);
    expect(sA.cpuMs).toBeGreaterThan(0);
    // Ganador coherente: el Pacifista no puede ganar por puntos (nunca hace daño).
    expect(pP.outcome).not.toBe("win");
    expect(["win", "draw"]).toContain(pA.outcome);

    // El replay archivado re-simula bit a bit (sin los bots: con sus comandos grabados).
    const verify = await request(app).post(`/replays/${battleId}/verify`);
    expect(verify.status).toBe(200);
    expect(verify.body.matches).toBe(true);

    // La API expone el BATTLE_RESULT completo.
    const got = await request(app).get(`/battles/${battleId}`);
    expect(got.body.result.agents).toBe("container");
    expect(got.body.finishedAt).toBeTruthy();
    expect(got.body.replayAvailable).toBe(true);

    // Un segundo POST /run sobre la batalla terminada no vuelve a ejecutar nada.
    const rerun = await request(app).post(`/battles/${battleId}/run`).set("Authorization", `Bearer ${token}`);
    expect(rerun.status).toBe(409);
    const evidence = JSON.stringify({
        e2e: "fc-b",
        battleId,
        result: battle.result,
        outcomes: { artillero: pA.outcome, pacifista: pP.outcome },
        cpuMs: { artillero: Number(pA.cpu_ms), pacifista: Number(pP.cpu_ms) },
        shots: { artillero: sA.shotsFired, pacifista: sP.shotsFired },
        tries: { artillero: triesA, pacifista: triesP },
        damage: { artillero: sA.damageDealt, pacifista: sP.damageDealt },
        kills: { artillero: sA.kills, pacifista: sP.kills },
    });
    // Evidencia legible para el informe (fuera del repo).
    if (process.env.S9_E2E_EVIDENCE) writeFileSync(process.env.S9_E2E_EVIDENCE, evidence + "\n");
  }, 600_000);
});
