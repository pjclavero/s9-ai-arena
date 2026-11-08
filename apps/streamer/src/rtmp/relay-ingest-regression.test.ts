/**
 * STREAMING-UX · §27 / §45 · Regresión del caso de producción: el streamer
 * pinta bien (unos 30 FPS y frames que crecen), pero el relé se queda en
 * `connecting` y acaba con «la ingesta no respondió a connect a tiempo».
 *
 * Hay dos causas, y cada una tiene aquí su prueba (cada prueba se pone roja con
 * su mutante; ver docs/operations/streaming.md):
 *  1. EL ID DE TRANSACCIÓN DE `connect`. La ingesta de YouTube ignora en
 *     silencio un `connect` cuyo id no es 1. Se reprodujo desde un host de
 *     pruebas contra la ingesta real (sólo TLS, handshake y connect, sin clave y
 *     sin publicar). El relé mandaba un 2. El servidor falso `strictTxn` se porta
 *     como YouTube: calla.
 *  2. LA FAMILIA DE DIRECCIONES. El DNS del contenedor devolvía la AAAA primero
 *     y el host no tenía ruta IPv6. El marcado prueba antes las IPv4 y pone un
 *     plazo a cada intento. Aquí el DNS devuelve una AAAA que nunca conecta (un
 *     agujero negro) y una A que sí: el relé tiene que llegar por IPv4, con el TLS
 *     verificado contra el NOMBRE.
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as netServer, Socket, connect as netConnect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as tlsServer, type TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeAmf0Values, encodeAmf0Values } from "./amf0.js";
import { ChunkReader, encodeMessage, MSG_COMMAND_AMF0, MSG_SET_CHUNK_SIZE, type RtmpMessage } from "./chunk.js";
import { dialIngest, dialOrder } from "./dial.js";
import { parseIngestUrl, RtmpPublisher } from "./publisher.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** Ingesta RTMP falsa sobre un socket ya aceptado. `strictTxn`: como YouTube, calla si connect no lleva txn 1. */
function serveRtmp(sock: Socket | TLSSocket, o: { strictTxn?: boolean }, seen: { connectTxn: number[]; sni?: string }) {
  sock.on("error", () => {});
  let buf = Buffer.alloc(0);
  let phase: "c0c1" | "c2" | "chunks" = "c0c1";
  const s1 = randomBytes(1536);
  const reader = new ChunkReader();
  const reply = (name: string, txn: number, args: unknown[]) =>
    sock.write(
      encodeMessage(
        {
          csid: 3,
          type: MSG_COMMAND_AMF0,
          streamId: 0,
          timestamp: 0,
          payload: encodeAmf0Values([name, txn, ...(args as never[])]),
        },
        128,
      ),
    );
  sock.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    if (phase === "c0c1") {
      if (buf.length < 1537) return;
      const c1 = buf.subarray(1, 1537);
      const pos = ((c1[8] + c1[9] + c1[10] + c1[11]) % 728) + 12;
      const h = createHmac("sha256", Buffer.from("Genuine Adobe Flash Player 001", "latin1"));
      h.update(c1.subarray(0, pos));
      h.update(c1.subarray(pos + 32));
      sock.write(Buffer.concat([Buffer.from([3]), s1, c1]));
      buf = buf.subarray(1537);
      phase = "c2";
    }
    if (phase === "c2") {
      if (buf.length < 1536) return;
      buf = buf.subarray(1536);
      phase = "chunks";
    }
    if (phase === "chunks" && buf.length) {
      const msgs: RtmpMessage[] = reader.push(buf);
      buf = Buffer.alloc(0);
      for (const m of msgs) {
        if (m.type === MSG_SET_CHUNK_SIZE) reader.setChunkSize(m.payload.readUInt32BE(0));
        else if (m.type === MSG_COMMAND_AMF0) {
          const v = decodeAmf0Values(m.payload);
          if (String(v[0]) === "connect") {
            seen.connectTxn.push(Number(v[1]));
            if (o.strictTxn && Number(v[1]) !== 1) continue; // YouTube: silencio
            reply("_result", Number(v[1]), [{ fmsVer: "FMS/3,0,1,123" }, { code: "NetConnection.Connect.Success" }]);
          }
        }
      }
    }
  });
}

async function listen(s: Server): Promise<number> {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as { port: number }).port;
}

describe("§27 (1) · connect con id de transacción 1 (como FFmpeg/OBS/librtmp)", () => {
  it("una ingesta estricta como YouTube responde: la prueba de ingesta conecta", async () => {
    const seen = { connectTxn: [] as number[] };
    const port = await listen(netServer((s) => serveRtmp(s, { strictTxn: true }, seen)));
    const target = parseIngestUrl(`rtmp://127.0.0.1:${port}/live2`, true);
    const pub = new RtmpPublisher({ target, streamKey: "clave-de-prueba-0000", connectTimeoutMs: 1500 });
    const r = await pub.probe();
    expect(r.connectMs).toBeGreaterThanOrEqual(0);
    expect(seen.connectTxn).toEqual([1]);
  });

  it("caso de producción: sin respuesta a connect ⇒ error claro y nunca 'publishing'", async () => {
    // Ingesta que completa el handshake y no contesta NUNCA a connect.
    const seen = { connectTxn: [] as number[] };
    const port = await listen(netServer((s) => serveRtmp(s, { strictTxn: true }, seen)));
    const target = parseIngestUrl(`rtmp://127.0.0.1:${port}/live2`, true);
    const pub = new RtmpPublisher({ target, streamKey: "clave-de-prueba-0000", connectTimeoutMs: 300 });
    // Forzamos un txn distinto de 1 para reproducir lo que hacía el relé antiguo.
    (pub as unknown as { txn: number }).txn = 1;
    const states: string[] = [];
    pub.on("publishing", () => states.push("publishing"));
    pub.on("error", () => {});
    await expect(pub.start()).rejects.toMatchObject({ code: "timeout" });
    expect(states).toEqual([]);
    expect(pub.state).toBe("closed");
  });
});

// ── (2) familia de direcciones ──────────────────────────────────────────────
let certDir = "";
let ca = "";
let cert = "";
let key = "";
beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), "s9-relay-ipv4-"));
  const sh = (args: string[]) => execFileSync("openssl", args, { cwd: certDir, stdio: "ignore" });
  sh([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "2",
    "-subj",
    "/CN=s9-test-ca",
  ]);
  sh(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=ingest.test"]);
  writeFileSync(join(certDir, "ext.cnf"), "subjectAltName=DNS:ingest.test\n");
  sh([
    "x509",
    "-req",
    "-in",
    "srv.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "srv.pem",
    "-days",
    "2",
    "-extfile",
    "ext.cnf",
  ]);
  ca = readFileSync(join(certDir, "ca.pem"), "utf8");
  cert = readFileSync(join(certDir, "srv.pem"), "utf8");
  key = readFileSync(join(certDir, "srv.key"), "utf8");
});
afterAll(() => rmSync(certDir, { recursive: true, force: true }));

/** TCP hacia una IPv6 sin ruta: el SYN se pierde y el socket NO conecta nunca (como en VM108). */
function blackholeOr(port: number) {
  const tried: number[] = [];
  const sockets: Socket[] = [];
  const tcp = (address: string, p: number, family: number) => {
    tried.push(family);
    if (family === 6) {
      const s = new Socket(); // nunca emite 'connect'
      sockets.push(s);
      return s;
    }
    return netConnect({ host: "127.0.0.1", port: p === 443 ? port : p });
  };
  return { tcp, tried, sockets };
}

describe("§27 (2) · DNS con AAAA inalcanzable primero y A alcanzable", () => {
  const lookup = async () => [
    { address: "2001:db8::200c", family: 6 },
    { address: "192.0.2.44", family: 4 },
  ];

  it("orden de marcado: IPv4 antes que IPv6", () => {
    expect(
      dialOrder([
        { address: "2001:db8::1", family: 6 },
        { address: "192.0.2.1", family: 4 },
      ]).map((a) => a.family),
    ).toEqual([4, 6]);
  });

  it("el relé llega por IPv4, verifica el certificado contra el NOMBRE y conecta", async () => {
    const seen = { connectTxn: [] as number[], sni: undefined as string | undefined };
    const srv = tlsServer({ cert, key }, (s) => {
      seen.sni = (s as TLSSocket & { servername?: string }).servername || undefined;
      serveRtmp(s, { strictTxn: true }, seen);
    });
    const port = await listen(srv);
    const net = blackholeOr(port);
    const target = parseIngestUrl("rtmps://ingest.test/live2");
    const pub = new RtmpPublisher({
      target,
      streamKey: "clave-de-prueba-0000",
      // El plazo TOTAL es corto a propósito: sólo cabe si no se espera a la IPv6.
      connectTimeoutMs: 2500,
      dial: (t) => dialIngest(t, { lookup, tcpConnect: net.tcp, attemptTimeoutMs: 1000, tls: { ca } }),
    });
    const r = await pub.probe();
    expect(r.tlsVerified).toBe(true);
    expect(net.tried[0]).toBe(4); // la primera dirección marcada es la IPv4
    expect(seen.sni).toBe("ingest.test");
    expect(seen.connectTxn).toEqual([1]);
    net.sockets.forEach((s) => s.destroy());
  });

  it("si sólo hay AAAA muerta: falla por plazo de intento, con el motivo por familia", async () => {
    const net = blackholeOr(1);
    const t = parseIngestUrl("rtmps://ingest.test/live2");
    await expect(
      dialIngest(t, {
        lookup: async () => [{ address: "2001:db8::1", family: 6 }],
        tcpConnect: net.tcp,
        attemptTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "timeout", message: expect.stringContaining("IPv6: ETIMEDOUT") });
  });

  it("el TLS sigue verificando: un certificado de otro nombre se rechaza aunque la IP conecte", async () => {
    const srv = tlsServer({ cert, key }, (s) => s.on("error", () => {}));
    const port = await listen(srv);
    const net = blackholeOr(port);
    const target = parseIngestUrl("rtmps://otro-nombre.test/live2");
    const pub = new RtmpPublisher({
      target,
      streamKey: "clave-de-prueba-0000",
      connectTimeoutMs: 2500,
      dial: (t) => dialIngest(t, { lookup, tcpConnect: net.tcp, attemptTimeoutMs: 500, tls: { ca } }),
    });
    await expect(pub.probe()).rejects.toMatchObject({ code: "tls" });
    net.sockets.forEach((s) => s.destroy());
  });
});

describe("§20 · URL de respaldo de YouTube en el relé", () => {
  it("?backup=1 forma parte de la aplicación (como librtmp/OBS); otra query se rechaza", () => {
    const t = parseIngestUrl("rtmps://b.rtmps.youtube.com/live2?backup=1");
    expect(t.app).toBe("live2?backup=1");
    expect(t.tcUrl).toBe("rtmps://b.rtmps.youtube.com:443/live2?backup=1");
    expect(t.display).toBe("rtmps://b.rtmps.youtube.com:443/live2?backup=1/***");
    expect(() => parseIngestUrl("rtmps://b.rtmps.youtube.com/live2?backup=2")).toThrow(/query/);
    expect(() => parseIngestUrl("rtmps://b.rtmps.youtube.com/live2?backup=1&x=1")).toThrow(/query/);
    expect(() => parseIngestUrl("rtmps://b.rtmps.youtube.com/live2?x=1")).toThrow(/query/);
  });
});
