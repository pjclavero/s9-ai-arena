/**
 * EQ5c · Regresión de las correcciones de la revisión EQ6b (PR #227) que las
 * pruebas de rotura del revisor (eq6b-relay-break.test.ts) no cubren por sí solas:
 *
 *  - P2-2 · el sobre atado a su destino: plataforma distinta, `bind` manipulado
 *    (re-apuntar un sobre ajeno), sobre v1 sin destino, forma equivalente de la
 *    MISMA ingesta (control positivo) y la clave HEREDADA (STREAM_KEY_FILE), que
 *    tampoco puede salir hacia una ingesta que no sea la del despliegue;
 *  - P2-3 · fail-closed: secreto exigido e ilegible ⇒ 401 aun con cabecera y
 *    /healthz 503;
 *  - P2-1 · /control/test con plazo total: se responde y se CIERRA el socket;
 *  - P1 · el rechazo explícito llega a `lastError` REDACTADO (el servidor repite
 *    la clave en la descripción y en el `code`) y acaba en `failed`.
 *
 * Servidores RTMP falsos en proceso (127.0.0.1, puerto efímero); nada sale a la red.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAmf0Values, encodeAmf0Values } from "./rtmp/amf0.js";
import { ChunkReader, encodeMessage, MSG_COMMAND_AMF0, MSG_SET_CHUNK_SIZE, type RtmpMessage } from "./rtmp/chunk.js";
import type { IngestTarget } from "./rtmp/publisher.js";
import { createControlServer } from "./control.js";
import { StreamSupervisor, type SpawnedProcess } from "./supervisor.js";
import { createLogger, DEFAULT_CONFIG, SecretRegistry } from "./config.js";
import { openSecret, sealSecret } from "../../../packages/stream-secrets/index.js";

const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const KEY = `eq5c-${randomBytes(12).toString("hex")}`;
const YT = { platform: "youtube", ingest: "rtmps://a.rtmps.youtube.com/live2" };

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

type Behaviour = "normal" | "silent_after_handshake" | "reject_publish_echo";

async function fakeIngest(behaviour: Behaviour) {
  const seen = { published: [] as string[], connects: 0, closed: 0 };
  const server = createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {});
    sock.on("close", () => seen.closed++);
    let buf = Buffer.alloc(0);
    let phase: "c0c1" | "c2" | "chunks" = "c0c1";
    const reader = new ChunkReader();
    const send = (m: RtmpMessage) => sock.write(encodeMessage(m, 128));
    const reply = (name: string, txn: number, args: unknown[], streamId = 0) =>
      send({
        csid: 3,
        type: MSG_COMMAND_AMF0,
        streamId,
        timestamp: 0,
        payload: encodeAmf0Values([name, txn, ...(args as never[])]),
      });
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (phase === "c0c1") {
        if (buf.length < 1537) return;
        sock.write(Buffer.concat([Buffer.from([3]), randomBytes(1536), buf.subarray(1, 1537)]));
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
          if (m.type === MSG_SET_CHUNK_SIZE || m.type !== MSG_COMMAND_AMF0) continue;
          const v = decodeAmf0Values(m.payload);
          const name = String(v[0]);
          const txn = Number(v[1]);
          if (name === "connect") seen.connects++;
          if (behaviour === "silent_after_handshake") continue;
          if (name === "connect") reply("_result", txn, [{}, { code: "NetConnection.Connect.Success" }]);
          if (name === "createStream") reply("_result", txn, [null, 1]);
          if (name === "publish") {
            const key = String(v[3]);
            if (behaviour === "reject_publish_echo") {
              // Servidor hostil: repite la clave en el code y en la descripción.
              reply(
                "onStatus",
                0,
                [null, { level: "error", code: `BadName.${key}`, description: `clave ${key} no válida` }],
                1,
              );
              continue;
            }
            seen.published.push(key);
            reply("onStatus", 0, [null, { level: "status", code: "NetStream.Publish.Start", description: "ok" }], 1);
          }
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { seen, dial: (_t: IngestTarget) => netConnect({ host: "127.0.0.1", port }) as Duplex };
}

class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdio = [
    null,
    null,
    null,
    Object.assign(new EventEmitter(), { pause() {}, resume() {} }),
  ] as unknown as ArrayLike<unknown>;
  kill() {
    return true;
  }
}

async function control(o: {
  dial: (t: IngestTarget) => Duplex;
  secret?: string | null | (() => string | null);
  required?: boolean;
  legacyKey?: string | null;
  rtmpsUrl?: string;
  testDeadlineMs?: number;
  maxRetries?: number;
}) {
  const lines: string[] = [];
  const secrets = new SecretRegistry();
  const logger = createLogger(secrets, (l) => lines.push(l));
  const config = {
    ...DEFAULT_CONFIG,
    retryDelayMs: 10,
    maxRetries: o.maxRetries ?? 3,
    rtmpsUrl: o.rtmpsUrl ?? DEFAULT_CONFIG.rtmpsUrl,
  };
  const sup = new StreamSupervisor({ config, spawner: () => new FakeChild(), logger, secrets, dial: o.dial });
  const server = createControlServer({
    supervisor: sup,
    config,
    logger,
    capabilities: { nvenc: false },
    controlSecret: o.secret === undefined ? "s3cr3t" : o.secret,
    requireControlSecret: o.required,
    readPrivateKey: () => PRIV,
    readLegacyKey: () => o.legacyKey ?? null,
    dial: o.dial,
    testDeadlineMs: o.testDeadlineMs,
  });
  servers.push(server as unknown as Server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, secret = "s3cr3t") =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-streamer-auth": secret },
      body: JSON.stringify(body),
    });
  return { sup, base, post, lines };
}

const start = (over: Record<string, unknown>) => ({ sessionId: "s1", mode: "rtmps", ...over });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("EQ5c · P2-2 · el sobre sólo se abre hacia su destino", () => {
  it("openSecret: misma ingesta escrita de otra forma abre; otra ingesta, otra plataforma o `bind` manipulado, no", () => {
    const sealed = sealSecret(KEY, PUB, YT);
    expect(openSecret(sealed, PRIV, { platform: "youtube", ingest: "rtmps://A.RTMPS.YOUTUBE.COM:443/live2/" })).toBe(
      KEY,
    );
    expect(() => openSecret(sealed, PRIV, { ...YT, ingest: "rtmps://evil.example/live2" })).toThrow(/otro destino/);
    expect(() => openSecret(sealed, PRIV, { ...YT, ingest: "rtmps://a.rtmps.youtube.com:444/live2" })).toThrow(
      /otro destino/,
    );
    expect(() => openSecret(sealed, PRIV, { ...YT, ingest: "rtmps://a.rtmps.youtube.com/live3" })).toThrow(
      /otro destino/,
    );
    expect(() => openSecret(sealed, PRIV, { ...YT, platform: "custom" })).toThrow(/otro destino/);
    // Re-apuntar el sobre (cambiar `bind` y pedir ese destino): el AAD de GCM no autentica.
    const moved = { ...sealed, bind: { platform: "youtube", ingest: "rtmps://evil.example:443/live2" } };
    expect(() => openSecret(moved, PRIV, { platform: "youtube", ingest: "rtmps://evil.example/live2" })).toThrow(
      /no se puede abrir/,
    );
    // Sobre v1 (sólo la clave, sin destino): se rechaza.
    expect(() => openSecret({ v: 1, alg: "RSA-OAEP-256", kid: sealed.kid, ct: "AAAA" }, PRIV, YT)).toThrow(/antiguo/);
  });

  it("/control/start: platform distinta ⇒ 409; bind manipulado ⇒ 409; sin platform ⇒ 400; destino correcto ⇒ 200 y publica", async () => {
    const ing = await fakeIngest("normal");
    const c = await control({ dial: ing.dial });
    const sealed = sealSecret(KEY, PUB, { platform: "custom", ingest: "rtmps://ingest.example/live2" });
    const url = "rtmps://ingest.example/live2";
    expect(
      (await c.post("/control/start", start({ ingestUrl: url, platform: "youtube", credential: sealed }))).status,
    ).toBe(409);
    const moved = { ...sealed, bind: { platform: "custom", ingest: "rtmps://evil.example:443/live2" } };
    expect(
      (
        await c.post(
          "/control/start",
          start({ ingestUrl: "rtmps://evil.example/live2", platform: "custom", credential: moved }),
        )
      ).status,
    ).toBe(409);
    expect((await c.post("/control/start", start({ ingestUrl: url, credential: sealed }))).status).toBe(400);
    expect(ing.seen.published).toEqual([]);
    // Control positivo: la orden legítima sí publica.
    const ok = await c.post("/control/start", start({ ingestUrl: url, platform: "custom", credential: sealed }));
    expect(ok.status).toBe(200);
    for (let i = 0; i < 40 && !ing.seen.published.length; i++) await sleep(25);
    c.sup.stop();
    expect(ing.seen.published).toEqual([KEY]);
    expect(c.lines.join("\n")).not.toContain(KEY);
  });

  it("clave HEREDADA (STREAM_KEY_FILE): sólo hacia la ingesta del despliegue; a otra ingesta ⇒ 409 y no sale", async () => {
    const ing = await fakeIngest("normal");
    const c = await control({ dial: ing.dial, legacyKey: KEY, rtmpsUrl: "rtmps://deploy.example/live2" });
    const evil = await c.post("/control/start", start({ ingestUrl: "rtmps://attacker.example/live2" }));
    expect(evil.status).toBe(409);
    await sleep(200);
    expect(ing.seen.published).toEqual([]);
    const okRes = await c.post("/control/start", start({ ingestUrl: "rtmps://deploy.example:443/live2" }));
    expect(okRes.status).toBe(200);
    for (let i = 0; i < 40 && !ing.seen.published.length; i++) await sleep(25);
    c.sup.stop();
    expect(ing.seen.published).toEqual([KEY]);
  });
});

describe("EQ5c · P2-3 · el control falla en cerrado", () => {
  it("secreto exigido e ilegible ⇒ 401 en todo (incluso con cabecera) y /healthz 503; secreto legible ⇒ normal", async () => {
    let value: string | null = null;
    const c = await control({
      dial: (() => {
        throw new Error("no debe marcar");
      }) as never,
      secret: () => value,
      required: true,
    });
    expect((await fetch(`${c.base}/status`)).status).toBe(401);
    expect((await fetch(`${c.base}/status`, { headers: { "x-streamer-auth": "" } })).status).toBe(401);
    expect((await c.post("/control/stop", {}, "cualquiera")).status).toBe(401);
    expect((await fetch(`${c.base}/healthz`)).status).toBe(503);
    // Se relee en cada petición: al corregir el fichero vuelve sin reiniciar.
    value = "s3cr3t";
    expect((await fetch(`${c.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${c.base}/status`, { headers: { "x-streamer-auth": "s3cr3t" } })).status).toBe(200);
    expect((await fetch(`${c.base}/status`)).status).toBe(401);
  });
});

describe("EQ5c · P2-1 · /control/test tiene plazo", () => {
  it("ingesta muda tras el handshake: responde ok:false a tiempo y CIERRA el socket", async () => {
    const ing = await fakeIngest("silent_after_handshake");
    const c = await control({ dial: ing.dial, testDeadlineMs: 400 });
    const sealed = sealSecret(KEY, PUB, { platform: "custom", ingest: "rtmps://ingest.example/live2" });
    const t0 = Date.now();
    const r = await c.post("/control/test", {
      ingestUrl: "rtmps://ingest.example/live2",
      platform: "custom",
      credential: sealed,
    });
    const body = (await r.json()) as { ok: boolean; error?: string };
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(body.ok).toBe(false);
    for (let i = 0; i < 40 && !ing.seen.closed; i++) await sleep(25);
    expect(ing.seen.connects).toBe(1);
    expect(ing.seen.closed).toBeGreaterThan(0);
  });
});

describe("EQ5c · P1 + P3 · el rechazo llega redactado y acaba en failed", () => {
  it("servidor que repite la clave en code y descripción: lastError sin la clave, reintentos acotados y `failed`", async () => {
    const ing = await fakeIngest("reject_publish_echo");
    const c = await control({ dial: ing.dial, maxRetries: 2 });
    const sealed = sealSecret(KEY, PUB, { platform: "custom", ingest: "rtmps://ingest.example/live2" });
    const r = await c.post(
      "/control/start",
      start({ ingestUrl: "rtmps://ingest.example/live2", platform: "custom", credential: sealed }),
    );
    expect(r.status).toBe(200);
    for (let i = 0; i < 80 && c.sup.state !== "failed"; i++) await sleep(25);
    const st = await (await fetch(`${c.base}/status`, { headers: { "x-streamer-auth": "s3cr3t" } })).text();
    c.sup.stop();
    expect(JSON.parse(st).state).toBe("failed");
    expect(JSON.parse(st).restarts).toBe(3);
    expect(JSON.parse(st).lastError.message).toMatch(/rechazó la publicación/);
    expect(st).not.toContain(KEY);
    expect(c.lines.join("\n")).not.toContain(KEY);
  });
});
