/**
 * STREAMING-UX · §27 / §45 · Regresión del caso de producción: el streamer
 * pinta bien (unos 30 FPS y frames que crecen), pero el relé se queda en
 * `connecting` y acaba con «la ingesta no respondió a connect a tiempo».
 *
 * Hay dos causas, y cada una tiene aquí su prueba (cada prueba se pone roja con
 * su mutante; ver docs/operations/streaming.md):
 *  1. EL ID DE TRANSACCIÓN DE `connect`. La ingesta de YouTube NO calla: contesta
 *     a CUALQUIER `connect` (txn 0, 1, 2, 3…) con un `_result` que lleva SIEMPRE el
 *     txn 1. Medido desde un host de pruebas contra la ingesta real (sólo TLS,
 *     handshake y connect, sin clave y sin publicar; ronda 1 de revisión). El relé
 *     antiguo mandaba connect con txn 2 y esperaba la respuesta en `pending.get(2)`:
 *     la de txn 1 se descartaba y vencía el plazo. El servidor falso
 *     `replyTxn: "always1"` se porta como YouTube de verdad; `replyTxn: "never"` es
 *     una ingesta genérica que no contesta (el SÍNTOMA de producción, no YouTube).
 *  2. LA FAMILIA DE DIRECCIONES. El DNS del contenedor devolvía la AAAA primero
 *     y el host no tenía ruta IPv6. El marcado es Happy Eyeballs (RFC 8305):
 *     respeta el orden del DNS, intercala las familias y lanza el siguiente
 *     intento a los 250 ms sin cancelar el anterior (no hay «IPv4 siempre
 *     primero»). Aquí el DNS devuelve una AAAA que nunca conecta (agujero negro)
 *     o que no tiene ruta, y una A que sí: el relé tiene que llegar por IPv4 sin
 *     quedarse esperando a la IPv6, con el TLS verificado contra el NOMBRE.
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

/**
 * Ingesta RTMP falsa sobre un socket ya aceptado. Respuesta a `connect` según `replyTxn`:
 *  - `"echo"` (por defecto): con el MISMO txn de la petición (MediaMTX, nginx-rtmp);
 *  - `"always1"`: con txn 1 SIEMPRE, pida lo que pida el cliente (YouTube, medido);
 *  - `"never"`: no contesta nunca (síntoma de producción: el relé se queda en connect).
 */
type ReplyTxn = "echo" | "always1" | "never";
function serveRtmp(sock: Socket | TLSSocket, o: { replyTxn?: ReplyTxn }, seen: { connectTxn: number[]; sni?: string }) {
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
            const mode = o.replyTxn ?? "echo";
            if (mode === "never") continue;
            const txn = mode === "always1" ? 1 : Number(v[1]);
            reply("_result", txn, [{ fmsVer: "FMS/3,0,1,123" }, { code: "NetConnection.Connect.Success" }]);
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
  it("modo YouTube REAL (contesta siempre con txn 1): la prueba de ingesta conecta", async () => {
    const seen = { connectTxn: [] as number[] };
    const port = await listen(netServer((s) => serveRtmp(s, { replyTxn: "always1" }, seen)));
    const target = parseIngestUrl(`rtmp://127.0.0.1:${port}/live2`, true);
    const pub = new RtmpPublisher({ target, streamKey: "clave-de-prueba-0000", connectTimeoutMs: 1500 });
    const r = await pub.probe();
    expect(r.connectMs).toBeGreaterThanOrEqual(0);
    expect(seen.connectTxn).toEqual([1]);
  });

  it("modo YouTube REAL: el relé ANTIGUO (connect con txn 2) recibe un _result txn 1 que no espera ⇒ timeout", async () => {
    // Control del modelo: así fallaba producción. La ingesta SÍ contesta (txn 1), pero el
    // relé antiguo esperaba la respuesta 2 y la descartaba.
    const seen = { connectTxn: [] as number[] };
    const port = await listen(netServer((s) => serveRtmp(s, { replyTxn: "always1" }, seen)));
    const target = parseIngestUrl(`rtmp://127.0.0.1:${port}/live2`, true);
    const pub = new RtmpPublisher({ target, streamKey: "clave-de-prueba-0000", connectTimeoutMs: 400 });
    (pub as unknown as { txn: number }).txn = 1; // el siguiente id será el 2, como en el relé antiguo
    await expect(pub.probe()).rejects.toMatchObject({ code: "timeout" });
    expect(seen.connectTxn).toEqual([2]); // llegó, y la ingesta contestó: no «calló»
  });

  it("caso de producción: sin respuesta a connect ⇒ error claro y nunca 'publishing'", async () => {
    // Síntoma de producción: ingesta que completa el handshake y no contesta NUNCA a connect.
    const seen = { connectTxn: [] as number[] };
    const port = await listen(netServer((s) => serveRtmp(s, { replyTxn: "never" }, seen)));
    const target = parseIngestUrl(`rtmp://127.0.0.1:${port}/live2`, true);
    const pub = new RtmpPublisher({ target, streamKey: "clave-de-prueba-0000", connectTimeoutMs: 300 });
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

/**
 * Red simulada: la familia 6 o es un agujero negro (el SYN se pierde y el socket
 * NO conecta nunca, como en el contenedor de producción) o no tiene ruta
 * (ENETUNREACH inmediato). La familia 4 llega de verdad a la ingesta local.
 */
function fakeNet(port: number, v6: "blackhole" | "unreachable") {
  const tried: number[] = [];
  const v6Sockets: Socket[] = [];
  const tcp = (_address: string, p: number, family: number) => {
    tried.push(family);
    if (family === 6) {
      const s = new Socket(); // nunca emite 'connect'
      v6Sockets.push(s);
      if (v6 === "unreachable") {
        setImmediate(() => s.emit("error", Object.assign(new Error("ENETUNREACH"), { code: "ENETUNREACH" })));
      }
      return s;
    }
    return netConnect({ host: "127.0.0.1", port: p === 443 ? port : p });
  };
  return { tcp, tried, v6Sockets };
}

/** DNS como el del contenedor: la AAAA PRIMERO, luego la A. */
const lookupV6First = async () => [
  { address: "2001:db8::200c", family: 6 },
  { address: "192.0.2.44", family: 4 },
];

async function tlsIngest() {
  const seen = { connectTxn: [] as number[], sni: undefined as string | undefined };
  const srv = tlsServer({ cert, key }, (s) => {
    seen.sni = (s as TLSSocket & { servername?: string }).servername || undefined;
    serveRtmp(s, { replyTxn: "always1" }, seen); // como YouTube de verdad
  });
  return { port: await listen(srv), seen };
}

describe("§27 (2) · Happy Eyeballs: DNS con AAAA inalcanzable primero y A alcanzable", () => {
  it("orden RFC 8305: se respeta la preferencia del DNS y se intercalan familias (NO «IPv4 siempre primero»)", () => {
    const v6 = (n: number) => ({ address: `2001:db8::${n}`, family: 6 });
    const v4 = (n: number) => ({ address: `192.0.2.${n}`, family: 4 });
    expect(dialOrder([v6(1), v6(2), v4(1)]).map((a) => a.address)).toEqual(["2001:db8::1", "192.0.2.1", "2001:db8::2"]);
    expect(dialOrder([v4(1), v6(1)]).map((a) => a.family)).toEqual([4, 6]);
    expect(dialOrder([v6(1), v4(1)]).map((a) => a.family)).toEqual([6, 4]);
  });

  it("IPV6_UNROUTABLE_IPV4_WORKS · IPv6 sin ruta (ENETUNREACH) ⇒ conecta por IPv4 sin esperar al escalón", async () => {
    const { port, seen } = await tlsIngest();
    const net = fakeNet(port, "unreachable");
    const t0 = Date.now();
    const pub = new RtmpPublisher({
      target: parseIngestUrl("rtmps://ingest.test/live2"),
      streamKey: "clave-de-prueba-0000",
      connectTimeoutMs: 3000,
      dial: (t) => dialIngest(t, { lookup: lookupV6First, tcpConnect: net.tcp, attemptDelayMs: 2000, tls: { ca } }),
    });
    await pub.probe();
    expect(net.tried).toEqual([6, 4]); // v6 primero (preferencia del DNS), v4 nada más fallar
    expect(Date.now() - t0).toBeLessThan(1500); // no esperó el escalón de 2 s
    expect(seen.connectTxn).toEqual([1]);
  });

  it("HAPPY_EYEBALLS_CONNECTS_IPV4 · IPv6 agujero negro: gana la IPv4, TLS verificado contra el NOMBRE, la IPv6 se cancela", async () => {
    const { port, seen } = await tlsIngest();
    const net = fakeNet(port, "blackhole");
    const pub = new RtmpPublisher({
      target: parseIngestUrl("rtmps://ingest.test/live2"),
      streamKey: "clave-de-prueba-0000",
      connectTimeoutMs: 3000,
      dial: (t) => dialIngest(t, { lookup: lookupV6First, tcpConnect: net.tcp, tls: { ca } }),
    });
    const r = await pub.probe();
    expect(r.tlsVerified).toBe(true);
    expect(net.tried).toEqual([6, 4]);
    expect(seen.sni).toBe("ingest.test");
    expect(seen.connectTxn).toEqual([1]);
    expect(net.v6Sockets.every((s) => s.destroyed)).toBe(true); // la perdedora no queda colgada
  });

  it("NO_LONG_IPV6_STALL · la IPv6 colgada cuesta un escalón (250 ms), no su plazo entero (5 s)", async () => {
    const { port } = await tlsIngest();
    const net = fakeNet(port, "blackhole");
    const t0 = Date.now();
    const sock = await dialIngest(parseIngestUrl("rtmps://ingest.test/live2"), {
      lookup: lookupV6First,
      tcpConnect: net.tcp,
      attemptTimeoutMs: 5000,
      tls: { ca },
    });
    await new Promise<void>((resolve, reject) => {
      sock.once("secureConnect", () => resolve());
      sock.once("error", reject);
    });
    const ms = Date.now() - t0;
    sock.destroy();
    expect(ms).toBeGreaterThanOrEqual(200); // sí se dio su oportunidad a la IPv6 preferida
    expect(ms).toBeLessThan(1500); // y no se esperó a su plazo de 5 s
  });

  it("si sólo hay AAAA muerta: falla por plazo de intento, con el motivo por familia", async () => {
    const net = fakeNet(1, "blackhole");
    await expect(
      dialIngest(parseIngestUrl("rtmps://ingest.test/live2"), {
        lookup: async () => [{ address: "2001:db8::1", family: 6 }],
        tcpConnect: net.tcp,
        attemptTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "timeout", message: expect.stringContaining("IPv6: ETIMEDOUT") });
  });

  it("el TLS sigue verificando: un certificado de otro nombre se rechaza aunque la IP conecte", async () => {
    const srv = tlsServer({ cert, key }, (s) => s.on("error", () => {}));
    const port = await listen(srv);
    const net = fakeNet(port, "blackhole");
    const pub = new RtmpPublisher({
      target: parseIngestUrl("rtmps://otro-nombre.test/live2"),
      streamKey: "clave-de-prueba-0000",
      connectTimeoutMs: 2500,
      dial: (t) => dialIngest(t, { lookup: lookupV6First, tcpConnect: net.tcp, tls: { ca } }),
    });
    await expect(pub.probe()).rejects.toMatchObject({ code: "tls" });
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
