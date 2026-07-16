/**
 * T11.2 · API interna de control del streamer (red platform del Compose; el
 * puerto JAMÁS se publica — el streamer solo asoma a `public` para la salida
 * RTMPS, sin puertos).
 *
 *   POST /control/start  {broadcastUrl?}  → arranca/re-apunta la emisión
 *   POST /control/stop                    → para la emisión
 *   GET  /status                          → estado + métricas (SIN clave)
 *   GET  /metrics                         → Prometheus para E10
 *   GET  /healthz                         → healthcheck del Compose
 *
 * Ninguna respuesta ni log contiene la clave RTMPS: /status describe el
 * destino redactado y el body de /control/start solo admite broadcastUrl.
 */
import { createServer, type Server } from "node:http";
import type { StreamSupervisor } from "./supervisor.js";
import type { Logger, StreamerConfig } from "./config.js";
import { renderPrometheus } from "./metrics.js";

const SAFE_URL = /^https?:\/\/[^\s]{1,512}$/;

export function createControlServer(opts: {
  supervisor: StreamSupervisor;
  config: StreamerConfig;
  logger: Logger;
}): Server {
  const { supervisor, config, logger } = opts;

  return createServer((req, res) => {
    const respond = (status: number, body: unknown, contentType = "application/json") => {
      res.writeHead(status, { "content-type": contentType });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const url = (req.url ?? "").split("?")[0];

    if (req.method === "GET" && url === "/healthz") {
      return respond(200, { ok: true, state: supervisor.state });
    }

    if (req.method === "GET" && url === "/status") {
      return respond(200, {
        state: supervisor.state,
        mode: config.mode,
        encoder: config.encoder,
        broadcastUrl: supervisor.currentBroadcastUrl,
        target: config.mode === "record" ? config.recordDir : `${config.rtmpsUrl}/***`,
        restarts: supervisor.restarts,
        stats: supervisor.metrics.snapshot(),
      });
    }

    if (req.method === "GET" && url === "/metrics") {
      const text = renderPrometheus({
        state: supervisor.state,
        restarts: supervisor.restarts,
        stats: supervisor.metrics.snapshot(),
      });
      return respond(200, text, "text/plain; version=0.0.4");
    }

    if (req.method === "POST" && (url === "/control/start" || url === "/control/stop")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (url === "/control/stop") {
          supervisor.stop();
          return respond(200, { state: supervisor.state });
        }
        let broadcastUrl: string | undefined;
        if (raw.trim()) {
          try {
            const body = JSON.parse(raw);
            if (body.broadcastUrl !== undefined) {
              if (typeof body.broadcastUrl !== "string" || !SAFE_URL.test(body.broadcastUrl)) {
                return respond(400, { error: "broadcastUrl inválida (http(s) requerido)" });
              }
              broadcastUrl = body.broadcastUrl;
            }
          } catch {
            return respond(400, { error: "body JSON inválido" });
          }
        }
        supervisor.start(broadcastUrl);
        logger("info", "control: start", { broadcastUrl: supervisor.currentBroadcastUrl });
        return respond(200, { state: supervisor.state, broadcastUrl: supervisor.currentBroadcastUrl });
      });
      return;
    }

    respond(404, { error: "not_found" });
  });
}
