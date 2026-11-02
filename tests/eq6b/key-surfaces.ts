/**
 * EQ6b · Auditoría INDEPENDIENTE de superficies de la clave y de la verificación
 * TLS del relé, con procesos REALES (no contenedores):
 *   streamer real (apps/streamer/src/main.ts) + ffmpeg real (testsrc → FLV por fd 3)
 *   + ingesta RTMPS falsa con TLS real (certificado de prueba con SAN IP:127.0.0.1).
 *
 * Uso:  EQ6B_DIR=<dir 0700 bajo $CLAUDE_JOB_DIR/tmp> npx tsx tests/eq6b/key-surfaces.ts
 * Todo lo sensible (clave de prueba, privada RSA, secreto de control, clave TLS)
 * se crea en EQ6B_DIR con modo 0600 y NUNCA se imprime ni va en argv.
 * Salida: tabla «superficie | apariciones» y veredicto; rc ≠ 0 si algo falla.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { decodeAmf0Values, encodeAmf0Values } from "../../apps/streamer/src/rtmp/amf0.js";
import { ChunkReader, encodeMessage, MSG_COMMAND_AMF0, type RtmpMessage } from "../../apps/streamer/src/rtmp/chunk.js";
import { sealSecret } from "../../packages/stream-secrets/index.js";

if (!process.env.EQ6B_DIR) throw new Error("EQ6B_DIR obligatorio");
mkdirSync(process.env.EQ6B_DIR, { recursive: true, mode: 0o700 });
// Directorio nuevo por ejecución (los secretos quedan 0400 y no se reescriben).
const DIR = mkdtempSync(join(process.env.EQ6B_DIR, "run-"));
const w = (name: string, data: string, mode = 0o600) => {
  const f = join(DIR, name);
  writeFileSync(f, data, { mode });
  chmodSync(f, mode);
  return f;
};

// ── material de prueba ──────────────────────────────────────────────────────
const KEY = `eq6b-${randomBytes(16).toString("hex")}`;
const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const privFile = w("stream_secrets_private.pem", PRIV, 0o400);
const ctlSecret = randomBytes(24).toString("hex");
const ctlFile = w("streamer_control_secret.txt", ctlSecret, 0o400);
const tlsKey = join(DIR, "tls.key");
const tlsCrt = join(DIR, "tls.crt");
if (!existsSync(tlsCrt)) {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", tlsKey, "-out", tlsCrt, "-days", "1", "-subj", "/CN=ingest.eq6b.test", "-addext", "subjectAltName=IP:127.0.0.1,DNS:ingest.eq6b.test"], { stdio: "ignore" });
  chmodSync(tlsKey, 0o600);
}
const ffmpegWrapper = w(
  "ffmpeg-wrapper.sh",
  `#!/bin/sh\n# ignora el argv del streamer (sin X11): misma salida FLV por el fd 3\nexec ffmpeg -hide_banner -nostats -loglevel error -progress pipe:1 -re -f lavfi -i testsrc=size=320x240:rate=30 -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v libx264 -preset ultrafast -g 60 -c:a aac -f flv pipe:3\n`,
  0o700,
);
const chromiumWrapper = w("chromium-wrapper.sh", "#!/bin/sh\nexec sleep 600\n", 0o700);

// ── ingesta RTMPS falsa (TLS real) ─────────────────────────────────────────
interface Ingest {
  port: number;
  published: string[];
  media: number;
  close(): void;
}
function ingest(o: { rejectWithKeyEcho?: boolean } = {}): Promise<Ingest> {
  const st: Ingest = { port: 0, published: [], media: 0, close: () => srv.close() };
  const socks: TLSSocket[] = [];
  const srv = createTlsServer({ key: readFileSync(tlsKey), cert: readFileSync(tlsCrt) }, (sock) => {
    socks.push(sock);
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    let phase = 0;
    const s1 = randomBytes(1536);
    const reader = new ChunkReader();
    const send = (m: RtmpMessage) => sock.write(encodeMessage(m, 128));
    const reply = (name: string, txn: number, args: unknown[], sid = 0) =>
      send({ csid: 3, type: MSG_COMMAND_AMF0, streamId: sid, timestamp: 0, payload: encodeAmf0Values([name, txn, ...(args as never[])]) });
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (phase === 0 && buf.length >= 1537) {
        sock.write(Buffer.concat([Buffer.from([3]), s1, buf.subarray(1, 1537)]));
        buf = buf.subarray(1537);
        phase = 1;
      }
      if (phase === 1 && buf.length >= 1536) {
        buf = buf.subarray(1536);
        phase = 2;
      }
      if (phase === 2 && buf.length) {
        const msgs = reader.push(buf);
        buf = Buffer.alloc(0);
        for (const m of msgs) {
          if (m.type === 8 || m.type === 9) st.media++;
          if (m.type !== MSG_COMMAND_AMF0) continue;
          const v = decodeAmf0Values(m.payload);
          const name = String(v[0]);
          const txn = Number(v[1]);
          if (name === "connect") reply("_result", txn, [{}, { code: "NetConnection.Connect.Success" }]);
          if (name === "createStream") reply("_result", txn, [null, 1]);
          if (name === "publish") {
            const k = String(v[3]);
            st.published.push(k);
            if (o.rejectWithKeyEcho) {
              // Servidor hostil/mal hecho: repite la clave en code Y description, también URL-codificada.
              reply("onStatus", 0, [null, { level: "error", code: `NetStream.Publish.BadName.${k}`, description: `bad ${k} ${encodeURIComponent(k)} ${k.toUpperCase()}` }], 1);
            } else reply("onStatus", 0, [null, { level: "status", code: "NetStream.Publish.Start", description: "ok" }], 1);
          }
        }
      }
    });
  });
  st.close = () => {
    for (const s of socks) s.destroy();
    srv.close();
  };
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => ((st.port = (srv.address() as AddressInfo).port), r(st))));
}

// ── streamer real ───────────────────────────────────────────────────────────
interface Streamer {
  proc: ChildProcess;
  base: string;
  logs: () => string;
}
async function streamer(o: { trustCa: boolean }): Promise<Streamer> {
  const port = 21000 + Math.floor(Math.random() * 20000);
  let out = "";
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: DIR!,
    STREAMER_CONTROL_PORT: String(port),
    STREAMER_CONTROL_SECRET_FILE: ctlFile,
    STREAM_SECRETS_PRIVATE_KEY_FILE: privFile,
    FFMPEG_BIN: ffmpegWrapper,
    CHROMIUM_BIN: chromiumWrapper,
    STREAM_RETRY_DELAY_MS: "500",
    STREAM_MAX_RETRIES: "3",
    BROADCAST_URL: "http://127.0.0.1:1/broadcast",
  };
  if (o.trustCa) env.NODE_EXTRA_CA_CERTS = tlsCrt;
  const proc = spawn(process.execPath, ["--import", "tsx", "apps/streamer/src/main.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/healthz`);
      return { proc, base, logs: () => out };
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("el streamer no arrancó");
}
const H = { "content-type": "application/json", "x-streamer-auth": ctlSecret };
const post = (s: Streamer, p: string, body: unknown) => fetch(`${s.base}${p}`, { method: "POST", headers: H, body: JSON.stringify(body) });
const get = async (s: Streamer, p: string) => (await fetch(`${s.base}${p}`, { headers: H })).text();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function scanProc(needles: string[]): { cmdline: number; environ: number; readable: number } {
  let cmdline = 0;
  let environ = 0;
  let readable = 0;
  for (const pid of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    for (const f of ["cmdline", "environ"] as const) {
      try {
        const t = readFileSync(`/proc/${pid}/${f}`, "latin1");
        readable++;
        if (needles.some((n) => t.includes(n))) f === "cmdline" ? cmdline++ : environ++;
      } catch {
        /* procesos de otros usuarios */
      }
    }
  }
  return { cmdline, environ, readable };
}

async function main() {
  const rows: [string, number | string][] = [];
  let fail = 0;
  const count = (t: string) => (t.split(KEY).length - 1) + (t.split(encodeURIComponent(KEY)).length - 1) + (t.split(KEY.toUpperCase()).length - 1);
  const sealed = sealSecret(KEY, PUB);
  // Todas las formas en que podría aparecer la clave.
  const needles = [KEY, KEY.toUpperCase(), Buffer.from(KEY).toString("base64").slice(0, 24)];

  // 1) Emisión real con CA de confianza: la clave llega a la ingesta y a ningún otro sitio.
  const ok = await ingest();
  const s = await streamer({ trustCa: true });
  const start = await post(s, "/control/start", { sessionId: "eq6b-1", mode: "rtmps", ingestUrl: `rtmps://127.0.0.1:${ok.port}/live2`, credential: sealed });
  rows.push(["/control/start status", start.status]);
  for (let i = 0; i < 60 && ok.media < 30; i++) await sleep(200);
  rows.push(["ingesta: publish con la clave (destino legítimo)", ok.published.filter((k) => k === KEY).length]);
  rows.push(["ingesta: mensajes de media recibidos", ok.media]);
  if (!ok.published.includes(KEY) || ok.media < 30) fail++;
  const p = scanProc(needles);
  rows.push([`/proc/*/cmdline legibles (${p.readable} ficheros)`, p.cmdline]);
  rows.push(["/proc/*/environ legibles", p.environ]);
  if (p.cmdline || p.environ) fail++;
  let psOut = "";
  try {
    psOut = execFileSync("ps", ["-eo", "args"], { encoding: "latin1" });
  } catch {}
  rows.push(["ps -eo args", count(psOut)]);
  for (const path of ["/status", "/metrics", "/healthz", "/version", "/recordings"]) {
    const t = await get(s, path);
    rows.push([`GET ${path}`, count(t)]);
    if (count(t)) fail++;
  }
  await post(s, "/control/stop", {});
  ok.close();

  // 2) Servidor que REPITE la clave en el rechazo: ¿se redacta en /status y logs?
  const evil = await ingest({ rejectWithKeyEcho: true });
  await post(s, "/control/start", { sessionId: "eq6b-2", mode: "rtmps", ingestUrl: `rtmps://127.0.0.1:${evil.port}/live2`, credential: sealed, replace: true });
  await sleep(2500);
  const st2 = await get(s, "/status");
  rows.push(["rechazo con eco de la clave: GET /status", count(st2)]);
  if (count(st2)) fail++;
  else {
    const j = JSON.parse(st2) as { state: string; restarts: number; relay: { state: string }; lastError: { message: string } | null };
    rows.push(["rechazo de publish: estado/reintentos/relé tras 2,5 s", `${j.state} / ${j.restarts} / ${j.relay?.state}`]);
    rows.push(["rechazo de publish: lastError", String(j.lastError?.message ?? "ninguno").slice(0, 120)]);
    if (j.restarts === 0) fail++;
  }
  await post(s, "/control/stop", {});
  evil.close();
  const logs = s.logs();
  rows.push(["logs del streamer (stdout+stderr, ambas fases)", count(logs)]);
  if (count(logs)) fail++;

  // 3) TLS: hostname que NO casa con el certificado ⇒ debe fallar.
  const t3 = await ingest();
  const r3 = (await (await post(s, "/control/test", { ingestUrl: `rtmps://localhost:${t3.port}/live2`, credential: sealed })).json()) as Record<string, unknown>;
  rows.push(["TLS hostname distinto (localhost vs SAN 127.0.0.1)", r3.ok === false ? "RECHAZA" : "ACEPTA"]);
  if (r3.ok !== false) fail++;
  const r3ok = (await (await post(s, "/control/test", { ingestUrl: `rtmps://127.0.0.1:${t3.port}/live2`, credential: sealed })).json()) as Record<string, unknown>;
  rows.push(["TLS hostname correcto + CA de confianza (control positivo)", r3ok.ok === true ? "ACEPTA" : `RECHAZA ${String(r3ok.error)}`]);
  if (r3ok.ok !== true) fail++;
  s.proc.kill("SIGKILL");

  // 4) TLS: CA no confiada ⇒ debe fallar y la clave no debe llegar a la ingesta.
  const s4 = await streamer({ trustCa: false });
  await post(s4, "/control/start", { sessionId: "eq6b-4", mode: "rtmps", ingestUrl: `rtmps://127.0.0.1:${t3.port}/live2`, credential: sealed });
  await sleep(2500);
  const st4 = JSON.parse(await get(s4, "/status")) as { lastError?: { message: string } | null };
  rows.push(["TLS CA no confiada: publish recibido por la ingesta", t3.published.length]);
  rows.push(["TLS CA no confiada: lastError", String(st4.lastError?.message ?? "ninguno").slice(0, 90)]);
  if (t3.published.length) fail++;
  s4.proc.kill("SIGKILL");
  t3.close();

  console.log("superficie | resultado");
  for (const [k, v] of rows) console.log(`${k} | ${v}`);
  console.log(`FALLOS=${fail}`);
  process.exit(fail ? 1 : 0);
}
void main().catch((e) => {
  console.error("error del arnés:", (e as Error).message);
  process.exit(2);
});
