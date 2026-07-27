/**
 * B7 · Arranque REAL del replay-service sobre un volumen recién creado.
 *
 * Esto no prueba cadenas ni configuración: lanza el ENTRYPOINT DE VERDAD del
 * servicio (`apps/replay-service/src/main.ts`, el mismo que fija SERVICE_ENTRY
 * en el Compose) como proceso aparte, apuntando a un directorio de datos vacío
 * — el equivalente a un despliegue desde cero — y comprueba por HTTP que un
 * replay real del motor:
 *   1. entra por POST /replays/:id,
 *   2. QUEDA ESCRITO EN DISCO en ese directorio,
 *   3. se vuelve a leer por GET /replays/:id byte a byte.
 *
 * Y el caso que estuvo diez días roto en VM108: con el directorio de datos NO
 * escribible, el servicio debe NEGARSE A ARRANCAR (exit 1 + diagnóstico), en
 * vez de quedarse "healthy" tragándose cada ingesta con EACCES.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, toJsonl, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");
// tsx es el mismo cargador que usa la imagen (`npx tsx "$SERVICE_ENTRY"`). Se
// localiza con la resolución de módulos de Node en vez de con una ruta fija a
// `node_modules/` del repo: en un worktree el árbol de dependencias real está
// en un ancestro, y `node_modules/.bin/tsx` puede no existir aunque el paquete
// sí. Si no está, el test falla (no se omite).
const TSX = (() => {
  try {
    return join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "cli.mjs");
  } catch {
    return undefined;
  }
})();
const MAIN = join(REPO, "apps", "replay-service", "src", "main.ts");

let replay: Replay;
let jsonl: string;
const vivos: ChildProcessWithoutNullStreams[] = [];

beforeAll(async () => {
  expect(process.getuid?.(), "esta suite debe correr SIN privilegios de root").not.toBe(0);
  expect(TSX, "no se encuentra el cargador tsx: ¿npm ci?").toBeDefined();
  expect(existsSync(TSX as string), `no existe ${TSX}`).toBe(true);
  await initPhysics();
  replay = await record(
    {
      battleId: "bat_b7_bootstrap",
      seed: "b7_bootstrap",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 120 }),
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
  jsonl = toJsonl(replay);
});

afterEach(() => {
  for (const p of vivos.splice(0)) p.kill("SIGKILL");
});

async function puertoLibre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

interface Arranque {
  proc: ChildProcessWithoutNullStreams;
  salida: string;
  /** Código de salida si el proceso ya terminó; null si sigue vivo. */
  code: number | null;
  port: number;
}

/**
 * Lanza el servicio real y espera a que (a) diga que escucha, o (b) muera.
 * No hay terceros caminos: eso es justamente lo que se está probando.
 */
async function arrancar(replaysDir: string, ingestSecret: string | undefined = INGEST_SECRET): Promise<Arranque> {
  const port = await puertoLibre();
  const proc = spawn(process.execPath, [TSX as string, MAIN], {
    cwd: REPO,
    env: {
      ...process.env,
      REPLAYS_DIR: replaysDir,
      PORT: String(port),
      // B8 · la ingesta es una ruta autenticada. Se pasa el secreto por entorno,
      // que es EXACTAMENTE como lo recibe el contenedor real (docker-compose:
      // REPLAY_INGEST_SECRET_FILE / REPLAY_INGEST_SECRET).
      ...(ingestSecret === undefined ? {} : { REPLAY_INGEST_SECRET: ingestSecret }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  vivos.push(proc);

  let salida = "";
  proc.stdout.on("data", (b: Buffer) => (salida += b.toString()));
  proc.stderr.on("data", (b: Buffer) => (salida += b.toString()));

  const code = await new Promise<number | null>((resolve) => {
    const limite = setTimeout(() => resolve(null), 30_000);
    proc.once("exit", (c) => {
      clearTimeout(limite);
      resolve(c);
    });
    const tic = setInterval(() => {
      if (salida.includes("escuchando")) {
        clearInterval(tic);
        clearTimeout(limite);
        resolve(null);
      }
    }, 100);
    proc.once("exit", () => clearInterval(tic));
  });

  return { proc, salida, code, port };
}

/** B8 · secreto de ingesta con el que se arranca el servicio real en estos tests. */
const INGEST_SECRET = "secreto-ingesta-bootstrap";

describe("B7 · despliegue desde cero: el replay se escribe y se lee de verdad", () => {
  it(
    "sobre un directorio de datos VACÍO, el servicio arranca e ingesta y devuelve un replay real",
    { timeout: 120_000 },
    async () => {
      // "Desde cero": el directorio ni siquiera existe todavía, como un volumen
      // recién creado por `docker volume create`.
      const dir = join(mkdtempSync(join(tmpdir(), "b7-boot-")), "replays");
      expect(existsSync(dir)).toBe(false);

      const s = await arrancar(dir);
      expect(s.code, `el servicio murió al arrancar:\n${s.salida}`).toBeNull();
      expect(existsSync(dir), "el servicio debe crear su directorio de datos").toBe(true);

      const base = `http://127.0.0.1:${s.port}`;
      const post = await fetch(`${base}/replays/${replay.header.battleId}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson", "x-replay-ingest-auth": INGEST_SECRET },
        body: jsonl,
      });
      expect(post.status, await post.clone().text()).toBe(201);
      const meta = (await post.json()) as { sha256: string; path: string };

      // (2) El replay está DE VERDAD en el disco, en ese directorio.
      const enDisco = readdirSync(dir).sort();
      expect(enDisco).toEqual([`${replay.header.battleId}.replay`, `${replay.header.battleId}.replay.json`]);
      expect(meta.path).toBe(join(dir, `${replay.header.battleId}.replay`));

      // (3) Y se vuelve a leer por HTTP, byte a byte, con su hash intacto.
      const get = await fetch(`${base}/replays/${replay.header.battleId}`);
      expect(get.status).toBe(200);
      const bytes = Buffer.from(await get.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(0);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(meta.sha256);
      expect(get.headers.get("x-replay-sha256")).toBe(meta.sha256);
    },
  );

  it(
    "con el directorio de datos NO escribible (el caso VM108) el servicio se niega a arrancar",
    { timeout: 120_000 },
    async () => {
      const base = mkdtempSync(join(tmpdir(), "b7-boot-ro-"));
      const dir = join(base, "replays");
      mkdirSync(dir);
      chmodSync(dir, 0o555);

      const s = await arrancar(dir);

      // Muere, y muere con código de error: en Docker eso es un contenedor en
      // bucle de reinicio, VISIBLE. Antes de B7 arrancaba y se quedaba "healthy".
      expect(s.code, `el servicio NO debía arrancar sobre un volumen no escribible:\n${s.salida}`).toBe(1);
      expect(s.salida).not.toMatch(/escuchando/);

      // Y el diagnóstico es accionable, no un stack trace.
      const linea = s.salida
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("{") && l.includes('"level":"error"'));
      expect(linea, `sin línea de diagnóstico en:\n${s.salida}`).toBeDefined();
      const log = JSON.parse(linea as string);
      expect(log.service).toBe("replay-service");
      expect(log.dir).toBe(dir);
      expect(String(log.reason)).toMatch(/EACCES|permission denied/i);
      expect(String(log.remedy)).toMatch(/ARENA_DATA_DIRS/);

      // Nada escrito, y el puerto no quedó escuchando.
      expect(readdirSync(dir)).toEqual([]);
      await expect(fetch(`http://127.0.0.1:${s.port}/healthz`)).rejects.toThrow();
    },
  );
});

/**
 * B8 · Fail-closed comprobado sobre el PROCESO REAL, no sobre la app en memoria.
 *
 * `ingest-auth.test.ts` prueba `createReplayServer()` con supertest. Esto es un
 * escalón más arriba y más cerca del contenedor: arranca `src/main.ts` como
 * proceso (el mismo `SERVICE_ENTRY` que fija el Compose), sin
 * `REPLAY_INGEST_SECRET` en el entorno — el despiste realista del operador — y
 * comprueba por HTTP de verdad que:
 *   - el servicio SÍ arranca y SÍ sirve lecturas (el visor no se queda a oscuras), y
 *   - la ingesta se rechaza con 401 y NO escribe nada en el disco.
 *
 * Esto es lo que cubre el cableado `main.ts` → `resolveIngestSecretFromEnv` →
 * `createReplayServer({ internalSecret })`, que ningún test de la app en memoria
 * puede tocar.
 */
describe("B8 · el servicio REAL sin secreto configurado: lee pero no deja escribir", () => {
  it("arranca, sirve lecturas y rechaza la ingesta con 401 sin escribir nada", { timeout: 120_000 }, async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "b8-boot-")), "replays");
    const s = await arrancar(dir, undefined);
    expect(s.code, `el servicio no debe morir por no tener secreto:\n${s.salida}`).toBeNull();

    const base = `http://127.0.0.1:${s.port}`;

    // (1) Las lecturas siguen vivas: el visor no depende de la credencial.
    const healthz = await fetch(`${base}/healthz`);
    expect(healthz.status).toBe(200);
    const lista = await fetch(`${base}/replays`);
    expect(lista.status).toBe(200);

    // (2) La ingesta se rechaza con CUALQUIER credencial (no hay modo abierto).
    for (const cred of [undefined, "", "lo-que-sea"]) {
      const post = await fetch(`${base}/replays/${replay.header.battleId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          ...(cred === undefined ? {} : { "x-replay-ingest-auth": cred }),
        },
        body: jsonl,
      });
      expect(post.status, `credencial ${JSON.stringify(cred)}`).toBe(401);
    }

    // (3) El barrido de retención tampoco.
    const sweep = await fetch(`${base}/retention/sweep`, { method: "POST" });
    expect(sweep.status).toBe(401);

    // (4) EFECTO observable: el directorio de datos sigue VACÍO.
    expect(readdirSync(dir)).toEqual([]);
  });
});
