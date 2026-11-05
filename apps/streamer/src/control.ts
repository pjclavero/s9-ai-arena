/**
 * T11.2 · API interna de control del streamer (red platform del Compose; el
 * puerto JAMÁS se publica — el streamer solo asoma a `public` para la salida
 * RTMPS, sin puertos).
 *
 *   POST /control/start  {…SessionPlan}   → arranca/re-apunta la emisión
 *   POST /control/stop                    → para la emisión (idempotente)
 *   POST /control/test   {ingestUrl, credential} → TLS + handshake + connect, SIN publicar
 *   GET  /status                          → estado + métricas (SIN clave)
 *   GET  /recordings                      → grabaciones MP4, espacio en disco
 *   POST /recordings/retention {policy, dryRun} → retención (devuelve lo borrado para auditar)
 *   GET  /metrics                         → Prometheus para E10
 *   GET  /healthz                         → healthcheck del Compose
 *   GET  /version                         → identidad de build (ADR-016)
 *
 * EQ5b · Con STREAMER_CONTROL_SECRET_FILE configurado, todo menos /metrics,
 * /healthz y /version exige la cabecera `x-streamer-auth` (comparación en
 * tiempo constante): otro contenedor de la red `platform` no puede arrancar
 * una emisión ni leer el estado saltándose el RBAC de la API.
 *
 * EQ5c (revisión EQ6b, P2-3) · FALLA EN CERRADO: si el secreto se exige
 * (STREAMER_CONTROL_SECRET_FILE definido) y no se puede leer o está vacío, todo
 * lo autenticado responde 401 y /healthz 503 (contenedor `unhealthy`, visible);
 * nunca queda abierto. El secreto se relee en cada petición (rotar sin reiniciar).
 *
 * EQ5c (P2-2) · La credencial sellada sólo se abre si la plataforma y la ingesta
 * de la orden casan con las selladas (packages/stream-secrets, `bind`).
 * EQ5c (P2-1) · /control/test tiene un plazo total: vencido, se cierra el socket.
 *
 * Ninguna respuesta ni log contiene la clave RTMPS: /status describe el
 * destino redactado y la credencial sólo entra SELLADA.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { versionPayload } from "../../../packages/build-info/index.js";
import { canonicalIngestUrl, openSecret, SealedSecretError } from "../../../packages/stream-secrets/index.js";
import type { StreamSupervisor } from "./supervisor.js";
import type { Logger, StreamerConfig } from "./config.js";
import { renderPrometheus } from "./metrics.js";
import { parseIngestUrl, RtmpPublisher, type IngestTarget } from "./rtmp/publisher.js";
import { parseStartRequest, presetOf, sessionFingerprint, type Capabilities } from "./session.js";
import { applyRetention, listRecordings, validateRetentionPolicy } from "./recordings.js";

const MAX_BODY = 16 * 1024;
/** Plazo total de /control/test (TLS + handshake + connect); vencido, se cierra el socket. */
export const TEST_DEADLINE_MS = 15_000;

export interface ControlOptions {
  supervisor: StreamSupervisor;
  config: StreamerConfig;
  logger: Logger;
  capabilities?: Capabilities;
  /**
   * Secreto compartido con la API. `null` = control abierto (sólo compatibilidad,
   * y sólo si `requireControlSecret` es falso). Una función se evalúa en cada
   * petición (rotación sin reinicio).
   */
  controlSecret?: string | null | (() => string | null);
  /**
   * El despliegue EXIGE secreto (STREAMER_CONTROL_SECRET_FILE definido): si no
   * se puede obtener, se deniega todo (fail-closed), nunca se abre.
   */
  requireControlSecret?: boolean;
  /** Plazo de /control/test (pruebas). */
  testDeadlineMs?: number;
  /** Lee la clave privada de apertura de credenciales (null = no configurada). */
  readPrivateKey?: () => string | null;
  /** Lee la clave de despliegue heredada (STREAM_KEY_FILE); null = no hay. */
  readLegacyKey?: () => string | null;
  allowPlainRtmp?: boolean;
  dial?: (t: IngestTarget) => Duplex;
  now?: () => number;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      raw += c;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function authorized(req: IncomingMessage, secret: string | null, required: boolean): boolean {
  if (!secret) return !required;
  const got = req.headers["x-streamer-auth"];
  if (typeof got !== "string") return false;
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameIngest(a: string, b: string): boolean {
  try {
    return canonicalIngestUrl(a) === canonicalIngestUrl(b);
  } catch {
    return false;
  }
}

export function createControlServer(opts: ControlOptions): Server {
  const { supervisor, config, logger } = opts;
  const caps: Capabilities = opts.capabilities ?? { nvenc: null };
  const now = opts.now ?? Date.now;
  const required = opts.requireControlSecret === true;
  const currentSecret = (): string | null => {
    const s = opts.controlSecret;
    if (typeof s === "function") {
      try {
        return s() || null;
      } catch {
        return null;
      }
    }
    return s || null;
  };

  /**
   * Clave para una orden: sellada (web) —sólo si está atada al destino de la
   * orden— o la heredada del despliegue.
   */
  function resolveKey(
    credential: unknown,
    expected: { ingest: string; platform: string | null } | null,
  ): { key: string | null; error?: string; status?: number } {
    if (credential) {
      if (!expected || !expected.platform) {
        return {
          key: null,
          status: 400,
          error: "platform obligatoria con credencial (el sobre está atado a su destino)",
        };
      }
      const pem = opts.readPrivateKey?.() ?? null;
      if (!pem) return { key: null, status: 503, error: "el streamer no tiene la clave privada de credenciales" };
      try {
        return { key: openSecret(credential, pem, { ingest: expected.ingest, platform: expected.platform }) };
      } catch (e) {
        if (e instanceof SealedSecretError && e.code === "binding_mismatch") {
          logger("warn", "control: credencial sellada para otro destino; orden rechazada", {
            target: expected.ingest.replace(/\/[^/]*$/, "/***"),
          });
        } else {
          // EQ5d (revisión EQ6c, P3) · también se registran los sobres que no se
          // pueden abrir (etiqueta manipulada o truncada, otra clave, formato): un
          // goteo de `undecryptable` es la huella de alguien probando sobres.
          logger("warn", "control: credencial sellada rechazada; orden rechazada", {
            code: e instanceof SealedSecretError ? e.code : "invalid",
            target: expected.ingest.replace(/\/[^/]*$/, "/***"),
          });
        }
        return { key: null, status: 409, error: e instanceof SealedSecretError ? e.message : "credencial inválida" };
      }
    }
    // Clave heredada del despliegue (STREAM_KEY_FILE): sólo hacia la ingesta del
    // PROPIO despliegue (STREAM_RTMPS_URL). Si la orden apunta a otra ingesta, la
    // clave no sale (misma propiedad que el sobre atado a su destino).
    if (expected && !sameIngest(expected.ingest, config.rtmpsUrl)) return { key: null };
    try {
      return { key: opts.readLegacyKey?.() ?? null };
    } catch {
      return { key: null };
    }
  }

  return createServer((req, res) => {
    const respond = (status: number, body: unknown, contentType = "application/json") => {
      res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const url = (req.url ?? "").split("?")[0];

    if (req.method === "GET" && url === "/healthz") {
      // Secreto exigido e ilegible ⇒ unhealthy (visible), nunca «ok» con el control abierto.
      if (required && !currentSecret()) {
        return respond(503, { ok: false, state: supervisor.state, error: "control_secret_unavailable" });
      }
      return respond(200, { ok: true, state: supervisor.state });
    }

    // ADR-016 · identidad de build embebida en la imagen. Este servidor es http
    // nativo (no Express), así que se sirve el MISMO cuerpo del contrato con el
    // helper compartido en vez de duplicar la forma del JSON.
    if (req.method === "GET" && url === "/version") {
      res.setHeader("cache-control", "no-store");
      return respond(200, versionPayload(process.env, "streamer"));
    }

    if (req.method === "GET" && url === "/metrics") {
      const started = supervisor.startedAtMs;
      const last = Math.max(supervisor.metrics.lastProgressAt ?? 0, started ?? 0);
      const text = renderPrometheus({
        state: supervisor.state,
        restarts: supervisor.restarts,
        stats: supervisor.metrics.snapshot(),
        desired: supervisor.desired,
        progressAgeSeconds:
          supervisor.desired && started !== null ? Math.max(0, Math.round((now() - last) / 1000)) : -1,
        relayPublishing: supervisor.relayState === "publishing",
      });
      return respond(200, text, "text/plain; version=0.0.4");
    }

    const secret = currentSecret();
    if (!authorized(req, secret, required)) {
      return respond(401, { error: required && !secret ? "control_secret_unavailable" : "unauthorized" });
    }

    if (req.method === "GET" && url === "/status") {
      const cfg = supervisor.effectiveConfig;
      let legacyKeyConfigured = false;
      try {
        legacyKeyConfigured = !!opts.readLegacyKey?.();
      } catch {
        legacyKeyConfigured = false;
      }
      return respond(200, {
        state: supervisor.state,
        desired: supervisor.desired,
        mode: cfg.mode,
        encoder: cfg.encoder,
        preset: presetOf(cfg),
        fps: cfg.fps,
        videoBitrateKbps: cfg.videoBitrateKbps,
        broadcastUrl: supervisor.currentBroadcastUrl,
        target: supervisor.describeTarget(),
        session: supervisor.session(),
        restarts: supervisor.restarts,
        lastError: supervisor.lastError,
        relay: { state: supervisor.relayState, bytesOut: supervisor.relayBytesOut },
        recording: supervisor.recordingFile ? supervisor.recordingFile.split("/").pop() : null,
        capabilities: { nvenc: caps.nvenc, sealedCredentials: !!opts.readPrivateKey?.() },
        legacyKeyConfigured,
        stats: supervisor.metrics.snapshot(),
      });
    }

    if (req.method === "GET" && url === "/recordings") {
      return respond(200, {
        dir: "arena_replays/video",
        ...listRecordings(config.recordDir, supervisor.recordingFile),
      });
    }

    if (req.method !== "POST") return respond(404, { error: "not_found" });
    if (!["/control/start", "/control/stop", "/control/test", "/recordings/retention"].includes(url)) {
      return respond(404, { error: "not_found" });
    }

    void readBody(req)
      .then(async (raw) => {
        let body: Record<string, unknown> = {};
        if (raw.trim()) {
          try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("x");
            body = parsed;
          } catch {
            return respond(400, { error: "body JSON inválido" });
          }
        }

        if (url === "/control/stop") {
          const wasActive = supervisor.desired;
          supervisor.stop();
          return respond(200, { state: supervisor.state, wasActive });
        }

        if (url === "/recordings/retention") {
          const policy = validateRetentionPolicy(body.policy);
          if (typeof policy === "string") return respond(400, { error: policy });
          const result = applyRetention(config.recordDir, policy, supervisor.recordingFile, {
            dryRun: body.dryRun === true,
          });
          logger("info", "retención de grabaciones", {
            dryRun: result.dryRun,
            deleted: result.deleted.length,
            errors: result.errors.length,
          });
          return respond(200, result);
        }

        if (url === "/control/test") {
          let target: IngestTarget;
          try {
            target = parseIngestUrl(String(body.ingestUrl ?? config.rtmpsUrl), opts.allowPlainRtmp);
          } catch (e) {
            return respond(400, { error: (e as Error).message });
          }
          const platform =
            typeof body.platform === "string" && /^[a-z0-9_-]{1,32}$/.test(body.platform) ? body.platform : null;
          const k = resolveKey(body.credential ?? null, { ingest: target.tcUrl, platform });
          if (k.error) return respond(k.status ?? 409, { error: k.error });
          // La prueba no publica: la clave no hace falta para conectar, pero se
          // comprueba que existe y abre para no dar un «OK» engañoso.
          const pub = new RtmpPublisher({ target, streamKey: k.key ?? "", dial: opts.dial, connectTimeoutMs: 8000 });
          const deadlineMs = opts.testDeadlineMs ?? TEST_DEADLINE_MS;
          let deadline: NodeJS.Timeout | null = null;
          try {
            const r = await Promise.race([
              pub.probe(),
              new Promise<never>((_, reject) => {
                deadline = setTimeout(() => {
                  pub.close(); // cierra el socket: nada queda colgado
                  reject(new Error("la ingesta no completó la prueba a tiempo"));
                }, deadlineMs);
              }),
            ]);
            return respond(200, {
              ok: true,
              target: target.display,
              tlsVerified: r.tlsVerified,
              connectMs: r.connectMs,
              credentialPresent: !!k.key,
              keyValidated: false,
              note: "conexión y handshake RTMP correctos; la clave no se valida sin publicar",
            });
          } catch (e) {
            pub.close();
            return respond(200, {
              ok: false,
              target: target.display,
              credentialPresent: !!k.key,
              error: (e as Error).message,
            });
          } finally {
            if (deadline) clearTimeout(deadline);
          }
        }

        // /control/start
        const parsed = parseStartRequest(body, config, caps, { allowPlainRtmp: opts.allowPlainRtmp });
        if (parsed.ok === false) {
          const error = (parsed as { error: string }).error;
          // EQ5d (P3) · un sobre con formato inválido (p. ej. etiqueta GCM truncada)
          // también queda registrado, como los que no se pueden abrir.
          if (body.credential !== undefined && /credencial sellada/.test(error)) {
            logger("warn", "control: credencial sellada rechazada; orden rechazada", { code: "invalid" });
          }
          return respond(400, { error });
        }
        const plan = parsed.plan;
        // Idempotencia: la MISMA sesión ya activa ⇒ no se toca nada.
        if (supervisor.active && plan.sessionId && supervisor.sessionFingerprint === sessionFingerprint(plan)) {
          return respond(200, { state: supervisor.state, alreadyActive: true, session: supervisor.session() });
        }
        // Sin operaciones contradictorias: con una emisión activa hay que pedir
        // explícitamente el reemplazo (la API lo hace sólo con «Reiniciar»).
        if (supervisor.active && body.replace !== true) {
          return respond(409, { error: "already_active", session: supervisor.session() });
        }
        let key: string | null = null;
        if (plan.config.mode === "rtmps") {
          const k = resolveKey(
            plan.credential,
            plan.ingest ? { ingest: plan.ingest.tcUrl, platform: plan.platform } : null,
          );
          if (k.error) return respond(k.status ?? 409, { error: k.error });
          if (!k.key) return respond(409, { error: "no hay credencial de emisión configurada" });
          key = k.key;
        }
        // Sin cuerpo (uso heredado): configuración de entorno sin plan.
        const legacy = !raw.trim();
        if (legacy) supervisor.start(undefined, undefined, key);
        else supervisor.start(undefined, plan, key);
        logger("info", "control: start", {
          broadcastUrl: supervisor.currentBroadcastUrl,
          target: supervisor.describeTarget(),
        });
        return respond(200, {
          state: supervisor.state,
          broadcastUrl: supervisor.currentBroadcastUrl,
          session: supervisor.session(),
        });
      })
      .catch((e: Error) => {
        if (e.message === "too_large") return respond(413, { error: "body demasiado grande" });
        logger("error", "control: error interno", { detail: e.message });
        return respond(500, { error: "internal" });
      });
  });
}
