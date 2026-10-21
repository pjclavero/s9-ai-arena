#!/usr/bin/env node
/**
 * RC2 DEV-CI · sonda de UNA petición HTTP al s9-docker-proxy desde la posición de red
 * de un contenedor del stack.
 *
 * run.sh la ejecuta en un contenedor efímero con `--network container:<objetivo>`: comparte
 * interfaces, rutas e IP del objetivo (gateway, api, bot-build-worker…), así que lo que
 * mide es lo que vería un proceso comprometido DENTRO de ese contenedor. Sólo Node, sin
 * dependencias, sin nombres DNS (habla a la IP: el /etc/hosts del contenedor efímero no es
 * el del objetivo; el alias `docker-proxy.internal` se verifica aparte, por inspect).
 *
 * Clasificación de transporte (`tcp`): CONNECT · ENETUNREACH · EHOSTUNREACH · TIMEOUT ·
 * REFUSED · OTHER:<código>. Si conecta, `http` = {status, body} o `closed=true` cuando el
 * proxy cierra/resetea sin responder (control de cliente del contrato: «cierre/403»).
 *
 * Uso: node probe.mjs <ip> <puerto> <MÉTODO> <ruta> [fichero-cuerpo|-] [timeout-ms]
 * Salida: UNA línea JSON por stdout; rc 0 siempre que la sonda haya podido medir.
 */
import net from "node:net";
import { readFileSync } from "node:fs";

const [ip, port, method, path, bodyFile = "-", timeoutArg = "5000"] = process.argv.slice(2);
if (!ip || !port || !method || !path) {
  console.error("uso: probe.mjs <ip> <puerto> <MÉTODO> <ruta> [fichero-cuerpo|-] [timeout-ms]");
  process.exit(2);
}
const timeoutMs = Number(timeoutArg);
const body = bodyFile && bodyFile !== "-" ? readFileSync(bodyFile) : Buffer.alloc(0);
const t0 = Date.now();

function finish(result) {
  process.stdout.write(JSON.stringify({ ip, port: Number(port), method, path, ms: Date.now() - t0, ...result }) + "\n");
  process.exit(0);
}

function classifyError(err) {
  switch (err?.code) {
    case "ENETUNREACH":
      return "ENETUNREACH";
    case "EHOSTUNREACH":
      return "EHOSTUNREACH";
    case "ECONNREFUSED":
      return "REFUSED";
    case "ETIMEDOUT":
      return "TIMEOUT";
    default:
      return `OTHER:${err?.code ?? String(err)}`;
  }
}

/** Decodifica una respuesta HTTP/1.1 (Content-Length, chunked o hasta el cierre). */
function parseResponse(buf) {
  const sep = buf.indexOf("\r\n\r\n");
  if (sep < 0) return null;
  const head = buf.subarray(0, sep).toString("latin1");
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
  if (!m) return null;
  let rest = buf.subarray(sep + 4);
  if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) {
    const out = [];
    let off = 0;
    for (;;) {
      const eol = rest.indexOf("\r\n", off);
      if (eol < 0) break;
      const size = parseInt(rest.subarray(off, eol).toString("latin1"), 16);
      if (!Number.isFinite(size) || size === 0) break;
      out.push(rest.subarray(eol + 2, eol + 2 + size));
      off = eol + 2 + size + 2;
    }
    rest = Buffer.concat(out);
  }
  return { status: Number(m[1]), body: rest.toString("utf8").slice(0, 600) };
}

let connected = false;
const sock = net.createConnection({ host: ip, port: Number(port) });
const timer = setTimeout(() => {
  sock.destroy();
  if (!connected) finish({ tcp: "TIMEOUT", http: null, closed: false });
  else finish({ tcp: "CONNECT", http: null, closed: false, note: "sin respuesta en el plazo" });
}, timeoutMs);

const chunks = [];
sock.on("connect", () => {
  connected = true;
  const head =
    `${method} ${path} HTTP/1.1\r\nHost: docker-proxy.internal\r\nConnection: close\r\n` +
    `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`;
  sock.write(Buffer.concat([Buffer.from(head, "latin1"), body]));
});
sock.on("data", (c) => chunks.push(c));
sock.on("error", (err) => {
  clearTimeout(timer);
  if (!connected) return finish({ tcp: classifyError(err), http: null, closed: false });
  const http = parseResponse(Buffer.concat(chunks));
  finish({ tcp: "CONNECT", http, closed: http === null, error: err.code ?? String(err) });
});
sock.on("close", () => {
  clearTimeout(timer);
  if (!connected) return; // el error ya clasificó
  const http = parseResponse(Buffer.concat(chunks));
  finish({ tcp: "CONNECT", http, closed: http === null });
});
