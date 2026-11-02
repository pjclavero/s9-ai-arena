/**
 * EQ5b §3 · Relé RTMP: protocolo contra un servidor RTMP falso (en proceso).
 *
 * Comprueba lo que la ingesta ve: handshake (C1 con digest válido, C2 = S1),
 * `connect` con app/tcUrl correctos, `publish` con la clave como nombre de
 * stream (la clave viaja POR EL PROTOCOLO, dentro de TLS, no por argv), y que
 * cada etiqueta FLV llega como mensaje RTMP con su tipo y su sello de tiempo
 * (metadatos con @setDataFrame delante, como FFmpeg). La interoperabilidad con
 * un servidor real (MediaMTX) y con el FFmpeg de la imagen se verifica en el
 * E2E local (docs/operations/streaming.md).
 */
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAmf0Values, encodeAmf0Values, type Amf0Object } from "./amf0.js";
import {
  ChunkReader,
  encodeMessage,
  MSG_COMMAND_AMF0,
  MSG_SET_CHUNK_SIZE,
  MSG_USER_CONTROL,
  type RtmpMessage,
} from "./chunk.js";
import { FlvReader } from "./flv.js";
import { buildC1, parseIngestUrl, RtmpPublisher } from "./publisher.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

interface FakeOpts {
  rejectPublish?: boolean;
  /** No contesta al handshake (ingesta colgada). */
  mute?: boolean;
  /** Cierra la conexión tras publicar y recibir N mensajes de media. */
  dropAfterMedia?: number;
}

async function fakeIngest(o: FakeOpts = {}) {
  const seen = {
    c1DigestOk: false,
    c2EchoesS1: false,
    commands: [] as { name: string; args: unknown[] }[],
    media: [] as RtmpMessage[],
    sockets: [] as Socket[],
  };
  const server = createServer((sock) => {
    seen.sockets.push(sock);
    sock.on("error", () => {});
    if (o.mute) return;
    let buf = Buffer.alloc(0);
    let phase: "c0c1" | "c2" | "chunks" = "c0c1";
    const s1 = randomBytes(1536);
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
        const c1 = buf.subarray(1, 1537);
        const pos = ((c1[8] + c1[9] + c1[10] + c1[11]) % 728) + 12;
        const h = createHmac("sha256", Buffer.from("Genuine Adobe Flash Player 001", "latin1"));
        h.update(c1.subarray(0, pos));
        h.update(c1.subarray(pos + 32));
        seen.c1DigestOk = h.digest().equals(c1.subarray(pos, pos + 32));
        sock.write(Buffer.concat([Buffer.from([3]), s1, c1]));
        buf = buf.subarray(1537);
        phase = "c2";
      }
      if (phase === "c2") {
        if (buf.length < 1536) return;
        seen.c2EchoesS1 = buf.subarray(0, 1536).equals(s1);
        buf = buf.subarray(1536);
        phase = "chunks";
        // Lo que manda un servidor real tras el handshake.
        const ack = Buffer.alloc(4);
        ack.writeUInt32BE(2_500_000);
        send({ csid: 2, type: 5, streamId: 0, timestamp: 0, payload: ack });
        const ping = Buffer.from([0, 6, 0, 0, 0, 42]);
        send({ csid: 2, type: MSG_USER_CONTROL, streamId: 0, timestamp: 0, payload: ping });
      }
      if (phase === "chunks" && buf.length) {
        const msgs = reader.push(buf);
        buf = Buffer.alloc(0);
        for (const m of msgs) {
          if (m.type === MSG_SET_CHUNK_SIZE) reader.setChunkSize(m.payload.readUInt32BE(0));
          else if (m.type === MSG_COMMAND_AMF0) {
            const v = decodeAmf0Values(m.payload);
            const name = String(v[0]);
            const txn = Number(v[1]);
            seen.commands.push({ name, args: v.slice(2) });
            if (name === "connect")
              reply("_result", txn, [{ fmsVer: "FMS/3,0,1,123" }, { code: "NetConnection.Connect.Success" }]);
            if (name === "createStream") reply("_result", txn, [null, 1]);
            if (name === "publish") {
              const code = o.rejectPublish ? "NetStream.Publish.BadName" : "NetStream.Publish.Start";
              // El servidor repite el nombre del stream en la descripción: el relé debe redactarlo.
              reply(
                "onStatus",
                0,
                [null, { level: o.rejectPublish ? "error" : "status", code, description: `stream ${String(v[3])}` }],
                1,
              );
            }
          } else if (m.type === 8 || m.type === 9 || m.type === 18) {
            seen.media.push(m);
            if (o.dropAfterMedia && seen.media.length >= o.dropAfterMedia) sock.destroy();
          }
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const close = server.close.bind(server);
  server.close = ((cb?: () => void) => {
    seen.sockets.forEach((s) => s.destroy());
    return close(cb);
  }) as typeof server.close;
  return { port, seen };
}

function flvTag(type: number, ts: number, data: Buffer): Buffer {
  const h = Buffer.alloc(11);
  h[0] = type;
  h.writeUIntBE(data.length, 1, 3);
  h.writeUIntBE(ts & 0xffffff, 4, 3);
  h[7] = (ts >>> 24) & 0xff;
  const prev = Buffer.alloc(4);
  prev.writeUInt32BE(11 + data.length);
  return Buffer.concat([h, data, prev]);
}
const FLV_HEADER = Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);
const KEY = "clave-de-prueba-ZZ9-no-real";

function publisherTo(port: number, over: Partial<ConstructorParameters<typeof RtmpPublisher>[0]> = {}) {
  const target = parseIngestUrl(`rtmp://127.0.0.1:${port}/live2`, true);
  return new RtmpPublisher({
    target,
    streamKey: KEY,
    dial: (t) => netConnect({ host: t.host, port: t.port }),
    connectTimeoutMs: 3000,
    ...over,
  });
}

describe("EQ5b · URL de ingesta", () => {
  it("rtmps por defecto 443, app y tcUrl; destino mostrable SIN clave", () => {
    const t = parseIngestUrl("rtmps://a.rtmps.youtube.com/live2");
    expect(t).toMatchObject({ protocol: "rtmps", host: "a.rtmps.youtube.com", port: 443, app: "live2" });
    expect(t.tcUrl).toBe("rtmps://a.rtmps.youtube.com:443/live2");
    expect(t.display).toBe("rtmps://a.rtmps.youtube.com:443/live2/***");
  });

  it("rechaza rtmp:// en claro, credenciales, query, otros esquemas y apps raras", () => {
    expect(() => parseIngestUrl("rtmp://x/live2")).toThrow(/rtmps/);
    expect(() => parseIngestUrl("rtmps://u:p@x/live2")).toThrow(/credenciales/);
    expect(() => parseIngestUrl("rtmps://x/live2?key=1")).toThrow(/query/);
    expect(() => parseIngestUrl("https://x/live2")).toThrow(/rtmps/);
    expect(() => parseIngestUrl("rtmps://x/")).toThrow(/aplicación/);
    expect(() => parseIngestUrl("rtmps://x/a%20b")).toThrow(/aplicación/);
    expect(() => parseIngestUrl("no es una url")).toThrow(/inválida/);
  });
});

describe("EQ5b · handshake", () => {
  it("C1 lleva un digest HMAC-SHA256 válido en la posición del esquema 0", () => {
    for (let i = 0; i < 20; i++) {
      const c1 = buildC1();
      expect(c1.length).toBe(1536);
      const pos = ((c1[8] + c1[9] + c1[10] + c1[11]) % 728) + 12;
      const h = createHmac("sha256", Buffer.from("Genuine Adobe Flash Player 001", "latin1"));
      h.update(c1.subarray(0, pos));
      h.update(c1.subarray(pos + 32));
      expect(h.digest().equals(c1.subarray(pos, pos + 32))).toBe(true);
    }
  });
});

describe("EQ5b · publicación RTMP", () => {
  it("connect + createStream + publish(clave) y las etiquetas FLV llegan como mensajes", async () => {
    const { port, seen } = await fakeIngest();
    const pub = publisherTo(port);
    // ffmpeg empieza a escribir antes de que la ingesta acepte: se encola.
    pub.writeFlv(FLV_HEADER);
    pub.writeFlv(flvTag(18, 0, encodeAmf0Values(["onMetaData", { width: 1920, height: 1080 }])));
    await pub.start();
    expect(pub.state).toBe("publishing");
    const big = randomBytes(20_000); // más que un chunk de salida: troceado y reensamblado
    pub.writeFlv(Buffer.concat([flvTag(9, 33, big), flvTag(8, 40, Buffer.from([0xaf, 1, 2, 3]))]));
    pub.writeFlv(flvTag(9, 0x01000005, Buffer.from([0x27, 1]))); // sello > 24 bits (timestamp extendido)
    await new Promise((r) => setTimeout(r, 200));

    expect(seen.c1DigestOk).toBe(true);
    expect(seen.c2EchoesS1).toBe(true);
    const names = seen.commands.map((c) => c.name);
    expect(names.slice(0, 5)).toEqual(["connect", "releaseStream", "FCPublish", "createStream", "publish"]);
    const connect = seen.commands[0].args[0] as Amf0Object;
    expect(connect.app).toBe("live2");
    expect(connect.tcUrl).toBe(`rtmp://127.0.0.1:${port}/live2`);
    const publish = seen.commands.find((c) => c.name === "publish")!;
    expect(publish.args[1]).toBe(KEY);
    expect(publish.args[2]).toBe("live");

    expect(seen.media.map((m) => [m.type, m.timestamp])).toEqual([
      [18, 0],
      [9, 33],
      [8, 40],
      [9, 0x01000005],
    ]);
    expect(seen.media[1].payload.equals(big)).toBe(true);
    expect(seen.media.every((m) => m.streamId === 1)).toBe(true);
    const meta = decodeAmf0Values(seen.media[0].payload);
    expect(meta[0]).toBe("@setDataFrame");
    expect(meta[1]).toBe("onMetaData");
    pub.close();
  });

  it("publicación rechazada: error SIN la clave (el servidor la repite en la descripción)", async () => {
    const { port } = await fakeIngest({ rejectPublish: true });
    const pub = publisherTo(port);
    const err = await pub.start().then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/BadName/);
    expect(err!.message).not.toContain(KEY);
    expect(err!.message).toContain("***");
  });

  it("ingesta muda: timeout claro y conexión cerrada", async () => {
    const { port } = await fakeIngest({ mute: true });
    const pub = publisherTo(port, { connectTimeoutMs: 300 });
    await expect(pub.start()).rejects.toThrow(/no respondió/);
    expect(pub.state).toBe("closed");
  });

  it("corte de la ingesta en plena emisión ⇒ evento 'error' (el supervisor reintenta)", async () => {
    const { port } = await fakeIngest({ dropAfterMedia: 2 });
    const pub = publisherTo(port);
    const errors: Error[] = [];
    pub.on("error", (e) => errors.push(e));
    pub.writeFlv(FLV_HEADER);
    await pub.start();
    for (let i = 0; i < 5; i++) pub.writeFlv(flvTag(9, i * 33, Buffer.from([0x17, 0, 0, 0, i])));
    await new Promise((r) => setTimeout(r, 300));
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/cerró la conexión|fallida/);
    expect(pub.state).toBe("closed");
  });

  it("probe: handshake + connect y cierra SIN publicar (no hay stream en la plataforma)", async () => {
    const { port, seen } = await fakeIngest();
    const pub = publisherTo(port);
    const r = await pub.probe();
    expect(r.tlsVerified).toBe(false); // rtmp de prueba; con rtmps es true
    await new Promise((res) => setTimeout(res, 100));
    expect(seen.commands.map((c) => c.name)).toEqual(["connect"]);
    expect(pub.state).toBe("closed");
  });
});

describe("EQ5b · FLV y chunks", () => {
  it("FlvReader trocea etiquetas aunque lleguen byte a byte", () => {
    const r = new FlvReader();
    const all = Buffer.concat([FLV_HEADER, flvTag(9, 1, Buffer.from("abc")), flvTag(8, 2, Buffer.from("de"))]);
    const tags = [];
    for (const b of all) tags.push(...r.push(Buffer.from([b])));
    expect(tags.map((t) => [t.type, t.timestamp, t.data.toString()])).toEqual([
      [9, 1, "abc"],
      [8, 2, "de"],
    ]);
    expect(() => new FlvReader().push(Buffer.from("NOPE-NOPE-NOPE"))).toThrow(/FLV/);
  });

  it("ChunkReader reensambla los cuatro tipos de cabecera y rechaza mensajes enormes", () => {
    const r = new ChunkReader();
    const m1 = encodeMessage({ csid: 3, type: 20, streamId: 0, timestamp: 10, payload: Buffer.alloc(300, 1) }, 128);
    expect(r.push(m1)).toHaveLength(1);
    // tipo 2 (sólo delta) sobre el mismo csid
    const fmt2 = Buffer.concat([Buffer.from([(2 << 6) | 3, 0, 0, 5]), Buffer.alloc(300, 2).subarray(0, 128)]);
    expect(r.push(fmt2)).toHaveLength(0);
    const rest = Buffer.concat([
      Buffer.from([(3 << 6) | 3]),
      Buffer.alloc(128, 2),
      Buffer.from([(3 << 6) | 3]),
      Buffer.alloc(44, 2),
    ]);
    const out = r.push(rest);
    expect(out).toHaveLength(1);
    expect(out[0].timestamp).toBe(15);
    expect(out[0].payload.length).toBe(300);
    const huge = Buffer.from([3, 0, 0, 0, 0x20, 0, 0, 20, 0, 0, 0, 0]);
    expect(() => new ChunkReader().push(huge)).toThrow(/demasiado grande/);
  });

  it("AMF0 decodifica sin prototipo (un __proto__ remoto no contamina)", () => {
    const v = decodeAmf0Values(encodeAmf0Values([{ ["__proto__"]: "x", code: "ok" } as never]));
    const o = v[0] as Record<string, unknown>;
    expect(Object.getPrototypeOf(o)).toBeNull();
    expect(o.code).toBe("ok");
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});
