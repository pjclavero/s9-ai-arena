/**
 * STREAMING-UX · §22-§25 y §37 (V2) · Ingesta principal y de respaldo en el
 * streamer, a través de la API de control real con sobres sellados de PRUEBA.
 *
 *  - PRIMARY_FAILOVER_TO_BACKUP: la principal falla por RED FAILOVER_AFTER veces
 *    seguidas ⇒ se pasa al respaldo y se publica en él (con `live2?backup=1` como
 *    aplicación, tal cual);
 *  - BACKUP_REMAINS_FOR_SESSION: un corte del respaldo NO hace volver a la principal;
 *  - NEW_SESSION_STARTS_PRIMARY: una sesión nueva empieza por la principal;
 *  - NO_FAILOVER_ON_CREDENTIAL: una clave rechazada (o un fallo tras `connect`) no
 *    cambia de ingesta;
 *  - ACTIVE_INGEST_VISIBLE: /status dice qué ingesta se usa y el error de cada una;
 *  - el sobre de respaldo sólo se abre para la URL de respaldo;
 *  - §37 · regresión del caso de producción: vídeo sano (~30 FPS, frames que
 *    crecen), relé `connecting`, IPv6 sin salida y DNS con la AAAA primero ⇒ el
 *    relé publica por IPv4, y hasta que publica NO está «publishing».
 * Nada sale a la red: servidores RTMP falsos en 127.0.0.1.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, connect as netConnect, Socket, type AddressInfo, type Server } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAmf0Values, encodeAmf0Values } from "./rtmp/amf0.js";
import { ChunkReader, encodeMessage, MSG_COMMAND_AMF0, type RtmpMessage } from "./rtmp/chunk.js";
import { dialIngest } from "./rtmp/dial.js";
import type { IngestTarget } from "./rtmp/publisher.js";
import { createControlServer } from "./control.js";
import { FAILOVER_AFTER, StreamSupervisor, type SpawnedProcess } from "./supervisor.js";
import { createLogger, DEFAULT_CONFIG, SecretRegistry } from "./config.js";
import { sealSecret } from "../../../packages/stream-secrets/index.js";

const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const KEY = `ux-${randomBytes(12).toString("hex")}`;
const PRIMARY = "rtmps://a.rtmps.youtube.com/live2";
const BACKUP = "rtmps://b.rtmps.youtube.com/live2?backup=1";
const sealedPrimary = sealSecret(KEY, PUB, { platform: "youtube", ingest: PRIMARY });
const sealedBackup = sealSecret(KEY, PUB, { platform: "youtube", ingest: BACKUP });

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) {
  for (let t = 0; t < ms && !cond(); t += 20) await sleep(20);
  return cond();
}

/** Ingesta falsa: `reject` = rechaza la publicación (clave mala). Anota la app de cada connect. */
/**
 * Ingesta falsa. `reject`: rechaza la publicación con onStatus (clave mala); `closeOnPublish`:
 * acepta connect y CIERRA el socket al recibir publish (otra forma real de rechazar una clave:
 * `closed_by_server` DESPUÉS de connect); `dropAfterPublish`: publica y corta a los 30 ms.
 */
async function fakeIngest(o: { reject?: boolean; dropAfterPublish?: boolean; closeOnPublish?: boolean } = {}) {
  const seen = { apps: [] as string[], published: [] as string[] };
  const server = createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    let phase: "c0c1" | "c2" | "chunks" = "c0c1";
    const reader = new ChunkReader();
    const reply = (name: string, txn: number, args: unknown[], streamId = 0) =>
      sock.write(
        encodeMessage(
          {
            csid: 3,
            type: MSG_COMMAND_AMF0,
            streamId,
            timestamp: 0,
            payload: encodeAmf0Values([name, txn, ...(args as never[])]),
          } as RtmpMessage,
          128,
        ),
      );
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
          if (m.type === 1) reader.setChunkSize(m.payload.readUInt32BE(0));
          if (m.type !== MSG_COMMAND_AMF0) continue;
          const v = decodeAmf0Values(m.payload);
          const name = String(v[0]);
          const txn = Number(v[1]);
          if (name === "connect") {
            seen.apps.push(String((v[2] as Record<string, unknown>).app));
            reply("_result", txn, [{}, { code: "NetConnection.Connect.Success" }]);
          }
          if (name === "createStream") reply("_result", txn, [null, 1]);
          if (name === "publish") {
            if (o.closeOnPublish) {
              sock.destroy();
              continue;
            }
            if (o.reject) {
              reply("onStatus", 0, [null, { level: "error", code: "NetStream.Publish.BadName" }], 1);
              continue;
            }
            seen.published.push(String(v[3]));
            reply("onStatus", 0, [null, { level: "status", code: "NetStream.Publish.Start" }], 1);
            if (o.dropAfterPublish) setTimeout(() => sock.destroy(), 30);
          }
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, port: (server.address() as AddressInfo).port };
}

/** Socket que falla al instante como una ingesta caída (ECONNREFUSED ⇒ código `network`). */
function refused(): Duplex {
  const s = new Socket();
  setImmediate(() => s.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })));
  return s;
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

async function control(dial: (t: IngestTarget) => Duplex | Promise<Duplex>, children: FakeChild[] = []) {
  const lines: string[] = [];
  const secrets = new SecretRegistry();
  const logger = createLogger(secrets, (l) => lines.push(l));
  const config = { ...DEFAULT_CONFIG, retryDelayMs: 5, maxRetries: 12 };
  const sup = new StreamSupervisor({
    config,
    spawner: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    logger,
    secrets,
    dial,
  });
  const server = createControlServer({
    supervisor: sup,
    config,
    logger,
    capabilities: { nvenc: false },
    controlSecret: "s3cr3t",
    readPrivateKey: () => PRIV,
    readLegacyKey: () => null,
    dial,
  });
  servers.push(server as unknown as Server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-streamer-auth": "s3cr3t" },
      body: JSON.stringify(body),
    });
  const status = async () =>
    (await (await fetch(`${base}/status`, { headers: { "x-streamer-auth": "s3cr3t" } })).json()) as Record<string, any>;
  return { sup, post, status, lines };
}

const order = (sessionId: string, over: Record<string, unknown> = {}) => ({
  sessionId,
  mode: "rtmps",
  platform: "youtube",
  ingestUrl: PRIMARY,
  credential: sealedPrimary,
  backupIngestUrl: BACKUP,
  backupCredential: sealedBackup,
  ...over,
});

describe("STREAMING-UX · failover principal → respaldo", () => {
  it("PRIMARY_FAILOVER_TO_BACKUP + ACTIVE_INGEST_VISIBLE · tras FAILOVER_AFTER fallos de red publica en el respaldo, tal cual", async () => {
    const backup = await fakeIngest();
    const dials: string[] = [];
    const c = await control((t) => {
      dials.push(t.host);
      return t.host.startsWith("a.") ? refused() : netConnect({ host: "127.0.0.1", port: backup.port });
    });
    expect((await c.post("/control/start", order("s1"))).status).toBe(200);
    expect(await until(() => backup.seen.published.length > 0)).toBe(true);
    expect(dials.slice(0, FAILOVER_AFTER)).toEqual(Array(FAILOVER_AFTER).fill("a.rtmps.youtube.com"));
    expect(dials[FAILOVER_AFTER]).toBe("b.rtmps.youtube.com");
    expect(backup.seen.apps).toEqual(["live2?backup=1"]); // §21 · sin transformar
    expect(backup.seen.published).toEqual([KEY]);
    expect(await until(() => c.sup.relayState === "publishing")).toBe(true);
    const st = await c.status();
    expect(st.relay).toMatchObject({ state: "publishing", ingest: "backup", backupAvailable: true, failedOver: true });
    expect(st.relay.ingestErrors.primary).toMatch(/conexión con la ingesta fallida/);
    expect(st.target).toBe("rtmps://b.rtmps.youtube.com:443/live2?backup=1/***");
    expect(JSON.stringify(st)).not.toContain(KEY);
    expect(c.lines.join("\n")).not.toContain(KEY);
    c.sup.stop();
  });

  it("no cambia por un fallo transitorio: un fallo y luego conecta ⇒ sigue en la principal", async () => {
    const primary = await fakeIngest();
    let n = 0;
    const c = await control((t) =>
      t.host.startsWith("a.") && n++ === 0 ? refused() : netConnect({ host: "127.0.0.1", port: primary.port }),
    );
    await c.post("/control/start", order("s1"));
    expect(await until(() => c.sup.relayState === "publishing")).toBe(true);
    expect(c.sup.ingestRole).toBe("primary");
    expect(primary.seen.apps).toEqual(["live2"]);
    c.sup.stop();
  });

  it("BACKUP_REMAINS_FOR_SESSION · un corte del respaldo NO hace volver a la principal", async () => {
    const backup = await fakeIngest({ dropAfterPublish: true });
    const dials: string[] = [];
    const c = await control((t) => {
      dials.push(t.host);
      return t.host.startsWith("a.") ? refused() : netConnect({ host: "127.0.0.1", port: backup.port });
    });
    await c.post("/control/start", order("s1"));
    expect(await until(() => backup.seen.published.length >= 3)).toBe(true);
    const after = dials.slice(FAILOVER_AFTER);
    expect(after.length).toBeGreaterThanOrEqual(3);
    expect(after.every((h) => h === "b.rtmps.youtube.com")).toBe(true);
    c.sup.stop();
  });

  it("NEW_SESSION_STARTS_PRIMARY · tras un failover, la sesión siguiente vuelve a empezar por la principal", async () => {
    const backup = await fakeIngest();
    const dials: string[] = [];
    const c = await control((t) => {
      dials.push(t.host);
      return t.host.startsWith("a.") ? refused() : netConnect({ host: "127.0.0.1", port: backup.port });
    });
    await c.post("/control/start", order("s1"));
    expect(await until(() => c.sup.ingestRole === "backup" && c.sup.relayState === "publishing")).toBe(true);
    await c.post("/control/stop", {});
    dials.length = 0;
    await c.post("/control/start", order("s2"));
    expect(await until(() => dials.length > 0)).toBe(true);
    expect(dials[0]).toBe("a.rtmps.youtube.com");
    expect((await c.status()).relay.failedOver).toBe(false);
    c.sup.stop();
  });

  it("NO_FAILOVER_ON_CREDENTIAL · clave rechazada por la principal ⇒ nunca se marca el respaldo", async () => {
    const primary = await fakeIngest({ reject: true });
    const dials: string[] = [];
    const c = await control((t) => {
      dials.push(t.host);
      return netConnect({ host: "127.0.0.1", port: primary.port });
    });
    await c.post("/control/start", order("s1"));
    expect(await until(() => dials.length >= FAILOVER_AFTER + 3)).toBe(true);
    expect(dials.every((h) => h === "a.rtmps.youtube.com")).toBe(true);
    expect(c.sup.ingestRole).toBe("primary");
    c.sup.stop();
  });

  it("el sobre de respaldo sólo abre para la URL de respaldo: cambiado de sitio ⇒ 409 y no sale nada", async () => {
    const ing = await fakeIngest();
    const c = await control(() => netConnect({ host: "127.0.0.1", port: ing.port }));
    const r1 = await c.post(
      "/control/start",
      order("s1", { backupIngestUrl: "rtmps://evil.example/live2", backupCredential: sealedBackup }),
    );
    expect(r1.status).toBe(409);
    const r2 = await c.post("/control/start", order("s1", { backupCredential: sealedPrimary }));
    expect(r2.status).toBe(409);
    const r3 = await c.post("/control/start", order("s1", { backupCredential: null }));
    expect(r3.status).toBe(400);
    const r4 = await c.post(
      "/control/start",
      order("s1", { backupIngestUrl: "rtmps://b.rtmps.youtube.com/live2?x=1" }),
    );
    expect(r4.status).toBe(400);
    await sleep(100);
    expect(ing.seen.published).toEqual([]);
  });

  it("Ronda 1 (H-5) · la principal ACEPTA connect y CIERRA al recibir publish, ×N ⇒ NO hay failover", async () => {
    // `closed_by_server` es un código de failover, pero DESPUÉS de connect es un problema de la
    // publicación (clave o autorización): el respaldo fallaría igual. Lo defiende la guarda
    // `!appConnected` del supervisor. (Test calibrado por la revisión; con `dropAfterPublish`
    // no servía, porque `publishing` resetea la racha.)
    const primary = await fakeIngest({ closeOnPublish: true });
    const dials: string[] = [];
    const c = await control((t) => {
      dials.push(t.host);
      return netConnect({ host: "127.0.0.1", port: primary.port });
    });
    await c.post("/control/start", order("s1"));
    expect(await until(() => dials.length >= FAILOVER_AFTER + 3, 8000)).toBe(true);
    expect(dials.every((h) => h === "a.rtmps.youtube.com")).toBe(true);
    expect(primary.seen.apps.length).toBeGreaterThanOrEqual(FAILOVER_AFTER + 1); // connect sí se aceptó
    expect(c.sup.ingestRole).toBe("primary");
    expect(c.sup.failedOver).toBe(false);
    c.sup.stop();
  });
});

describe("§37 · regresión del caso de producción (vídeo sano, relé connecting, IPv6 sin salida)", () => {
  it("publica por IPv4 y no está «publishing» antes de que la ingesta acepte", async () => {
    const ing = await fakeIngest();
    const tried: number[] = [];
    let releaseV4: (() => void) | null = null;
    const dial = (t: IngestTarget) =>
      dialIngest(
        { ...t, protocol: "rtmp" },
        {
          lookup: async () => [
            { address: "2001:db8::200c", family: 6 },
            { address: "192.0.2.44", family: 4 },
          ],
          tcpConnect: (_a, _p, family) => {
            tried.push(family);
            if (family === 6) {
              const s = new Socket(); // agujero negro: nunca conecta
              sockets.push(s);
              return s;
            }
            // La IPv4 conecta, pero la dejamos «en vuelo» hasta haber comprobado el estado intermedio.
            const s = new Socket();
            releaseV4 = () => {
              const real = netConnect({ host: "127.0.0.1", port: ing.port });
              sockets.push(real);
              real.on("connect", () => {
                s.emit("connect");
              });
              // Puente mínimo: lo que escribe el relé va al socket real y al revés.
              (s as unknown as { write: (b: Buffer) => boolean }).write = (b: Buffer) => real.write(b);
              s.end = (() => real.end()) as never;
              const destroy = s.destroy.bind(s);
              s.destroy = ((e?: Error) => {
                real.destroy();
                return destroy(e);
              }) as never;
              real.on("data", (d) => s.emit("data", d));
              real.on("close", () => s.emit("close"));
            };
            return s;
          },
        },
      );
    const children: FakeChild[] = [];
    const c = await control(dial, children);
    expect(
      (await c.post("/control/start", order("s1", { backupIngestUrl: null, backupCredential: null }))).status,
    ).toBe(200);
    // ffmpeg sano: ~30 FPS y frames que crecen.
    expect(await until(() => children.length >= 2)).toBe(true);
    const ffmpeg = children[children.length - 1];
    for (let f = 30; f <= 150; f += 30) {
      ffmpeg.stdout.emit(
        "data",
        Buffer.from(`frame=${f}\nfps=30.0\nbitrate=4500.0kbits/s\ndrop_frames=0\nprogress=continue\n`),
      );
    }
    await sleep(400); // pasado el escalón de Happy Eyeballs: la IPv4 ya se ha lanzado
    const mid = await c.status();
    expect(mid.state).toBe("streaming");
    expect(mid.stats.frames).toBeGreaterThan(0);
    expect(mid.relay.state).toBe("connecting"); // vídeo sano y relé aún sin publicar
    expect(mid.relay.state).not.toBe("publishing"); // nada de LIVE falso
    expect(tried).toEqual([6, 4]); // la preferida (v6) primero; la v4 a los 250 ms sin esperar a la v6
    releaseV4!();
    expect(await until(() => c.sup.relayState === "publishing")).toBe(true);
    expect(ing.seen.published).toEqual([KEY]);
    expect((await c.status()).relay.ingest).toBe("primary");
    c.sup.stop();
  });
});
