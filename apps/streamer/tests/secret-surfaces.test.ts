/**
 * EQ5b · §3 bloqueante `STREAM_KEY_ARGV_VISIBLE=NO` — regresión PERMANENTE.
 *
 * El defecto (auditoría EQ5, 2026-11-02, medido contra la imagen real): la clave
 * RTMPS viajaba en el argv de FFmpeg (`rtmps://…/live2/<clave>`), así que
 * `ps`, `docker top` y `/proc/<pid>/cmdline` de CUALQUIER usuario del host la
 * enseñaban.
 *
 * Estas pruebas no miran cadenas del código: LANZAN el servicio real
 * (apps/streamer/src/main.ts, el SERVICE_ENTRY de la imagen) con binarios
 * falsos pero REALES de ffmpeg/chromium y recorren `/proc` de todo el árbol de
 * procesos buscando la clave en `cmdline` y `environ`, igual que haría un
 * atacante con `ps`. Calibración: con el diseño anterior (clave en el argv de
 * ffmpeg) la prueba de proceso se pone ROJA; con el relé RTMP en el propio
 * streamer, VERDE.
 *
 * La clave se genera aleatoria en cada ejecución, se escribe en un fichero 0600
 * y nunca se imprime (los mensajes de fallo dicen DÓNDE aparece, no cuál es).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFfmpegArgs } from "../src/ffmpeg.js";
import { DEFAULT_CONFIG, type StreamerConfig } from "../src/config.js";
import { killTree, spawnService } from "../../../packages/test-process/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");
const TSX = join(REPO, "node_modules", ".bin", "tsx");
const MAIN = join(REPO, "apps", "streamer", "src", "main.ts");

const vivos: ChildProcessWithoutNullStreams[] = [];
const servidores: Server[] = [];
afterEach(async () => {
  await Promise.all(vivos.splice(0).map((p) => killTree(p)));
  await Promise.all(servidores.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function claveAleatoria(): string {
  return `s9test-${randomBytes(12).toString("hex")}`;
}

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

/** Ingesta falsa: acepta TCP y guarda los bytes (no habla RTMP; aquí no hace falta). */
async function ingestaMuda(): Promise<{ port: number; bytes: () => Buffer }> {
  const trozos: Buffer[] = [];
  const sockets: Socket[] = [];
  const server = createServer((s) => {
    sockets.push(s);
    s.on("data", (b: Buffer) => trozos.push(b));
    s.on("error", () => {});
  });
  servidores.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origClose = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const s of sockets) s.destroy();
    return origClose(cb);
  }) as typeof server.close;
  return { port: (server.address() as { port: number }).port, bytes: () => Buffer.concat(trozos) };
}

function binariosFalsos(): { ffmpeg: string; chromium: string } {
  const bin = mkdtempSync(join(tmpdir(), "eq5b-bin-"));
  const ffmpeg = join(bin, "ffmpeg-falso");
  // Se queda vivo como el ffmpeg real emitiendo; si le dan un fd 3 (salida FLV
  // del relé) escribe una cabecera FLV válida y nada más.
  writeFileSync(
    ffmpeg,
    ["#!/bin/sh", "printf 'FLV\\001\\005\\000\\000\\000\\011\\000\\000\\000\\000' >&3 2>/dev/null", "sleep 30", ""].join(
      "\n",
    ),
  );
  chmodSync(ffmpeg, 0o755);
  const chromium = join(bin, "chromium-falso");
  writeFileSync(chromium, "#!/bin/sh\nsleep 30\n");
  chmodSync(chromium, 0o755);
  return { ffmpeg, chromium };
}

/** PIDs del árbol de `root` (incluido), leyendo `/proc/<pid>/stat` (ppid = campo 4). */
function arbol(root: number): number[] {
  const padre = new Map<number, number>();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const tras = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      padre.set(Number(d), Number(tras[1]));
    } catch {
      /* proceso que ya no existe */
    }
  }
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    for (const [pid, ppid] of padre) if (ppid === out[i] && !out.includes(pid)) out.push(pid);
  }
  return out;
}

function leer(path: string): string {
  try {
    return readFileSync(path).toString("latin1");
  } catch {
    return "";
  }
}

/** Superficies de `/proc` (las que ve `ps`) de todo el árbol donde aparece la clave. */
function fugasEnProc(root: number, clave: string): string[] {
  const fugas: string[] = [];
  for (const pid of arbol(root)) {
    const cmd = leer(`/proc/${pid}/cmdline`);
    const nombre = cmd.split("\0")[0].split("/").pop() || String(pid);
    if (cmd.includes(clave)) fugas.push(`cmdline de ${nombre}`);
    if (leer(`/proc/${pid}/environ`).includes(clave)) fugas.push(`environ de ${nombre}`);
  }
  return fugas;
}

async function esperar(cond: () => boolean, ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

async function arrancar(env: Record<string, string>) {
  const port = await puertoLibre();
  const proc = spawnService(process.execPath, [TSX, MAIN], {
    cwd: REPO,
    env: { ...process.env, STREAMER_CONTROL_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  vivos.push(proc);
  let salida = "";
  proc.stdout.on("data", (b: Buffer) => (salida += b.toString()));
  proc.stderr.on("data", (b: Buffer) => (salida += b.toString()));
  const ok = await esperar(() => salida.includes("API de control escuchando") || proc.exitCode !== null, 30_000);
  expect(ok && proc.exitCode === null, `el streamer no arrancó:\n${salida.slice(0, 2000)}`).toBe(true);
  return { proc, port, salida: () => salida };
}

const cfg = (over: Partial<StreamerConfig> = {}): StreamerConfig => ({ ...DEFAULT_CONFIG, ...over });

describe("EQ5b §3 · la clave de emisión NO está en el argv de ffmpeg", () => {
  it("ningún argumento del plan de ffmpeg (rtmps) contiene la clave", () => {
    const clave = claveAleatoria();
    // `as never`: con el diseño anterior la clave era el 2.º parámetro; con el
    // nuevo ffmpeg ni la recibe. La prueba vale para los dos.
    const plan = buildFfmpegArgs(cfg({ mode: "rtmps" }), clave as never);
    const conClave = plan.args.filter((a) => a.includes(clave)).length;
    expect(conClave, "argumentos de ffmpeg que contienen la clave").toBe(0);
  });

  it(
    "proceso REAL: la clave no aparece en cmdline ni environ de ningún proceso del árbol",
    { timeout: 120_000 },
    async () => {
      const clave = claveAleatoria();
      const dir = mkdtempSync(join(tmpdir(), "eq5b-key-"));
      const fichero = join(dir, "stream_key");
      writeFileSync(fichero, `${clave}\n`, { mode: 0o600 });
      const ingesta = await ingestaMuda();
      const { ffmpeg, chromium } = binariosFalsos();
      const s = await arrancar({
        STREAM_MODE: "rtmps",
        STREAM_KEY_FILE: fichero,
        RTMPS_URL: `rtmp://127.0.0.1:${ingesta.port}/live2`,
        STREAMER_ALLOW_PLAIN_RTMP: "1",
        FFMPEG_BIN: ffmpeg,
        CHROMIUM_BIN: chromium,
      });
      const start = await fetch(`http://127.0.0.1:${s.port}/control/start`, { method: "POST" });
      expect(start.status).toBe(200);

      // Espera a que ffmpeg (falso) esté vivo: sin él la prueba sería vacía.
      const conFfmpeg = await esperar(() =>
        arbol(s.proc.pid!).some((pid) => leer(`/proc/${pid}/cmdline`).includes("ffmpeg-falso")),
      );
      expect(conFfmpeg, "ffmpeg no llegó a lanzarse: la prueba no mediría nada").toBe(true);

      expect(fugasEnProc(s.proc.pid!, clave), "superficies de /proc donde aparece la clave").toEqual([]);

      // Logs y API de control tampoco.
      for (const path of ["/status", "/metrics", "/healthz", "/version"]) {
        const text = await (await fetch(`http://127.0.0.1:${s.port}${path}`)).text();
        expect(text.includes(clave), `${path} contiene la clave`).toBe(false);
      }
      expect(s.salida().includes(clave), "los logs contienen la clave").toBe(false);
      expect(existsSync(fichero)).toBe(true);
    },
  );
});
