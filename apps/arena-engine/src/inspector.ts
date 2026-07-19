/**
 * Inspector HTTP de solo lectura (R13.1).
 *
 * Vive DELIBERADAMENTE fuera de `src/sim/`: usa `node:http` y el reloj de pared
 * (uptime) para responder peticiones, cosas prohibidas dentro del núcleo determinista
 * (lo bloquea `scripts/lint-determinism.mjs`). No expone nada mutable: solo lectura
 * del snapshot público que ya sirve el propio motor (`Battle.getPublicSnapshot()`),
 * el mismo que ven los replays y el protocolo de bots. Nunca toca `battle.config`,
 * `battle.stateHash()`, el RNG, ni el estado oculto (minas, seed, energía, velocidad).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Battle } from "./sim/battle.js";

export interface InspectorOptions {
  battle: Battle;
  host?: string;
  port?: number;
}

export interface Inspector {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(payload);
}

/**
 * Arranca el inspector y resuelve cuando ya está escuchando. `port` por defecto 0
 * (efímero, el SO elige uno libre); consulta `inspector.port` para saber cuál.
 */
export function createInspector(opts: InspectorOptions): Promise<Inspector> {
  const { battle } = opts;
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 0;
  const startedAt = Date.now();

  // Rastreo de sockets abiertos (incl. keep-alive) para poder cerrarlos en close()
  // y no dejar handles colgados al terminar el proceso.
  const sockets = new Set<Socket>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://internal");

    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });
      return;
    }

    if (url.pathname === "/health") {
      const body = { ok: true, tick: battle.tick, uptimeMs: Date.now() - startedAt };
      if (method === "HEAD") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end();
        return;
      }
      sendJson(res, 200, body);
      return;
    }

    if (url.pathname === "/snapshot") {
      const snapshot = battle.getPublicSnapshot();
      if (method === "HEAD") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end();
        return;
      }
      sendJson(res, 200, snapshot);
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  });

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : requestedPort;

      resolve({
        host,
        port: boundPort,
        close(): Promise<void> {
          return new Promise((res, rej) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
  });
}
