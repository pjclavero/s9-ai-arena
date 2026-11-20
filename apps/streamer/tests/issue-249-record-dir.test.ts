/**
 * #249 · «Sólo grabar» desde la web con un streamer que ARRANCÓ en modo rtmps.
 *
 * Defecto: `/data/replays/video` sólo lo creaba el preflight de arranque en modo
 * record. Con STREAM_MODE=rtmps el directorio no existía, `statfs` fallaba,
 * /recordings devolvía `disk: null` y la API respondía `disk_unknown` (sin grabar).
 *
 * Aquí se arranca la API de control del streamer en modo rtmps sobre un volumen
 * VACÍO (un directorio temporal sin `video/`) y se comprueba:
 *  - CLEAN_START_RECORD_DIR_CREATED: /recordings crea el directorio, sin privilegios;
 *  - RECORD_DISK_MEASUREMENT_WORKS: el disco se mide (freeBytes > 0);
 *  - RECORD_START_WORKS: una orden de grabar (modo web) lanza ffmpeg con el MP4
 *    DENTRO de ese directorio;
 *  - RECREATE_CONTAINER_STILL_WORKS: con el volumen otra vez vacío y un proceso
 *    nuevo, se repite y funciona;
 *  - BAD_VOLUME_FAILS_CLOSED: si el directorio no se puede crear ni escribir, el
 *    disco queda SIN medir (con el motivo) y la orden de grabar se rechaza (409).
 * La prueba con la IMAGEN real (contenedor limpio, ffprobe del MP4, recrear y
 * volumen malo) está en tests/streaming-e2e/issue-249.sh.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createControlServer } from "../src/control.js";
import { StreamSupervisor, type SpawnedProcess } from "../src/supervisor.js";
import { createLogger, DEFAULT_CONFIG, SecretRegistry } from "../src/config.js";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdio = [null, null, null, null] as unknown as ArrayLike<unknown>;
  kill() {
    return true;
  }
}

/** Un «contenedor»: supervisor + API de control con STREAM_MODE=rtmps y RECORD_DIR dado. */
async function container(recordDir: string) {
  const spawned: { cmd: string; args: string[] }[] = [];
  const secrets = new SecretRegistry();
  const logger = createLogger(secrets, () => {});
  const config = { ...DEFAULT_CONFIG, mode: "rtmps" as const, recordDir, retryDelayMs: 5 };
  const sup = new StreamSupervisor({
    config,
    spawner: (cmd, args) => {
      spawned.push({ cmd, args });
      return new FakeChild();
    },
    logger,
    secrets,
  });
  const server = createControlServer({
    supervisor: sup,
    config,
    logger,
    capabilities: { nvenc: false },
    controlSecret: "s3cr3t",
    readPrivateKey: () => null,
    readLegacyKey: () => null,
  });
  servers.push(server as unknown as Server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = { "content-type": "application/json", "x-streamer-auth": "s3cr3t" };
  return {
    sup,
    spawned,
    recordings: async () => (await (await fetch(`${base}/recordings`, { headers: h })).json()) as Record<string, any>,
    startRecord: (sessionId: string) =>
      fetch(`${base}/control/start`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ sessionId, mode: "record" }),
      }),
  };
}

function emptyVolume(): string {
  const vol = mkdtempSync(join(tmpdir(), "s9-249-vol-"));
  dirs.push(vol);
  return vol;
}

describe("#249 · modo record desde la web con el contenedor arrancado en rtmps", () => {
  it("CLEAN_START_RECORD_DIR_CREATED + RECORD_DISK_MEASUREMENT_WORKS + RECORD_START_WORKS", async () => {
    const vol = emptyVolume();
    const recordDir = join(vol, "video");
    expect(existsSync(recordDir)).toBe(false);
    const c = await container(recordDir);
    const rec = await c.recordings();
    expect(existsSync(recordDir)).toBe(true);
    expect(rec.dirError).toBeNull();
    expect(rec.disk.freeBytes).toBeGreaterThan(0);
    const r = await c.startRecord("rec-1");
    expect(r.status).toBe(200);
    const ff = c.spawned.find((s) => s.cmd.includes("ffmpeg"))!;
    expect(ff.args.at(-1)!.startsWith(`${recordDir}/broadcast-`)).toBe(true);
    expect(ff.args.at(-1)!.endsWith(".mp4")).toBe(true);
    c.sup.stop();
  });

  it("RECREATE_CONTAINER_STILL_WORKS · volumen vacío otra vez y proceso nuevo: vuelve a funcionar", async () => {
    const vol = emptyVolume();
    const recordDir = join(vol, "video");
    const first = await container(recordDir);
    expect((await first.recordings()).disk).not.toBeNull();
    first.sup.stop();
    rmSync(recordDir, { recursive: true, force: true }); // el volumen se recrea vacío
    const second = await container(recordDir);
    expect((await second.recordings()).disk.freeBytes).toBeGreaterThan(0);
    expect((await second.startRecord("rec-2")).status).toBe(200);
    second.sup.stop();
  });

  it("BAD_VOLUME_FAILS_CLOSED · directorio imposible: disco sin medir (con motivo) y la orden de grabar ⇒ 409", async () => {
    const vol = emptyVolume();
    const notADir = join(vol, "fichero");
    writeFileSync(notADir, "no soy un directorio");
    const c = await container(join(notADir, "video")); // ENOTDIR también como root
    const rec = await c.recordings();
    expect(rec.disk).toBeNull();
    expect(String(rec.dirError)).toMatch(/no se pudo crear/);
    const r = await c.startRecord("rec-3");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("record_dir_unavailable");
    expect(c.spawned).toEqual([]); // ni Chromium ni ffmpeg
  });
});
