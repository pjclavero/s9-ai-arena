/**
 * DEV-A · TD-001 — anfitrión del sandbox: HTTP + WebSocket en UN puerto.
 *
 * Problema que resuelve: el contenedor del bot NO puede recibir su código por
 * montaje (el docker-proxy rechaza Binds/Mounts y el rootfs es de solo lectura)
 * ni por `docker cp`/`attach` (fuera de la allowlist del proxy). Así que lo
 * DESCARGA: el proceso que aloja el ProtocolServer (worker de builds, o el de
 * batallas) sirve aquí el artefacto canónico (`arena-artifact/v1`) a quien
 * presente el token de la sesión. El bootstrap del runtime
 * (sandbox-bootstrap/bootstrap.{py,mjs}) verifica el sha256 antes de ejecutar.
 *
 * Superficie (todo lo demás → 404):
 *   GET  /s9/artifact/<id>          bytes del artefacto (token obligatorio)
 *   POST /s9/artifact/<id>/report   informe de fallo del bootstrap (≤ 8 KB)
 *   POST /s9/artifact/<id>/ready    señal `ready` del bootstrap (TD-034): runtime,
 *                                   artefacto verificado y SDK cargados; lo
 *                                   siguiente es el código del usuario
 *   upgrade WebSocket en cualquier ruta → ProtocolServer (pásale `wss`)
 *
 * Seguridad: el token es aleatorio (32 bytes) por oferta y se compara en tiempo
 * constante; la oferta se revoca al cerrar la sesión. No sirve nada del
 * sistema de ficheros. Los contenedores viven en la red `arena`, sin Internet.
 */
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { WARNING_REPORT_KINDS, type BootstrapSignals } from "./startup-clock.js";

export const ARTIFACT_TOKEN_HEADER = "x-s9-artifact-token";
const MAX_REPORT_BYTES = 8 * 1024;

export interface ArtifactOffer {
  id: string;
  url: string;
  token: string;
  sha256: string;
  /** Veces que el bootstrap descargó el artefacto (con token válido). */
  fetches: number;
  /** Informes de fallo enviados por el bootstrap ({kind, detail}). */
  reports: { kind: string; detail: string }[];
  /** TD-034 · instante (performance.now() del anfitrión) de la primera descarga servida. */
  fetchedAt: number | null;
  /** TD-034 · instante (performance.now() del anfitrión) de la señal `ready` del bootstrap. */
  readyAt: number | null;
  /** TD-034 · las mismas señales, con suscripción (lo que consume awaitAgentReady). */
  signals: BootstrapSignals;
  revoke(): void;
}

export interface SandboxHostOptions {
  /** Nombre/IP con el que los CONTENEDORES alcanzan este proceso en la red arena. */
  advertiseHost: string;
  /** Interfaz de escucha (por defecto 0.0.0.0). */
  bindHost?: string;
  /** Puerto (0 = libre). */
  port?: number;
}

interface OfferState {
  bytes: Buffer;
  offer: ArtifactOffer;
  tokenBuf: Buffer;
}

export class SandboxHost {
  readonly server: http.Server;
  readonly wss: WebSocketServer;
  private readonly offers = new Map<string, OfferState>();
  private readonly notify = new Map<string, () => void>();

  private constructor(private readonly opts: SandboxHostOptions) {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.wss = new WebSocketServer({ server: this.server });
  }

  static async start(opts: SandboxHostOptions): Promise<SandboxHost> {
    const host = new SandboxHost(opts);
    await new Promise<void>((resolve, reject) => {
      host.server.once("error", reject);
      host.server.listen(opts.port ?? 0, opts.bindHost ?? "0.0.0.0", () => resolve());
    });
    return host;
  }

  get port(): number {
    const a = this.server.address();
    if (!a || typeof a === "string") throw new Error("SandboxHost sin dirección TCP");
    return a.port;
  }

  get wsUrl(): string {
    return `ws://${this.opts.advertiseHost}:${this.port}`;
  }

  /** Publica un artefacto para UNA sesión. Revócalo al terminar. */
  offerArtifact(bytes: Buffer, sha256: string): ArtifactOffer {
    const id = randomBytes(12).toString("hex");
    const token = randomBytes(32).toString("hex");
    const offers = this.offers;
    const notify = this.notify;
    const listeners = new Set<() => void>();
    const offer: ArtifactOffer = {
      id,
      url: `http://${this.opts.advertiseHost}:${this.port}/s9/artifact/${id}`,
      token,
      sha256,
      fetches: 0,
      reports: [],
      fetchedAt: null,
      readyAt: null,
      signals: {
        fetchedAt: () => offer.fetchedAt,
        readyAt: () => offer.readyAt,
        // UX-F (DEF-R4) · un AVISO (hook_missing) no es un fallo de arranque.
        failure: () => offer.reports.find((r) => !WARNING_REPORT_KINDS.has(r.kind)) ?? null,
        warnings: () => offer.reports.filter((r) => WARNING_REPORT_KINDS.has(r.kind)),
        onChange(cb) {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
      revoke: () => {
        offers.delete(id);
        notify.delete(id);
      },
    };
    this.notify.set(id, () => {
      for (const l of [...listeners]) l();
    });
    this.offers.set(id, { bytes, offer, tokenBuf: Buffer.from(token) });
    return offer;
  }

  private authorized(state: OfferState, req: http.IncomingMessage): boolean {
    const presented = req.headers[ARTIFACT_TOKEN_HEADER];
    if (typeof presented !== "string") return false;
    const buf = Buffer.from(presented);
    return buf.length === state.tokenBuf.length && timingSafeEqual(buf, state.tokenBuf);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const m = /^\/s9\/artifact\/([0-9a-f]{24})(\/report|\/ready)?$/.exec(req.url ?? "");
    const state = m ? this.offers.get(m[1]) : undefined;
    if (!m || !state) {
      res.writeHead(404).end();
      return;
    }
    if (!this.authorized(state, req)) {
      res.writeHead(403).end();
      return;
    }
    const changed = () => this.notify.get(m[1])?.();
    if (!m[2] && req.method === "GET") {
      state.offer.fetches++;
      if (state.offer.fetchedAt === null) {
        state.offer.fetchedAt = performance.now();
        changed();
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": state.bytes.length });
      res.end(state.bytes);
      return;
    }
    if (m[2] === "/ready" && req.method === "POST") {
      // Se registra al RECIBIR la petición (reloj del anfitrión): el bootstrap
      // espera la respuesta antes de tocar el código del usuario, así que todo
      // lo anterior es de la plataforma y todo lo posterior, del bot.
      if (state.offer.readyAt === null) {
        state.offer.readyAt = performance.now();
        changed();
      }
      req.resume();
      res.writeHead(204).end();
      return;
    }
    if (m[2] === "/report" && req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_REPORT_BYTES) chunks.push(c);
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          state.offer.reports.push({ kind: String(parsed.kind ?? "unknown"), detail: String(parsed.detail ?? "") });
        } catch {
          state.offer.reports.push({ kind: "unknown", detail: "informe ilegible" });
        }
        changed();
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(405).end();
  }

  async close(): Promise<void> {
    this.offers.clear();
    this.notify.clear();
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
