/**
 * EQ6c · Re-revisión adversarial del PR #227 (ronda 2) · streamer.
 *
 * NO es una suite del autor. Convención:
 *  - `CIERRE`: comprueba que un hallazgo de la ronda 1 (EQ6b) está cerrado POR
 *    EL ARREGLO; debe estar en verde sobre a41a903 y en rojo si se revierte el
 *    arreglo (calibración en el informe EQ6c).
 *  - `DEFECTO`: hallazgo NUEVO de la ronda 2; en rojo sobre a41a903 a propósito.
 *  - `CONTROL`: ataque que la entrega resiste.
 * Servidores RTMP falsos en 127.0.0.1 con puerto efímero; nada sale a la red.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAmf0Values, encodeAmf0Values } from "./rtmp/amf0.js";
import { ChunkReader, encodeMessage, MSG_COMMAND_AMF0, MSG_SET_CHUNK_SIZE, type RtmpMessage } from "./rtmp/chunk.js";
import { parseIngestUrl, RtmpPublisher, type IngestTarget } from "./rtmp/publisher.js";
import { createControlServer } from "./control.js";
import { StreamSupervisor, type SpawnedProcess } from "./supervisor.js";
import { createLogger, DEFAULT_CONFIG, SecretRegistry } from "./config.js";
import { canonicalIngestUrl, openSecret, sealSecret } from "../../../packages/stream-secrets/index.js";

const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const { publicKey: OTHER_PUB } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const KEY = `eq6c-${randomBytes(12).toString("hex")}-Kz`;
const YT = { platform: "youtube", ingest: "rtmps://a.rtmps.youtube.com/live2" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Todas las formas en que la clave podría filtrarse. */
const needles = (k: string) => [
  k,
  k.toUpperCase(),
  k.toLowerCase(),
  encodeURIComponent(k),
  Buffer.from(k).toString("base64"),
  Buffer.from(k).toString("base64").slice(0, 16),
  Buffer.from(k).toString("hex"),
];
const leaks = (text: string, k = KEY) => needles(k).filter((n) => text.includes(n));

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

type Behaviour =
  | "normal"
  | "reject_publish"
  | "reject_connect"
  | "silent_at_createStream"
  | "silent_at_publish"
  | "stall_after_publish"
  | "echo_key_encoded";

async function fakeIngest(behaviour: Behaviour) {
  const seen = { published: [] as string[], connects: 0, closed: 0, bytesAfterPublish: 0 };
  const server = createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {});
    sock.on("close", () => seen.closed++);
    let buf = Buffer.alloc(0);
    let phase: "c0c1" | "c2" | "chunks" = "c0c1";
    let publishing = false;
    const s1 = randomBytes(1536);
    const reader = new ChunkReader();
    const send = (m: RtmpMessage) => sock.write(encodeMessage(m, 128));
    const reply = (name: string, txn: number, args: unknown[], streamId = 0) =>
      send({ csid: 3, type: MSG_COMMAND_AMF0, streamId, timestamp: 0, payload: encodeAmf0Values([name, txn, ...(args as never[])]) });
    sock.on("data", (d: Buffer) => {
      if (publishing) seen.bytesAfterPublish += d.length;
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
      if (phase !== "chunks" || !buf.length) return;
      const msgs = reader.push(buf);
      buf = Buffer.alloc(0);
      for (const m of msgs) {
        if (m.type === MSG_SET_CHUNK_SIZE) {
          if (m.payload.length >= 4) reader.setChunkSize(m.payload.readUInt32BE(0) & 0x7fffffff);
          continue;
        }
        if (m.type !== MSG_COMMAND_AMF0) continue;
        const v = decodeAmf0Values(m.payload);
        const name = String(v[0]);
        const txn = Number(v[1]);
        if (name === "connect") {
          seen.connects++;
          if (behaviour === "reject_connect") {
            reply("_error", txn, [null, { level: "error", code: "NetConnection.Connect.Rejected", description: "no" }]);
            continue;
          }
          reply("_result", txn, [{}, { code: "NetConnection.Connect.Success" }]);
        }
        if (name === "createStream") {
          if (behaviour === "silent_at_createStream") continue;
          reply("_result", txn, [null, 1]);
        }
        if (name === "publish") {
          const key = String(v[3]);
          if (behaviour === "silent_at_publish") continue;
          if (behaviour === "reject_publish") {
            reply("onStatus", 0, [null, { level: "error", code: "NetStream.Publish.BadName", description: "invalid key" }], 1);
            continue;
          }
          if (behaviour === "echo_key_encoded") {
            // Ingesta hostil (o ruidosa) que repite la clave CODIFICADA en su rechazo.
            const b64 = Buffer.from(key).toString("base64");
            const hex = Buffer.from(key).toString("hex");
            reply("onStatus", 0, [null, { level: "error", code: "NetStream.Publish.BadName", description: `bad ${b64} ${hex}` }], 1);
            continue;
          }
          seen.published.push(key);
          reply("onStatus", 0, [null, { level: "status", code: "NetStream.Publish.Start", description: "ok" }], 1);
          publishing = true;
          if (behaviour === "stall_after_publish") sock.pause(); // deja de leer: la ventana TCP se llena
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { seen, port, dial: (_t: IngestTarget) => netConnect({ host: "127.0.0.1", port }) as Duplex };
}

class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdio = [null, null, null, Object.assign(new EventEmitter(), { pause() {}, resume() {} })] as unknown as ArrayLike<unknown>;
  kill() {
    return true;
  }
}

async function control(o: { dial: (t: IngestTarget) => Duplex; legacyKey?: string | null; rtmpsUrl?: string; maxRetries?: number }) {
  const lines: string[] = [];
  const secrets = new SecretRegistry();
  const logger = createLogger(secrets, (l) => lines.push(l));
  const config = {
    ...DEFAULT_CONFIG,
    retryDelayMs: 10,
    maxRetries: o.maxRetries ?? 2,
    rtmpsUrl: o.rtmpsUrl ?? DEFAULT_CONFIG.rtmpsUrl,
  };
  const sup = new StreamSupervisor({ config, spawner: () => new FakeChild(), logger, secrets, dial: o.dial });
  const server = createControlServer({
    supervisor: sup,
    config,
    logger,
    capabilities: { nvenc: false },
    controlSecret: "s3cr3t-eq6c",
    requireControlSecret: true,
    readPrivateKey: () => PRIV,
    readLegacyKey: () => o.legacyKey ?? null,
    dial: o.dial,
    testDeadlineMs: 1500,
  });
  servers.push(server as unknown as Server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-streamer-auth": "s3cr3t-eq6c" },
      body: JSON.stringify(body),
    });
  const status = async () =>
    (await (await fetch(`${base}/status`, { headers: { "x-streamer-auth": "s3cr3t-eq6c" } })).json()) as {
      state: string;
      restarts: number;
      lastError: { message: string } | null;
      relay: { state: string | null };
    };
  return { sup, base, post, status, lines };
}

const startBody = (over: Record<string, unknown>) => ({ sessionId: "s-eq6c", mode: "rtmps", ...over });

// ── P1 ──────────────────────────────────────────────────────────────────────
describe("EQ6c · P1 · el rechazo de la ingesta llega a `failed` por /status", () => {
  for (const behaviour of ["reject_publish", "reject_connect"] as const) {
    it(`CIERRE P1 · ${behaviour}: /status acaba en failed, lastError redactado, relé cerrado y NUNCA «publishing»`, async () => {
      const ing = await fakeIngest(behaviour);
      const c = await control({ dial: ing.dial, maxRetries: 2 });
      const url = "rtmps://ingest.example/live2";
      const credential = sealSecret(KEY, PUB, { platform: "custom", ingest: url });
      const r = await c.post("/control/start", startBody({ ingestUrl: url, platform: "custom", credential }));
      expect(r.status).toBe(200);
      const seenStates: string[] = [];
      let last = await c.status();
      for (let i = 0; i < 100 && last.state !== "failed"; i++) {
        await sleep(30);
        last = await c.status();
        seenStates.push(`${last.state}/${last.relay.state}`);
      }
      const dump = JSON.stringify(last);
      c.sup.stop();
      expect(ing.seen.connects).toBeGreaterThan(0);
      expect(last.state, dump).toBe("failed");
      expect(last.lastError?.message ?? "", dump).toMatch(/rechaz/);
      expect(leaks(dump)).toEqual([]);
      expect(leaks(c.lines.join("\n"))).toEqual([]);
      expect(seenStates.some((s) => s.endsWith("/publishing"))).toBe(false);
      expect(last.relay.state === null || last.relay.state === "closed").toBe(true);
    });
  }
});

// ── P2-1 ────────────────────────────────────────────────────────────────────
describe("EQ6c · P2-1 · plazos después del handshake", () => {
  for (const behaviour of ["silent_at_createStream", "silent_at_publish"] as const) {
    it(`CIERRE P2-1 · ${behaviour}: start() falla a tiempo, emite 'error' y cierra el socket`, async () => {
      const ing = await fakeIngest(behaviour);
      const pub = new RtmpPublisher({
        target: parseIngestUrl("rtmps://ingest.example/live2"),
        streamKey: KEY,
        dial: ing.dial,
        connectTimeoutMs: 300,
      });
      let errored = false;
      pub.on("error", () => (errored = true));
      const t0 = Date.now();
      const res = await Promise.race([pub.start().then(() => "ok", () => "rejected"), sleep(3000).then(() => "colgado")]);
      for (let i = 0; i < 40 && !ing.seen.closed; i++) await sleep(25);
      pub.close();
      expect(res).toBe("rejected");
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(errored).toBe(true);
      expect(ing.seen.closed).toBeGreaterThan(0);
    });
  }

  it("CIERRE P2-1 · /control/test contra una ingesta muda en createStream/publish no cuelga (sólo hace connect)", async () => {
    const ing = await fakeIngest("silent_at_createStream");
    const c = await control({ dial: ing.dial });
    const url = "rtmps://ingest.example/live2";
    const t0 = Date.now();
    const r = (await (
      await c.post("/control/test", { ingestUrl: url, platform: "custom", credential: sealSecret(KEY, PUB, { platform: "custom", ingest: url }) })
    ).json()) as { ok: boolean };
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.ok).toBe(true); // probe no llega a createStream: control positivo, la prueba no publica
  });

  it("DEFECTO P3 · tras NetStream.Publish.Start, una ingesta que deja de LEER deja el relé «publishing» para siempre (sin plazo de escritura)", async () => {
    const ing = await fakeIngest("stall_after_publish");
    const pub = new RtmpPublisher({
      target: parseIngestUrl("rtmps://ingest.example/live2"),
      streamKey: KEY,
      dial: ing.dial,
      connectTimeoutMs: 300,
    });
    let errored = false;
    pub.on("error", () => (errored = true));
    await pub.start();
    // Lo que hace el supervisor: escribir mientras writeFlv diga que sí; luego esperar 'drain'.
    let ts = 0;
    let accepting = pub.writeFlv(Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]));
    for (let i = 0; i < 400 && accepting; i++) {
      const size = 256 * 1024;
      const b = Buffer.alloc(11 + size + 4);
      b[0] = 9;
      b.writeUIntBE(size, 1, 3);
      b.writeUIntBE((ts += 33) & 0xffffff, 4, 3);
      b.writeUInt32BE(11 + size, 11 + size);
      accepting = pub.writeFlv(b);
    }
    expect(accepting).toBe(false); // el productor está parado: la ingesta no lee
    await sleep(3000); // 10× connectTimeoutMs
    const view = { state: pub.state, errored };
    pub.close();
    // Exigible: un relé que no puede escribir en un plazo razonable falla (y el supervisor reintenta).
    expect(view.state === "closed" || view.errored, JSON.stringify(view)).toBe(true);
  });
});

// ── P2-2 ────────────────────────────────────────────────────────────────────
describe("EQ6c · P2-2 · sobre v2 atado a su destino", () => {
  it("CIERRE P2-2 · el sobre de YouTube NO se abre hacia otra ingesta, puerto, app o plataforma; sí hacia la MISMA escrita de otra forma", () => {
    const s = sealSecret(KEY, PUB, YT);
    for (const same of [
      "rtmps://A.RTMPS.YOUTUBE.COM/live2",
      "rtmps://a.rtmps.youtube.com:443/live2",
      "rtmps://a.rtmps.youtube.com:0443/live2/",
      "RTMPS://a.rtmps.youtube.com//live2//",
      "rtmps://a.rtmps.youtube.com/x/../live2",
    ]) {
      expect(openSecret(s, PRIV, { platform: "youtube", ingest: same }), same).toBe(KEY);
    }
    for (const other of [
      "rtmps://attacker.example/live2",
      "rtmps://a.rtmps.youtube.com.attacker.example/live2",
      "rtmps://a.rtmps.youtube.com./live2",
      "rtmps://a.rtmps.youtube.com:444/live2",
      "rtmps://a.rtmps.youtube.com/live2/x",
      "rtmps://a.rtmps.youtube.com/live2%2f",
      "rtmp://a.rtmps.youtube.com:443/live2",
      "rtmps://u:p@a.rtmps.youtube.com/live2",
      "rtmps://a.rtmps.yоutube.com/live2", // o cirílica (IDN)
      "rtmps://xn--a-rtmps-youtube-com-xyz.example/live2",
      "rtmps://[::1]/live2",
      "rtmps://[::ffff:127.0.0.1]/live2",
      "rtmps://a.rtmps.youtube.com%2eevil.com/live2",
    ]) {
      expect(() => openSecret(s, PRIV, { platform: "youtube", ingest: other }), other).toThrow();
    }
    expect(() => openSecret(s, PRIV, { platform: "custom", ingest: YT.ingest })).toThrow(/otro destino/);
  });

  it("CIERRE P2-2 · la forma canónica y el destino REAL de la conexión no divergen (lo que casa con YouTube, marca a YouTube)", () => {
    const ref = canonicalIngestUrl(YT.ingest);
    const tricky = [
      "rtmps://A.RTMPS.YOUTUBE.COM/live2",
      "rtmps://a.rtmps.you\ttube.com/live2",
      " rtmps://a.rtmps.youtube.com/live2\n",
      "rtmps://a.rtmps.youtube.com/live%32",
      "rtmps://a.rtmps.youtube.com./live2",
      "rtmps://a.rtmps.youtube.com%2eevil.com/live2",
      "rtmps://evil.com\\@a.rtmps.youtube.com/live2",
      "rtmps://a.rtmps.youtube.com#@evil/live2",
      "rtmps://a.rtmps.youtube.com:443:80/live2",
      "rtmps:a.rtmps.youtube.com/live2",
    ];
    for (const v of tricky) {
      let canon: string | null = null;
      try {
        canon = canonicalIngestUrl(v);
      } catch {
        canon = null;
      }
      if (canon !== ref) continue;
      const t = parseIngestUrl(v);
      expect({ v, host: t.host.toLowerCase(), port: t.port, app: t.app }).toEqual({
        v,
        host: "a.rtmps.youtube.com",
        port: 443,
        app: "live2",
      });
    }
  });

  it("CIERRE P2-2 · /control/start: sobre de YouTube hacia ingestas ajenas, sobre manipulado (bind/ct/tag/iv/ek), v1, alg o kid ajenos ⇒ ≥400 y la ingesta no recibe la clave", async () => {
    const evil = await fakeIngest("normal");
    const c = await control({ dial: evil.dial });
    const s = sealSecret(KEY, PUB, YT);
    const flip = (b64: string) => {
      const b = Buffer.from(b64, "base64");
      b[b.length - 1] ^= 1;
      return b.toString("base64");
    };
    const evilUrl = "rtmps://attacker.example/live2";
    const attempts: Array<Record<string, unknown>> = [
      { ingestUrl: evilUrl, platform: "youtube", credential: s },
      { ingestUrl: evilUrl, platform: "custom", credential: s },
      { ingestUrl: "rtmps://a.rtmps.youtube.com:444/live2", platform: "youtube", credential: s },
      { ingestUrl: evilUrl, credential: s },
      { ingestUrl: evilUrl, platform: "youtube", credential: { ...s, bind: { platform: "youtube", ingest: canonicalIngestUrl(evilUrl) } } },
      { ingestUrl: evilUrl, platform: "custom", credential: { ...s, bind: { platform: "custom", ingest: canonicalIngestUrl(evilUrl) } } },
      { ingestUrl: YT.ingest, platform: "youtube", credential: { ...s, ct: flip(s.ct) } },
      { ingestUrl: YT.ingest, platform: "youtube", credential: { ...s, tag: flip(s.tag) } },
      { ingestUrl: YT.ingest, platform: "youtube", credential: { ...s, iv: flip(s.iv) } },
      { ingestUrl: YT.ingest, platform: "youtube", credential: { ...s, ek: flip(s.ek) } },
      { ingestUrl: YT.ingest, platform: "youtube", credential: { ...s, v: 1 } },
      { ingestUrl: YT.ingest, platform: "youtube", credential: { v: 1, alg: "RSA-OAEP-256", kid: s.kid, ct: s.ek } },
      { ingestUrl: YT.ingest, platform: "youtube", credential: { ...s, alg: "RSA-OAEP-256" } },
      { ingestUrl: YT.ingest, platform: "youtube", credential: { ...s, bind: undefined } },
      { ingestUrl: YT.ingest, platform: "youtube", credential: sealSecret(KEY, OTHER_PUB, YT) },
      { ingestUrl: YT.ingest, platform: "youtube", credential: JSON.stringify(s) },
    ];
    const statuses: number[] = [];
    for (const a of attempts) statuses.push((await c.post("/control/start", startBody(a))).status);
    await sleep(500);
    c.sup.stop();
    expect(evil.seen.published).toEqual([]);
    for (const [i, st] of statuses.entries()) expect(st, `intento ${i}`).toBeGreaterThanOrEqual(400);
    expect(leaks(c.lines.join("\n"))).toEqual([]);
  });

  it("CONTROL · la orden legítima (YouTube hacia YouTube) publica: el banco de pruebas no rechaza todo", async () => {
    const yt = await fakeIngest("normal");
    const c = await control({ dial: yt.dial });
    const r = await c.post("/control/start", startBody({ ingestUrl: "rtmps://A.RTMPS.YOUTUBE.COM:443/live2/", platform: "youtube", credential: sealSecret(KEY, PUB, YT) }));
    expect(r.status).toBe(200);
    for (let i = 0; i < 60 && !yt.seen.published.length; i++) await sleep(25);
    c.sup.stop();
    expect(yt.seen.published).toEqual([KEY]);
  });

  it("CIERRE P2-2 · clave HEREDADA (STREAM_KEY_FILE): no sale hacia otra ingesta ni con credencial «falsa» (0, '', false, null)", async () => {
    const evil = await fakeIngest("normal");
    const c = await control({ dial: evil.dial, legacyKey: KEY, rtmpsUrl: "rtmps://deploy.example/live2" });
    const statuses: number[] = [];
    for (const credential of [undefined, null, 0, "", false]) {
      for (const ingestUrl of ["rtmps://attacker.example/live2", "rtmps://deploy.example:444/live2", "rtmps://deploy.example/live3", "rtmps://deploy.example.attacker.example/live2"]) {
        statuses.push((await c.post("/control/start", startBody({ ingestUrl, platform: "custom", credential }))).status);
      }
    }
    await sleep(400);
    c.sup.stop();
    expect(evil.seen.published).toEqual([]);
    for (const st of statuses) expect(st).toBeGreaterThanOrEqual(400);
  });

  it("DEFECTO P3 · etiqueta GCM truncada: openSecret acepta un sobre con tag de 4 bytes (2^-32 por intento de re-apuntar en vez de 2^-128)", () => {
    const s = sealSecret(KEY, PUB, YT);
    const short = { ...s, tag: Buffer.from(s.tag, "base64").subarray(0, 4).toString("base64") };
    // Exigible: sólo etiquetas de 16 bytes (authTagLength: 16 / validar longitud exacta en isSealedSecret).
    expect(() => openSecret(short, PRIV, YT)).toThrow();
  });
});

// ── P2-3 ────────────────────────────────────────────────────────────────────
describe("EQ6c · P2-3 · control en cerrado con el proceso REAL", () => {
  async function runMain(secretPath: string) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ["--import", "tsx", "apps/streamer/src/main.ts"], {
      env: {
        PATH: process.env.PATH ?? "",
        STREAMER_CONTROL_PORT: String(port),
        STREAMER_CONTROL_SECRET_FILE: secretPath,
        FFMPEG_BIN: "/nonexistent-ffmpeg",
        CHROMIUM_BIN: "/nonexistent-chromium",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      await sleep(150);
      try {
        await fetch(`${base}/healthz`);
        up = true;
      } catch {
        /* arrancando */
      }
    }
    return { child, base, up };
  }

  it("CIERRE P2-3 · secreto vacío, sólo espacios, ilegible (0000), inexistente o directorio ⇒ 401 en todo (con y sin cabecera) y /healthz 503", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eq6c-"));
    const cases: Record<string, string> = {};
    cases.vacio = join(dir, "vacio");
    writeFileSync(cases.vacio, "", { mode: 0o600 });
    cases.espacios = join(dir, "espacios");
    writeFileSync(cases.espacios, "  \n\t \r\n", { mode: 0o600 });
    cases.ilegible = join(dir, "ilegible");
    writeFileSync(cases.ilegible, randomBytes(24).toString("hex"), { mode: 0o600 });
    chmodSync(cases.ilegible, 0o000);
    cases.inexistente = join(dir, "no-existe");
    cases.directorio = join(dir, "dir");
    mkdirSync(cases.directorio);
    const results: Record<string, unknown> = {};
    for (const [name, path] of Object.entries(cases)) {
      const p = await runMain(path);
      try {
        expect(p.up, name).toBe(true);
        const h = (v: string) => ({ "x-streamer-auth": v });
        results[name] = {
          healthz: (await fetch(`${p.base}/healthz`)).status,
          status: (await fetch(`${p.base}/status`)).status,
          statusVacia: (await fetch(`${p.base}/status`, { headers: h("") })).status,
          statusEspacio: (await fetch(`${p.base}/status`, { headers: h(" ") })).status,
          start: (await fetch(`${p.base}/control/start`, { method: "POST", headers: h(" "), body: "{}" })).status,
          recordings: (await fetch(`${p.base}/recordings`, { headers: h("x") })).status,
        };
      } finally {
        p.child.kill("SIGKILL");
      }
    }
    for (const [name, r] of Object.entries(results)) {
      expect(r, name).toEqual({ healthz: 503, status: 401, statusVacia: 401, statusEspacio: 401, start: 401, recordings: 401 });
    }
  }, 90_000);

  it("CONTROL · con el secreto legible el proceso real abre /status con cabecera y lo cierra sin ella", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eq6c-"));
    const f = join(dir, "ok");
    const secret = randomBytes(24).toString("hex");
    writeFileSync(f, `${secret}\n`, { mode: 0o600 });
    const p = await runMain(f);
    try {
      expect((await fetch(`${p.base}/healthz`)).status).toBe(200);
      expect((await fetch(`${p.base}/status`)).status).toBe(401);
      expect((await fetch(`${p.base}/status`, { headers: { "x-streamer-auth": secret } })).status).toBe(200);
    } finally {
      p.child.kill("SIGKILL");
    }
  }, 30_000);
});

// ── superficies nuevas: redactSecret ────────────────────────────────────────
describe("EQ6c · redacción frente a una ingesta que repite la clave codificada", () => {
  it("DEFECTO P3 · la clave en base64/hex dentro del rechazo de la ingesta llega a /status (lastError) y a los logs", async () => {
    const ing = await fakeIngest("echo_key_encoded");
    const c = await control({ dial: ing.dial, maxRetries: 1 });
    const url = "rtmps://ingest.example/live2";
    await c.post("/control/start", startBody({ ingestUrl: url, platform: "custom", credential: sealSecret(KEY, PUB, { platform: "custom", ingest: url }) }));
    let st = await c.status();
    for (let i = 0; i < 100 && st.state !== "failed"; i++) {
      await sleep(30);
      st = await c.status();
    }
    c.sup.stop();
    expect(st.lastError).not.toBeNull(); // el rechazo llegó (control de la prueba)
    expect({ status: leaks(JSON.stringify(st)), logs: leaks(c.lines.join("\n")) }).toEqual({ status: [], logs: [] });
  });
});
