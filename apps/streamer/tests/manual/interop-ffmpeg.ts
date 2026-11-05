/**
 * EQ5b · Prueba MANUAL de interoperabilidad del relé RTMP (no es parte de la CI:
 * necesita ffmpeg en el host). Servidor RTMP de TERCEROS (`ffmpeg -listen 1`)
 * y encoder ffmpeg REAL escribiendo FLV por el fd 3, como en la imagen.
 *
 *   npx tsx apps/streamer/tests/manual/interop-ffmpeg.ts <salida.flv>
 *
 * Clave aleatoria de PRUEBA (el servidor de prueba sí la lleva en su argv: es
 * el papel de la ingesta remota, no del streamer). Imprime si el argv del
 * encoder contiene la clave (debe ser `false`).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import type { Readable } from "node:stream";
import { RtmpPublisher, parseIngestUrl } from "../../src/rtmp/publisher.js";

const out = process.argv[2];
if (!out) throw new Error("uso: interop-ffmpeg.ts <salida.flv>");
const port = 41900 + Math.floor(Math.random() * 50);
const key = `t${randomBytes(8).toString("hex")}`;
const srv = spawn(
  "ffmpeg",
  [
    ...["-hide_banner", "-loglevel", "error", "-y", "-listen", "1"],
    ...["-i", `rtmp://127.0.0.1:${port}/live2/${key}`, "-c", "copy", "-f", "flv", out],
  ],
  { stdio: "inherit" },
);
await new Promise((r) => setTimeout(r, 1000));
const pub = new RtmpPublisher({
  target: parseIngestUrl(`rtmp://127.0.0.1:${port}/live2`, true),
  streamKey: key,
  dial: (t) => connect({ host: t.host, port: t.port }),
});
pub.on("error", (e) => console.log("error del relé:", e.message));
const enc = spawn(
  "ffmpeg",
  [
    ...["-hide_banner", "-loglevel", "error", "-re"],
    ...["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30"],
    ...["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"],
    ...["-t", "6", "-c:v", "libx264", "-preset", "veryfast", "-b:v", "2500k", "-g", "60", "-pix_fmt", "yuv420p"],
    ...["-c:a", "aac", "-flvflags", "no_duration_filesize", "-f", "flv", "pipe:3"],
  ],
  { stdio: ["ignore", "inherit", "inherit", "pipe"] },
);
const media = enc.stdio[3] as Readable;
media.on("data", (c: Buffer) => {
  if (!pub.writeFlv(c)) media.pause();
});
pub.on("drain", () => media.resume());
pub.start().then(
  () => console.log("publicando; ¿argv del encoder contiene la clave?", enc.spawnargs.join(" ").includes(key)),
  (e: Error) => console.log("start falló:", e.message),
);
enc.on("exit", (c) => {
  console.log("encoder terminó", c, "bytes enviados", pub.bytesOut);
  setTimeout(() => pub.close(), 500);
});
srv.on("exit", (c) => {
  console.log("servidor terminó", c);
  process.exit(0);
});
setTimeout(() => srv.kill("SIGINT"), 15000);
