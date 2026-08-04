/**
 * B13 · Arranque REAL del streamer contra su directorio de grabación.
 *
 * No se prueban cadenas ni configuración: se LANZA el entrypoint de verdad
 * (apps/streamer/src/main.ts, el mismo SERVICE_ENTRY que fija la imagen) como
 * proceso aparte y se observa su comportamiento contra un directorio real.
 *
 * El defecto que cierra (mismo patrón que dejó `arena_replays` vacío diez días
 * en VM108, comprobado en producción el 2026-07-27): en modo `record` quien
 * escribe el .mp4 es FFmpeg, no Node. Si el volumen no es escribible, ffmpeg
 * muere al abrir el fichero, el supervisor reintenta... y GET /healthz sigue
 * respondiendo 200 porque no toca el disco. El servicio parece sano y no graba
 * nada. Aquí se reproduce ese comportamiento y se comprueba que, con el
 * preflight, el proceso se NIEGA a arrancar.
 *
 * FFmpeg y Chromium no existen en este entorno: se sustituyen por binarios de
 * verdad (scripts ejecutables) que hacen lo mínimo que hace el real —escribir
 * el fichero de salida que le pasan— para poder comprobar que el vídeo acaba
 * DENTRO del directorio que el preflight validó.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFfmpegArgs } from "../src/ffmpeg.js";
import { loadConfig } from "../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");
const TSX = join(REPO, "node_modules", ".bin", "tsx");
const MAIN = join(REPO, "apps", "streamer", "src", "main.ts");

const vivos: ChildProcessWithoutNullStreams[] = [];
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

function dirEscribible(): string {
  return mkdtempSync(join(tmpdir(), "b13-record-"));
}

/** Directorio REAL sin permiso de escritura: el caso VM108. */
function dirNoEscribible(): string {
  const base = mkdtempSync(join(tmpdir(), "b13-record-ro-"));
  const dir = join(base, "video");
  mkdirSync(dir);
  chmodSync(dir, 0o555);
  return dir;
}

/** Binarios falsos pero REALES (ejecutables) para ffmpeg y chromium. */
function binariosFalsos(): { ffmpeg: string; chromium: string } {
  const bin = mkdtempSync(join(tmpdir(), "b13-bin-"));
  const ffmpeg = join(bin, "ffmpeg-falso");
  // Escribe en el ÚLTIMO argumento (es donde ffmpeg.ts pone el fichero de
  // salida en modo record) y se queda vivo, como el ffmpeg real emitiendo.
  writeFileSync(
    ffmpeg,
    ["#!/bin/sh", 'for a in "$@"; do salida=$a; done', 'printf video-falso > "$salida" || exit 1', "sleep 20", ""].join(
      "\n",
    ),
  );
  chmodSync(ffmpeg, 0o755);
  const chromium = join(bin, "chromium-falso");
  writeFileSync(chromium, "#!/bin/sh\nsleep 20\n");
  chmodSync(chromium, 0o755);
  return { ffmpeg, chromium };
}

interface Arranque {
  proc: ChildProcessWithoutNullStreams;
  salida: () => string;
  code: number | null;
  port: number;
}

/** Lanza el servicio real y espera a que escuche o muera. No hay tercer camino. */
async function arrancar(env: Record<string, string>): Promise<Arranque> {
  const port = await puertoLibre();
  const proc = spawn(process.execPath, [TSX, MAIN], {
    cwd: REPO,
    env: { ...process.env, STREAMER_CONTROL_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  vivos.push(proc);

  let buffer = "";
  proc.stdout.on("data", (b: Buffer) => (buffer += b.toString()));
  proc.stderr.on("data", (b: Buffer) => (buffer += b.toString()));

  const code = await new Promise<number | null>((resolve) => {
    const limite = setTimeout(() => resolve(null), 30_000);
    const tic = setInterval(() => {
      if (buffer.includes("API de control escuchando")) {
        clearInterval(tic);
        clearTimeout(limite);
        resolve(null);
      }
    }, 100);
    proc.once("exit", (c) => {
      clearInterval(tic);
      clearTimeout(limite);
      resolve(c);
    });
  });

  return { proc, salida: () => buffer, code, port };
}

async function esperar(cond: () => boolean, ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

describe("B13 · el fallo silencioso del modo grabación es real", () => {
  it("sobre un directorio no escribible, escribir el .mp4 revienta con EACCES", () => {
    const dir = dirNoEscribible();
    const cfg = loadConfig({ STREAM_MODE: "record", RECORD_DIR: dir });
    const plan = buildFfmpegArgs(cfg, null);
    const salida = plan.args[plan.args.length - 1];
    expect(salida.startsWith(`${dir}/`), `ffmpeg escribiría en ${salida}`).toBe(true);
    // Esto es exactamente lo que le pasa a ffmpeg dentro del contenedor.
    expect(() => writeFileSync(salida, "video")).toThrow(/EACCES|permission denied/i);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("B13 · preflight del directorio de grabación (modo record)", () => {
  it(
    "con el directorio NO escribible, el streamer se niega a arrancar y lo explica",
    { timeout: 120_000 },
    async () => {
      const dir = dirNoEscribible();
      const s = await arrancar({ STREAM_MODE: "record", RECORD_DIR: dir });

      // Muere con código 1: en Docker eso es un bucle de reinicio VISIBLE, no un
      // contenedor "healthy" que no graba nada.
      expect(s.code, `el streamer NO debía arrancar sobre un directorio no escribible:\n${s.salida()}`).toBe(1);
      expect(s.salida()).not.toMatch(/API de control escuchando/);

      const linea = s
        .salida()
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("{") && l.includes('"level":"error"'));
      expect(linea, `sin diagnóstico accionable en:\n${s.salida()}`).toBeDefined();
      const log = JSON.parse(linea as string);
      expect(log.service).toBe("streamer");
      expect(log.dir).toBe(dir);
      expect(String(log.reason)).toMatch(/EACCES|permission denied/i);
      expect(String(log.remedy)).toMatch(/ARENA_DATA_DIRS/);

      // Y no dejó el puerto de control escuchando: nadie puede creerlo sano.
      await expect(fetch(`http://127.0.0.1:${s.port}/healthz`)).rejects.toThrow();
    },
  );

  it(
    "con el directorio escribible arranca, y lo que graba acaba DE VERDAD dentro de él",
    { timeout: 120_000 },
    async () => {
      const dir = dirEscribible();
      const { ffmpeg, chromium } = binariosFalsos();
      const s = await arrancar({
        STREAM_MODE: "record",
        RECORD_DIR: dir,
        FFMPEG_BIN: ffmpeg,
        CHROMIUM_BIN: chromium,
      });
      expect(s.code, `el streamer murió al arrancar:\n${s.salida()}`).toBeNull();

      // Sano por HTTP...
      const health = await fetch(`http://127.0.0.1:${s.port}/healthz`);
      expect(health.status).toBe(200);

      // ...y, al grabar de verdad, el fichero aparece EN ESE directorio.
      const start = await fetch(`http://127.0.0.1:${s.port}/control/start`, { method: "POST" });
      expect(start.status).toBe(200);
      const apareció = await esperar(() => readdirSync(dir).some((f) => f.endsWith(".mp4")));
      expect(apareció, `no se grabó nada en ${dir}: ${readdirSync(dir).join(", ")}`).toBe(true);
      const fichero = readdirSync(dir).find((f) => f.endsWith(".mp4"))!;
      expect(readFileSync(join(dir, fichero), "utf8")).toBe("video-falso");

      const status = await (await fetch(`http://127.0.0.1:${s.port}/status`)).json();
      expect(status.target, "el destino declarado y el directorio comprobado son el mismo").toBe(dir);
    },
  );

  it("crea el directorio de grabación si no existe (volumen recién creado)", { timeout: 120_000 }, async () => {
    const dir = join(dirEscribible(), "video");
    expect(existsSync(dir)).toBe(false);
    const { ffmpeg, chromium } = binariosFalsos();
    const s = await arrancar({ STREAM_MODE: "record", RECORD_DIR: dir, FFMPEG_BIN: ffmpeg, CHROMIUM_BIN: chromium });
    expect(s.code, s.salida()).toBeNull();
    expect(existsSync(dir), "el servicio debe dejar utilizable su directorio de datos").toBe(true);
  });

  it(
    "en modo rtmps NO se exige el directorio de grabación (el preflight está acotado)",
    { timeout: 120_000 },
    async () => {
      // No-vacuidad del alcance: el mismo directorio imposible que tumba el modo
      // record no debe impedir emitir, porque emitiendo no se escribe en disco.
      const clave = join(dirEscribible(), "stream_key");
      writeFileSync(clave, "clave-de-prueba\n");
      const s = await arrancar({
        STREAM_MODE: "rtmps",
        RECORD_DIR: dirNoEscribible(),
        STREAM_KEY_FILE: clave,
      });
      expect(s.code, `el modo rtmps no debía morir por el directorio de grabación:\n${s.salida()}`).toBeNull();
      expect((await fetch(`http://127.0.0.1:${s.port}/healthz`)).status).toBe(200);
      expect(s.salida(), "la clave jamás sale por los logs").not.toContain("clave-de-prueba");
    },
  );
});
