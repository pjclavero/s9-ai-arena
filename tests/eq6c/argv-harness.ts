/**
 * EQ6c · Arnés PROPIO (independiente del de EQ6b) de «clave fuera de argv» con
 * procesos REALES: streamer real (apps/streamer/src/main.ts) + ffmpeg real
 * (testsrc → FLV por el fd 3) + ingesta RTMP falsa en 127.0.0.1.
 *
 * Diferencias con tests/eq6b/key-surfaces.ts: cubre las DOS fuentes de clave
 * (heredada STREAM_KEY_FILE con STREAM_AUTOSTART=1, y sobre sellado por
 * /control/start), y el envoltorio de ffmpeg VUELCA su propio argv y entorno a
 * un fichero 0600 para auditar lo que el hijo recibió de verdad.
 *
 * Uso: EQ6C_DIR=<dir 0700 bajo $CLAUDE_JOB_DIR/tmp> npx tsx tests/eq6c/argv-harness.ts
 * Nada sensible se imprime ni va en argv: claves y secretos en ficheros 0600/0400.
 * Salida: tabla «superficie | apariciones»; rc ≠ 0 si la clave aparece o si el
 * control positivo (la ingesta recibe la clave y medios) falla.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { decodeAmf0Values, encodeAmf0Values } from "../../apps/streamer/src/rtmp/amf0.js";
import {
  ChunkReader,
  encodeMessage,
  MSG_COMMAND_AMF0,
  MSG_SET_CHUNK_SIZE,
  type RtmpMessage,
} from "../../apps/streamer/src/rtmp/chunk.js";
import { sealSecret } from "../../packages/stream-secrets/index.js";

if (!process.env.EQ6C_DIR) throw new Error("EQ6C_DIR obligatorio");
mkdirSync(process.env.EQ6C_DIR, { recursive: true, mode: 0o700 });
const DIR = mkdtempSync(join(process.env.EQ6C_DIR, "run-"));
const w = (name: string, data: string, mode = 0o600) => {
  const f = join(DIR, name);
  writeFileSync(f, data, { mode });
  chmodSync(f, mode);
  return f;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LEGACY_KEY = `eq6cL-${randomBytes(16).toString("hex")}`;
const SEALED_KEY = `eq6cS-${randomBytes(16).toString("hex")}`;
const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const legacyFile = w("stream_key.txt", LEGACY_KEY, 0o400);
const privFile = w("priv.pem", PRIV, 0o400);
const ctl = randomBytes(24).toString("hex");
const ctlFile = w("ctl.txt", ctl, 0o400);
const dumpFile = join(DIR, "ffmpeg-argv-env.txt");
const ffmpegWrapper = w(
  "ffmpeg.sh",
  `#!/bin/sh\n{ printf 'ARGV:'; for a in "$@"; do printf ' %s' "$a"; done; echo; env; } >> '${dumpFile}'\nexec ffmpeg -hide_banner -nostats -loglevel error -progress pipe:1 -re -f lavfi -i testsrc=size=160x120:rate=15 -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v libx264 -preset ultrafast -g 30 -c:a aac -f flv pipe:3\n`,
  0o700,
);
const chromiumWrapper = w(
  "chromium.sh",
  `#!/bin/sh\n{ printf 'CHROMIUM:'; for a in "$@"; do printf ' %s' "$a"; done; echo; } >> '${dumpFile}'\nexec sleep 600\n`,
  0o700,
);

// ── ingesta RTMP falsa ─────────────────────────────────────────────────────
const ing = { published: [] as string[], media: 0 };
const socks: Socket[] = [];
const srv = createServer((sock) => {
  socks.push(sock);
  sock.on("error", () => {});
  let buf = Buffer.alloc(0);
  let phase = 0;
  const s1 = randomBytes(1536);
  const reader = new ChunkReader();
  const send = (m: RtmpMessage) => sock.write(encodeMessage(m, 128));
  const reply = (name: string, txn: number, args: unknown[], sid = 0) =>
    send({
      csid: 3,
      type: MSG_COMMAND_AMF0,
      streamId: sid,
      timestamp: 0,
      payload: encodeAmf0Values([name, txn, ...(args as never[])]),
    });
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
    if (phase !== 2 || !buf.length) return;
    const msgs = reader.push(buf);
    buf = Buffer.alloc(0);
    for (const m of msgs) {
      if (m.type === MSG_SET_CHUNK_SIZE && m.payload.length >= 4)
        reader.setChunkSize(m.payload.readUInt32BE(0) & 0x7fffffff);
      if (m.type === 8 || m.type === 9) ing.media++;
      if (m.type !== MSG_COMMAND_AMF0) continue;
      const v = decodeAmf0Values(m.payload);
      const name = String(v[0]);
      const txn = Number(v[1]);
      if (name === "connect") reply("_result", txn, [{}, { code: "NetConnection.Connect.Success" }]);
      if (name === "createStream") reply("_result", txn, [null, 1]);
      if (name === "publish") {
        ing.published.push(String(v[3]));
        reply("onStatus", 0, [null, { level: "status", code: "NetStream.Publish.Start", description: "ok" }], 1);
      }
    }
  });
});

function needles(k: string) {
  return [
    k,
    k.toUpperCase(),
    encodeURIComponent(k),
    Buffer.from(k).toString("base64").slice(0, 24),
    Buffer.from(k).toString("hex"),
  ];
}
const ALL = [...needles(LEGACY_KEY), ...needles(SEALED_KEY)];
const count = (t: string) => ALL.reduce((n, x) => n + (t.split(x).length - 1), 0);

function scanProc(): { cmdline: number; environ: number; readable: number } {
  let cmdline = 0;
  let environ = 0;
  let readable = 0;
  for (const pid of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    for (const f of ["cmdline", "environ"] as const) {
      try {
        const t = readFileSync(`/proc/${pid}/${f}`, "latin1");
        readable++;
        const c = count(t);
        if (f === "cmdline") cmdline += c;
        else environ += c;
      } catch {
        /* procesos de otros usuarios */
      }
    }
  }
  return { cmdline, environ, readable };
}

async function main() {
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const ingestUrl = `rtmp://127.0.0.1:${(srv.address() as AddressInfo).port}/live2`;
  const port = 22000 + Math.floor(Math.random() * 20000);
  let logs = "";
  const proc: ChildProcess = spawn(process.execPath, ["--import", "tsx", "apps/streamer/src/main.ts"], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: DIR,
      STREAMER_CONTROL_PORT: String(port),
      STREAMER_CONTROL_SECRET_FILE: ctlFile,
      STREAM_SECRETS_PRIVATE_KEY_FILE: privFile,
      STREAM_KEY_FILE: legacyFile,
      RTMPS_URL: ingestUrl,
      STREAMER_ALLOW_PLAIN_RTMP: "1",
      STREAM_AUTOSTART: "1",
      FFMPEG_BIN: ffmpegWrapper,
      CHROMIUM_BIN: chromiumWrapper,
      BROADCAST_URL: "http://127.0.0.1:1/broadcast",
      STREAM_RETRY_DELAY_MS: "500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout!.on("data", (d) => (logs += d));
  proc.stderr!.on("data", (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  const H = { "content-type": "application/json", "x-streamer-auth": ctl };
  const rows: [string, number | string][] = [];
  let fail = 0;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`${base}/healthz`);
        break;
      } catch {
        await sleep(150);
      }
    }
    // Fase 1: clave HEREDADA por autostart.
    for (let i = 0; i < 80 && ing.media < 20; i++) await sleep(200);
    const p1 = scanProc();
    let ps1 = "";
    try {
      ps1 = execFileSync("ps", ["-eo", "pid,args", "-ww"], { encoding: "latin1" });
    } catch {
      ps1 = "";
    }
    rows.push(["F1 · ingesta recibió la clave heredada (control +)", ing.published.includes(LEGACY_KEY) ? "SÍ" : "NO"]);
    rows.push(["F1 · medios recibidos (control +)", ing.media]);
    if (!ing.published.includes(LEGACY_KEY) || ing.media < 20) fail++;
    rows.push(
      ["F1 · /proc/*/cmdline", p1.cmdline],
      ["F1 · /proc/*/environ", p1.environ],
      ["F1 · ps -eo args", count(ps1)],
    );
    fail += p1.cmdline + p1.environ + count(ps1);

    // Fase 2: clave SELLADA por /control/start (reemplaza la emisión).
    const mediaBefore = ing.media;
    const credential = sealSecret(SEALED_KEY, PUB, { platform: "custom", ingest: ingestUrl });
    const r = await fetch(`${base}/control/start`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        sessionId: "eq6c-argv",
        mode: "rtmps",
        ingestUrl,
        platform: "custom",
        credential,
        replace: true,
      }),
    });
    rows.push(["F2 · /control/start", r.status]);
    for (let i = 0; i < 80 && ing.media < mediaBefore + 20; i++) await sleep(200);
    const p2 = scanProc();
    let ps2 = "";
    try {
      ps2 = execFileSync("ps", ["-eo", "pid,args", "-ww"], { encoding: "latin1" });
    } catch {
      ps2 = "";
    }
    rows.push(["F2 · ingesta recibió la clave sellada (control +)", ing.published.includes(SEALED_KEY) ? "SÍ" : "NO"]);
    if (!ing.published.includes(SEALED_KEY)) fail++;
    rows.push(
      ["F2 · /proc/*/cmdline", p2.cmdline],
      ["F2 · /proc/*/environ", p2.environ],
      ["F2 · ps -eo args", count(ps2)],
    );
    fail += p2.cmdline + p2.environ + count(ps2);
    rows.push(["procesos legibles escaneados (control +)", p2.readable]);

    for (const p of ["/status", "/metrics", "/recordings", "/version", "/healthz"]) {
      const t = await (await fetch(`${base}${p}`, { headers: H })).text();
      rows.push([`HTTP ${p}`, count(t)]);
      fail += count(t);
    }
    await fetch(`${base}/control/stop`, { method: "POST", headers: H, body: "{}" });
    await sleep(500);
    let dump = "";
    try {
      dump = readFileSync(dumpFile, "latin1");
    } catch {
      dump = "";
    }
    rows.push(["argv+env vistos por ffmpeg/chromium (envoltorio)", count(dump)]);
    rows.push(["envoltorio ejecutado (control +)", dump.includes("ARGV:") ? "SÍ" : "NO"]);
    if (!dump.includes("ARGV:")) fail++;
    fail += count(dump);
    rows.push(["logs stdout+stderr del streamer", count(logs)]);
    fail += count(logs);
  } finally {
    proc.kill("SIGTERM");
    await sleep(800);
    proc.kill("SIGKILL");
    for (const s of socks) s.destroy();
    srv.close();
  }
  for (const [k, v] of rows) console.log(`${k} | ${v}`);
  console.log(`FALLOS=${fail}`);
  process.exitCode = fail ? 1 : 0;
}
void main();
