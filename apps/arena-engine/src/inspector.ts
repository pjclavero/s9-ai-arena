/**
 * Inspector HTTP de solo lectura (R13.1).
 *
 * Vive DELIBERADAMENTE fuera de `src/sim/`: usa `node:http` y el reloj de pared
 * (uptime) para responder peticiones, cosas prohibidas dentro del núcleo determinista
 * (lo bloquea `scripts/lint-determinism.mjs`). No expone nada mutable: solo lectura
 * del snapshot público que ya sirve el propio motor (`Battle.getPublicSnapshot()`),
 * el mismo que ven los replays y el protocolo de bots. Nunca toca `battle.config`,
 * `battle.stateHash()`, el RNG, ni el estado oculto (minas, seed, energía, velocidad).
 *
 * R13.2 (hardening) · Sin CORS ni autenticación — es DELIBERADO, no un olvido:
 * el bind por defecto es loopback (127.0.0.1/::1), así que solo procesos de la
 * misma máquina pueden alcanzarlo. Exponerlo en un host no-loopback exige el
 * flag explícito `--inspect-allow-remote` en la CLI (ver `cli.ts`); si algún día
 * se permite remoto por defecto, este inspector NECESITARÍA autenticación antes.
 * También lleva límites de servidor (timeouts + maxConnections) para no ser un
 * vector de agotamiento de handles/slowloris, y `Cache-Control: no-store` en
 * las dos rutas: son snapshots vivos, nunca cacheables por un proxy intermedio.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Battle } from "./sim/battle.js";

export interface InspectorOptions {
  battle: Battle;
  host?: string;
  port?: number;
  /** ms sin actividad en una petición antes de cortar la conexión. Default 10_000. */
  requestTimeoutMs?: number;
  /** ms de tolerancia para completar las cabeceras entrantes. Default 12_000. */
  headersTimeoutMs?: number;
  /** ms que un socket keep-alive puede quedar ocioso. Default 5_000. */
  keepAliveTimeoutMs?: number;
  /** Tope de conexiones TCP simultáneas. Default 32. */
  maxConnections?: number;
  /**
   * ms entre barridos de conexiones ociosas (`server.connectionsCheckingInterval`).
   * Node lo fija en 30_000 ms por defecto, lo que en la práctica anularía timeouts
   * más cortos que eso (una conexión podría vivir hasta ~2× ese intervalo antes de
   * que se compruebe). Por defecto aquí se deriva del timeout más corto configurado
   * para que los timeouts realmente se apliquen; inyectable para acelerar tests.
   */
  connectionsCheckingIntervalMs?: number;
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
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
  const headersTimeoutMs = opts.headersTimeoutMs ?? 12_000;
  const keepAliveTimeoutMs = opts.keepAliveTimeoutMs ?? 5_000;
  const maxConnections = opts.maxConnections ?? 32;
  const connectionsCheckingIntervalMs =
    opts.connectionsCheckingIntervalMs ?? Math.min(requestTimeoutMs, headersTimeoutMs, keepAliveTimeoutMs);

  // Rastreo de sockets abiertos (incl. keep-alive) para poder cerrarlos en close()
  // y no dejar handles colgados al terminar el proceso.
  const sockets = new Set<Socket>();

  const server: Server = createServer(
    { connectionsCheckingInterval: connectionsCheckingIntervalMs },
    (req: IncomingMessage, res: ServerResponse) => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://internal");

      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });
        return;
      }

      if (url.pathname === "/health") {
        const body = { ok: true, tick: battle.tick, uptimeMs: Date.now() - startedAt };
        if (method === "HEAD") {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end();
          return;
        }
        sendJson(res, 200, body, { "Cache-Control": "no-store" });
        return;
      }

      if (url.pathname === "/snapshot") {
        const snapshot = battle.getPublicSnapshot();
        if (method === "HEAD") {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end();
          return;
        }
        sendJson(res, 200, snapshot, { "Cache-Control": "no-store" });
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    },
  );

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  // R13.2 · REGRESSION LOCK (hardening): límites de servidor para no ser un
  // vector de agotamiento de handles/slowloris. requestTimeout corta una
  // conexión ociosa a mitad de petición; headersTimeout, una que no termina
  // de enviar cabeceras; keepAliveTimeout, un socket keep-alive abandonado.
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.maxConnections = maxConnections;

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
