/**
 * EQ5b · API interna de control para Administración → Streaming:
 *  - secreto compartido `x-streamer-auth` (sin él: 401; /metrics y /healthz abiertos);
 *  - orden de arranque validada (SSRF de /broadcast, rangos, NVENC no confirmado,
 *    credencial sólo sellada) e idempotente por sessionId; sin `replace` ⇒ 409;
 *  - credencial sellada abierta en memoria (y nunca en /status ni en logs);
 *  - retención: sólo MP4 de ffmpeg, regulares, viejos, nunca el que se graba.
 */
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, DEFAULT_CONFIG, SecretRegistry, type StreamerConfig } from "./config.js";
import { createControlServer } from "./control.js";
import { StreamSupervisor, type SpawnedProcess, type Spawner } from "./supervisor.js";
import { applyRetention, listRecordings } from "./recordings.js";
import { sealSecret } from "../../../packages/stream-secrets/index.js";

const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const KEY = "clave-sellada-EQ5b-0001";
const SECRET = "secreto-de-control";
// El MISMO sobre en cada orden, como hace la API (lo lee de la BD; OAEP es aleatorio).
// EQ5c · atado a su destino (plataforma + ingesta), como lo sella la API.
const BIND = { platform: "custom", ingest: "rtmps://ingest.example/live2" };
const SEALED = sealSecret(KEY, PUB, BIND);

class FakeProcess extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  media = new PassThrough();
  stdio = [null, this.stdout, this.stderr, this.media];
  constructor(
    public cmd: string,
    public args: string[],
  ) {
    super();
  }
  kill() {
    return true;
  }
}

async function withServer(
  fn: (base: string, h: { sup: StreamSupervisor; lines: string[]; spawned: FakeProcess[] }) => Promise<void>,
  over: { nvenc?: boolean | null; recordDir?: string } = {},
) {
  const spawned: FakeProcess[] = [];
  const spawner: Spawner = (cmd, args) => {
    const p = new FakeProcess(cmd, args);
    spawned.push(p);
    return p;
  };
  const lines: string[] = [];
  const secrets = new SecretRegistry();
  const logger = createLogger(secrets, (l) => lines.push(l));
  const config: StreamerConfig = {
    ...DEFAULT_CONFIG,
    retryDelayMs: 1,
    recordDir: over.recordDir ?? DEFAULT_CONFIG.recordDir,
  };
  const sup = new StreamSupervisor({
    config,
    spawner,
    logger,
    secrets,
    sleep: async () => {},
    dial: () => new PassThrough(),
  });
  const server = createControlServer({
    supervisor: sup,
    config,
    logger,
    capabilities: { nvenc: over.nvenc ?? false },
    controlSecret: SECRET,
    readPrivateKey: () => PRIV,
    readLegacyKey: () => null,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, { sup, lines, spawned });
  } finally {
    sup.stop();
    await new Promise((r) => server.close(r));
  }
}
const H = { "x-streamer-auth": SECRET, "content-type": "application/json" };
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = H) =>
  fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const startBody = (over: Record<string, unknown> = {}) => ({
  sessionId: "s-1",
  broadcastUrl: "http://web:3000/broadcast?battle=b1&event=Copa",
  mode: "rtmps",
  encoder: "x264",
  preset: "1080p",
  fps: 30,
  videoBitrateKbps: 4500,
  ingestUrl: "rtmps://ingest.example/live2",
  platform: "custom",
  credential: SEALED,
  ...over,
});

describe("EQ5b · autenticación de la API interna", () => {
  it("sin x-streamer-auth: 401 en control y estado; /metrics y /healthz abiertos", async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/status`)).status).toBe(401);
      expect((await fetch(`${base}/status`, { headers: { "x-streamer-auth": "otro-secreto-xx" } })).status).toBe(401);
      expect((await post(base, "/control/start", startBody(), { "content-type": "application/json" })).status).toBe(
        401,
      );
      expect((await post(base, "/control/stop", {}, {})).status).toBe(401);
      expect((await fetch(`${base}/recordings`)).status).toBe(401);
      expect((await fetch(`${base}/metrics`)).status).toBe(200);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/status`, { headers: H })).status).toBe(200);
    });
  });
});

describe("EQ5b · orden de arranque", () => {
  it("validaciones: SSRF de /broadcast, rangos, NVENC no confirmado, credencial en claro, campos extra", async () => {
    await withServer(async (base) => {
      const bad = async (over: Record<string, unknown>) => (await post(base, "/control/start", startBody(over))).status;
      expect(await bad({ broadcastUrl: "http://evil.example/broadcast" })).toBe(400);
      expect(await bad({ broadcastUrl: "http://web:3000/admin" })).toBe(400);
      expect(await bad({ broadcastUrl: "file:///etc/passwd" })).toBe(400);
      expect(await bad({ fps: 25 })).toBe(400);
      expect(await bad({ videoBitrateKbps: 50000 })).toBe(400);
      expect(await bad({ preset: "4k" })).toBe(400);
      expect(await bad({ encoder: "nvenc" })).toBe(400);
      expect(await bad({ ingestUrl: "rtmp://ingest.example/live2" })).toBe(400);
      expect(await bad({ credential: KEY })).toBe(400); // la clave en claro no se admite
      expect(await bad({ streamKey: KEY })).toBe(400);
      expect(await bad({ credential: { ...sealSecret(KEY, PUB, BIND), kid: "0000000000000000" } })).toBe(409);
    });
  });

  it("arranca con la clave SELLADA, idempotente por sessionId, 409 sin replace; nada de la clave fuera", async () => {
    await withServer(async (base, { sup, lines, spawned }) => {
      const r = await post(base, "/control/start", startBody());
      expect(r.status).toBe(200);
      expect(sup.state).toBe("streaming");
      const ff = spawned.find((p) => p.cmd === "ffmpeg")!;
      expect(ff.args.join(" ")).not.toContain(KEY);
      expect(ff.args.slice(-3)).toEqual(["-f", "flv", "pipe:3"]);
      const n = spawned.length;
      const again = await post(base, "/control/start", startBody());
      expect(again.status).toBe(200);
      expect((await again.json()).alreadyActive).toBe(true);
      expect(spawned.length).toBe(n);
      expect((await post(base, "/control/start", startBody({ sessionId: "s-2" }))).status).toBe(409);
      const rep = await post(
        base,
        "/control/start",
        startBody({ sessionId: "s-2", replace: true, videoBitrateKbps: 3000 }),
      );
      expect(rep.status).toBe(200);
      expect(
        spawned
          .filter((p) => p.cmd === "ffmpeg")
          .at(-1)!
          .args.join(" "),
      ).toContain("-b:v 3000k");
      const status = await (await fetch(`${base}/status`, { headers: H })).text();
      expect(status).not.toContain(KEY);
      expect(JSON.parse(status).target).toBe("rtmps://ingest.example:443/live2/***");
      expect(lines.join("\n")).not.toContain(KEY);
      const stop = await post(base, "/control/stop", {});
      expect((await stop.json()).wasActive).toBe(true);
      expect((await (await post(base, "/control/stop", {})).json()).wasActive).toBe(false);
    });
  });

  it("sin credencial ni clave heredada: 409 (no emite sin clave)", async () => {
    await withServer(async (base, { sup }) => {
      const r = await post(base, "/control/start", startBody({ credential: null }));
      expect(r.status).toBe(409);
      expect(sup.state).toBe("idle");
    });
  });
});

describe("EQ5b · grabaciones y retención", () => {
  function dir() {
    const d = mkdtempSync(join(tmpdir(), "eq5b-rec-"));
    const v = join(d, "video");
    mkdirSync(v);
    const old = new Date("2026-09-01T00:00:00Z");
    const mk = (name: string, size: number, t = old) => {
      writeFileSync(join(v, name), Buffer.alloc(size));
      utimesSync(join(v, name), t, t);
    };
    mk("broadcast-2026-09-01T00-00-00-000Z.mp4", 100);
    mk("broadcast-2026-09-02T00-00-00-000Z.mp4", 200);
    mk("broadcast-2026-11-02T10-00-00-000Z.mp4", 300, new Date());
    mk("broadcast-2026-11-02T11-00-00-000Z.mp4", 400, old); // «en curso» (aunque sea viejo)
    mk("notas.txt", 10);
    mk("broadcast-falso.mp4", 10);
    writeFileSync(join(d, "viejo.replay"), "x");
    utimesSync(join(d, "viejo.replay"), old, old);
    symlinkSync(join(d, "viejo.replay"), join(v, "broadcast-2026-09-03T00-00-00-000Z.mp4"));
    return { d, v, current: join(v, "broadcast-2026-11-02T11-00-00-000Z.mp4") };
  }

  it("por edad: sólo MP4 de ffmpeg, regulares y viejos; nunca el que se graba, enlaces, otros ni replays", () => {
    const { d, v, current } = dir();
    const dry = applyRetention(v, { maxAgeDays: 7, maxTotalBytes: null }, current, { dryRun: true });
    expect(dry.deleted.map((x) => x.name)).toEqual([
      "broadcast-2026-09-01T00-00-00-000Z.mp4",
      "broadcast-2026-09-02T00-00-00-000Z.mp4",
    ]);
    expect(readdirSync(v)).toHaveLength(7); // simular no borra
    const r = applyRetention(v, { maxAgeDays: 7, maxTotalBytes: null }, current);
    expect(r.deleted.map((x) => x.reason)).toEqual(["age", "age"]);
    expect(readdirSync(v).sort()).toEqual([
      "broadcast-2026-09-03T00-00-00-000Z.mp4",
      "broadcast-2026-11-02T10-00-00-000Z.mp4",
      "broadcast-2026-11-02T11-00-00-000Z.mp4",
      "broadcast-falso.mp4",
      "notas.txt",
    ]);
    expect(readdirSync(d)).toContain("viejo.replay");
  });

  it("por tamaño: borra los más viejos hasta bajar del límite (el en curso cuenta, no se borra)", () => {
    const { v, current } = dir();
    const r = applyRetention(v, { maxAgeDays: null, maxTotalBytes: 1024 * 1024 }, current);
    expect(r.deleted).toEqual([]); // 1000 B < 1 MiB
    const view = listRecordings(v, current);
    expect(view.count).toBe(4);
    expect(view.files.find((f) => f.inProgress)?.name).toBe("broadcast-2026-11-02T11-00-00-000Z.mp4");
    expect(view.totalBytes).toBe(1000);
  });

  it("vía API interna: política validada y resultado para auditar", async () => {
    const { v, current } = dir();
    await withServer(
      async (base) => {
        expect((await post(base, "/recordings/retention", { policy: { maxAgeDays: 0 } })).status).toBe(400);
        expect((await post(base, "/recordings/retention", { policy: {} })).status).toBe(400);
        const r = await (await post(base, "/recordings/retention", { policy: { maxAgeDays: 7 } })).json();
        // Sin grabación en curso en este supervisor: el «en curso» de dir() también es viejo y se borra.
        expect(r.deleted.map((x: { name: string }) => x.name)).toContain("broadcast-2026-09-01T00-00-00-000Z.mp4");
        const list = await (await fetch(`${base}/recordings`, { headers: H })).json();
        expect(list.dir).toBe("arena_replays/video");
        expect(current).toBeTruthy();
      },
      { recordDir: v },
    );
  });
});
