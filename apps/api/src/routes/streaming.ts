/**
 * EQ5b · API administrativa de streaming (Administración → Streaming). Todas las
 * operaciones están en el contrato (openapi.yaml, tag `streaming`) con
 * `x-min-role: admin`: el RBAC lo aplica el registry, no la web.
 *
 * Reglas:
 *  - la clave de emisión ENTRA (PUT credentials) y NUNCA SALE: se sella con la
 *    pública y sólo se devuelve «configurada» y `****ABCD`;
 *  - una sola emisión a la vez (índice único parcial en BD + 409 del streamer);
 *  - start idempotente para el mismo destino y configuración; stop idempotente;
 *  - guardar con una emisión activa NUNCA reinicia en silencio: responde
 *    `pendingRestart` y el operador decide «Reiniciar emisión»;
 *  - desactivar con una emisión activa exige `confirmStop` (y la para);
 *  - toda acción que cambia algo se audita en `audit_log` (`streaming.*`), sin la clave.
 *
 * EQ5c (revisión EQ6b):
 *  - P2-2 · la clave se sella ATADA a su destino (plataforma + ingesta canónica);
 *    si la ingesta cambia, la clave deja de valer y hay que volver a introducirla;
 *  - P2-4 · start, restart y stop se SERIALIZAN (un cerrojo por proceso) y, al
 *    responder el streamer, se vuelve a comprobar la sesión en BD: un stop
 *    confirmado para de verdad aunque otra petición estuviera arrancando;
 *  - P3 · sin poder medir el disco no se empieza a grabar (fail-closed);
 *    ingestas internas rechazadas (SSRF).
 *
 * EQ5d (revisión EQ6c):
 *  - P2 · desactivar lee y para la sesión DENTRO del cerrojo, y start/restart
 *    vuelven a leer `enabled` al responder el streamer;
 *  - P3 · el stop marca la BD ANTES de llamar al streamer (entre instancias);
 *  - P3 · «En directo» sólo con el relé publicando (si no, «Iniciando»).
 *
 * EQ5e (revisión ronda 3):
 *  - R3-D · el estado de la UI usa el modo de la EMISIÓN (streamer/sesión), no el
 *    guardado pendiente de reinicio;
 *  - R3-E · un start cuya respuesta se pierde (plazo, error de red, 5xx) manda
 *    un stop COMPENSATORIO y lo audita;
 *  - R3-B · `reconcileOrphanEmission`: un streamer que emite una sesión que la BD
 *    no tiene activa se para (tras un 409 del streamer, en la recomprobación y
 *    periódicamente desde server.ts).
 */
import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";
import { audit } from "../audit.js";
import { parseLimit } from "../serialize.js";
import { isSealedSecret, sealSecret } from "../../../../packages/stream-secrets/index.js";
import { StreamerUnavailable, type StreamerClient } from "../services/streamer-client.js";
import {
  appliedConfig,
  applySettingsPatch,
  bitrateRecommendation,
  broadcastUrlFor,
  CHANGE_CLASSES,
  credentialBinding,
  effectiveIngest,
  loadSettings,
  parseTarget,
  platformById,
  PLATFORMS,
  readPublicKey,
  resolveTarget,
  validStreamKey,
  type StreamingSettings,
} from "../services/streaming.js";

export interface StreamingDeps {
  streamer: StreamerClient;
  /** Lee la clave pública de sellado (inyectable en tests). */
  publicKey?: () => { pem: string; kid: string } | null;
  broadcastBaseUrl?: string;
  /** Señales para las alertas (MetricsRegistry.setGauge). */
  setGauge?: (name: string, value: number) => void;
  /**
   * Sólo el E2E local: admite ingestas internas/loopback (por defecto
   * STREAMING_ALLOW_INTERNAL_INGEST=1; nunca en el Compose).
   */
  allowInternalIngest?: boolean;
}

/** Sobre guardado en BD (jsonb o texto). */
function parseSealed(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** ¿El sobre guardado está atado EXACTAMENTE a `bind`? */
function sealedBoundTo(sealed: unknown, bind: { platform: string; ingest: string } | null): boolean {
  if (!bind || !isSealedSecret(sealed)) return false;
  return sealed.bind.platform === bind.platform && sealed.bind.ingest === bind.ingest;
}

const unavailable = (msg: string) => new ApiError(503, "streamer_unavailable", msg);
/** Espacio mínimo libre para empezar a grabar (2 GiB ≈ 1 h a 4,5 Mbit/s). */
export const MIN_FREE_BYTES = 2 * 1024 ** 3;

/** JSON canónico (claves ordenadas): jsonb de PostgreSQL reordena las claves. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

interface StreamerStatus {
  state?: string;
  desired?: boolean;
  session?: { sessionId?: string | null; mode?: string } | null;
  capabilities?: { nvenc?: boolean | null; sealedCredentials?: boolean };
  lastError?: { message: string; at: string } | null;
  [k: string]: unknown;
}

/** Campos del /status del streamer que se reenvían al navegador (lista cerrada). */
function publicStatus(s: StreamerStatus | null) {
  if (!s) return null;
  const pick = (k: string) => (s as Record<string, unknown>)[k];
  return {
    state: s.state ?? "unknown",
    desired: !!s.desired,
    mode: pick("mode"),
    encoder: pick("encoder"),
    preset: pick("preset"),
    fps: pick("fps"),
    videoBitrateKbps: pick("videoBitrateKbps"),
    target: pick("target"),
    session: s.session ?? null,
    restarts: pick("restarts"),
    lastError: s.lastError ?? null,
    relay: pick("relay"),
    recording: pick("recording"),
    stats: pick("stats"),
    capabilities: s.capabilities ?? {},
    legacyKeyConfigured: pick("legacyKeyConfigured") === true,
  };
}

export function streamingRoutes(db: Db, deps: StreamingDeps): Router {
  const router = Router();
  const publicKey = deps.publicKey ?? (() => readPublicKey());
  const base = deps.broadcastBaseUrl ?? process.env.STREAMER_BROADCAST_BASE_URL ?? "http://web:3000/broadcast";
  const allowInternalIngest = deps.allowInternalIngest ?? process.env.STREAMING_ALLOW_INTERNAL_INGEST === "1";
  const actor = (req: Request) => req.auth?.userId ?? null;

  // EQ5c (P2-4) · cerrojo de las operaciones de control (start/restart/stop):
  // en serie dentro del proceso. Entre procesos lo cubren dos órdenes: el stop
  // marca la BD ANTES de llamar al streamer (stopSession) y start/restart
  // recomprueban la sesión y `enabled` DESPUÉS de su respuesta (stopIfCancelled).
  let controlChain: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = controlChain.then(fn, fn);
    controlChain = run.catch(() => undefined);
    return run;
  }
  const log = (req: Request, action: string, target: string, detail: Record<string, unknown> = {}) =>
    audit(db, { actorId: actor(req), action, target, detail, correlationId: req.correlationId });

  async function streamerStatus(): Promise<{ reachable: boolean; status: StreamerStatus | null; error?: string }> {
    if (!deps.streamer.configured) return { reachable: false, status: null, error: "streamer no configurado" };
    try {
      const r = await deps.streamer.call<StreamerStatus>("GET", "/status");
      return r.ok
        ? { reachable: true, status: r.body }
        : { reachable: false, status: null, error: `estado ${r.status}` };
    } catch (e) {
      return { reachable: false, status: null, error: (e as Error).message };
    }
  }

  async function credentialsMeta(s: StreamingSettings) {
    const pk = publicKey();
    const rows = await db("streaming_credentials").select("platform", "key_id", "last4", "updated_at", "sealed");
    return PLATFORMS.map((p) => {
      const r = rows.find((x: Record<string, unknown>) => x.platform === p.id);
      // Sellada con otra clave pública (rotada) o para otra ingesta (EQ5c): hay que volver a introducirla.
      let incompatibleReason: "key_rotated" | "ingest_changed" | null = null;
      if (r) {
        if (!pk || r.key_id !== pk.kid) incompatibleReason = "key_rotated";
        else if (!sealedBoundTo(parseSealed(r.sealed), credentialBinding(s, p.id)))
          incompatibleReason = "ingest_changed";
      }
      return {
        platform: p.id,
        configured: !!r,
        masked: r ? `****${r.last4}` : null,
        updatedAt: r ? new Date(r.updated_at).toISOString() : null,
        compatible: r ? incompatibleReason === null : null,
        incompatibleReason,
      };
    });
  }

  async function activeSession() {
    return db("streaming_sessions").where({ state: "active" }).first();
  }

  /** STREAMER §3 · última sesión terminada (sin la config: no hace falta y es más superficie). */
  async function lastSessionView() {
    const r = await db("streaming_sessions")
      .whereNot({ state: "active" })
      .orderBy([
        { column: "stopped_at", order: "desc", nulls: "last" },
        { column: "started_at", order: "desc" },
      ])
      .first();
    if (!r) return null;
    return {
      id: r.id,
      state: r.state,
      mode: r.mode,
      target: r.target_kind ? { kind: r.target_kind, id: r.target_id } : null,
      startedAt: new Date(r.started_at).toISOString(),
      stoppedAt: r.stopped_at ? new Date(r.stopped_at).toISOString() : null,
      stopReason: r.stop_reason ?? null,
    };
  }

  async function refreshGauges(): Promise<void> {
    if (!deps.setGauge) return;
    try {
      const s = await loadSettings(db);
      const act = await activeSession();
      deps.setGauge("s9_streaming_enabled", s.enabled ? 1 : 0);
      deps.setGauge("s9_streaming_session_active", act ? 1 : 0);
    } catch {
      /* sin la tabla (BD sin migrar): sin señal, que es lo honesto */
    }
  }
  void refreshGauges();

  async function credentialStamp(platform: string): Promise<string | null> {
    const r = await db("streaming_credentials").where({ platform }).first();
    return r ? `${r.key_id}:${new Date(r.updated_at).toISOString()}` : null;
  }

  /** Orden de arranque para el streamer (la credencial va SELLADA). */
  async function buildStartBody(
    s: StreamingSettings,
    sessionId: string,
    t: { kind: "battle" | "tournament"; id: string },
  ) {
    const body: Record<string, unknown> = {
      sessionId,
      broadcastUrl: broadcastUrlFor(base, t, s.branding),
      mode: s.mode,
      encoder: s.encoder,
      preset: s.preset,
      fps: s.fps,
      videoBitrateKbps: s.videoBitrateKbps,
    };
    if (s.mode === "rtmps") {
      const ingest = effectiveIngest(s);
      if (!ingest) throw conflict("ingest_missing", "RTMPS personalizado sin URL de ingesta");
      const cred = await db("streaming_credentials").where({ platform: s.platform }).first();
      if (!cred) throw conflict("credential_missing", "No hay clave de emisión configurada para esta plataforma");
      const pk = publicKey();
      if (pk && cred.key_id !== pk.kid) {
        throw conflict("credential_stale", "La clave se guardó con otra clave de sellado: vuelve a introducirla");
      }
      // EQ5c (P2-2) · la clave sólo viaja hacia el destino al que se selló.
      const sealed = parseSealed(cred.sealed);
      if (!sealedBoundTo(sealed, credentialBinding(s, s.platform))) {
        throw conflict(
          "credential_unbound",
          "La clave se guardó para otra URL de ingesta (o en un formato antiguo): vuelve a introducirla",
        );
      }
      body.ingestUrl = ingest;
      body.platform = s.platform;
      body.credential = sealed;
    }
    return body;
  }

  function uxState(
    s: StreamingSettings,
    st: { reachable: boolean; status: StreamerStatus | null },
    session: { mode?: unknown } | null | undefined,
  ) {
    if (!s.enabled) return "disabled";
    if (!st.reachable) return "streamer_unreachable";
    const state = st.status?.state;
    if (state === "failed") return "failed";
    if (state === "retrying") return "retrying";
    if (state === "streaming") {
      // EQ5e (R3-D) · el modo de la EMISIÓN en curso (el del streamer; si no lo
      // dice, el de la sesión), no el guardado: con un cambio de modo pendiente de
      // reinicio, la configuración ya no describe lo que se está emitiendo.
      const mode = emissionMode(st.status) ?? session?.mode ?? s.mode;
      if (mode === "record") return "recording";
      // EQ5d (revisión EQ6c, P3) · «En directo» sólo con el relé PUBLICANDO; mientras
      // conecta (o reconecta) es «Iniciando», no una emisión que nadie recibe.
      const relay = (st.status as { relay?: { state?: unknown } | null } | null)?.relay;
      return relay?.state === "publishing" ? "live" : "starting";
    }
    if (session) return "interrupted"; // la BD dice activa y el streamer no emite
    return "ready";
  }

  // ── lectura ───────────────────────────────────────────────────────────────
  defineOperation(router, "getStreamingAdmin", async (_req, res) => {
    const s = await loadSettings(db);
    const st = await streamerStatus();
    const session = await activeSession();
    const stamp = await credentialStamp(s.platform);
    const pendingRestart = !!session && canon(session.config) !== canon(appliedConfig(s, stamp));
    await refreshGauges();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      settings: s,
      platforms: PLATFORMS,
      credentials: await credentialsMeta(s),
      capabilities: {
        sealedStore: !!publicKey(),
        streamerConfigured: deps.streamer.configured,
        streamerReachable: st.reachable,
        streamerError: st.reachable ? null : (st.error ?? null),
        nvenc: st.status?.capabilities?.nvenc ?? null,
      },
      streamer: publicStatus(st.status),
      session: session
        ? {
            id: session.id,
            mode: session.mode,
            target: session.target_kind ? { kind: session.target_kind, id: session.target_id } : null,
            startedAt: new Date(session.started_at).toISOString(),
            startedBy: session.started_by,
          }
        : null,
      lastSession: await lastSessionView(),
      pendingRestart,
      uxState: uxState(s, st, session),
      bitrate: bitrateRecommendation(s.preset, s.fps),
      changeClasses: CHANGE_CLASSES,
    });
  });

  defineOperation(router, "getStreamingTarget", async (req, res) => {
    const t = parseTarget(req.query.kind, req.query.id);
    if (!t) throw badRequest("kind (battle|tournament) e id (UUID) obligatorios");
    const info = await resolveTarget(db, t);
    if (!info) throw notFound("Destino no encontrado");
    res.json(info);
  });

  // ── configuración ─────────────────────────────────────────────────────────
  defineOperation(router, "updateStreamingSettings", async (req, res) => {
    const patch = (req.body ?? {}) as Record<string, unknown>;
    if (typeof patch !== "object" || Array.isArray(patch)) throw badRequest("cuerpo inválido");
    if (!Number.isInteger(patch.version)) throw badRequest("version obligatoria (concurrencia optimista)");
    const current = await loadSettings(db);
    if (patch.version !== current.version) {
      throw conflict("version_conflict", "Otro administrador cambió la configuración: recarga antes de guardar", {
        currentVersion: current.version,
      });
    }
    const st = await streamerStatus();
    const r = applySettingsPatch(current, patch, {
      nvenc: st.status?.capabilities?.nvenc ?? null,
      allowInternalIngest,
    });
    if (r.errors.length) throw new ApiError(422, "invalid_settings", r.errors.join("; "), { errors: r.errors });
    const session = await activeSession();
    const disabling = current.enabled && !r.next.enabled;
    if (disabling && session && patch.confirmStop !== true) {
      throw conflict("stop_required", "Desactivar el streaming detiene la emisión en curso: confírmalo (confirmStop)");
    }
    if (r.changed.length === 0) {
      res.json({ settings: current, changed: [], warnings: r.warnings, pendingRestart: false, stopped: false });
      return;
    }
    const updated = await db("streaming_settings")
      .where({ id: 1, version: current.version })
      .update({
        enabled: r.next.enabled,
        mode: r.next.mode,
        platform: r.next.platform,
        ingest_url: r.next.ingestUrl,
        encoder: r.next.encoder,
        preset: r.next.preset,
        fps: r.next.fps,
        video_bitrate_kbps: r.next.videoBitrateKbps,
        branding: JSON.stringify(r.next.branding),
        retention: JSON.stringify(r.next.retention),
        version: current.version + 1,
        updated_at: db.fn.now(),
        updated_by: actor(req),
      });
    if (updated !== 1) throw conflict("version_conflict", "Otro administrador cambió la configuración: recarga");
    // Auditoría: qué campos y sus valores NO sensibles (la configuración no lleva secretos).
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of r.changed) {
      diff[k] = {
        from: (current as unknown as Record<string, unknown>)[k],
        to: (r.next as unknown as Record<string, unknown>)[k],
      };
    }
    await log(req, "streaming.settings.update", "streaming:settings", { changed: diff });

    // EQ5d (revisión EQ6c, P2) · «leer la sesión y pararla» DENTRO del cerrojo y
    // DESPUÉS de guardar `enabled=false`: un start en vuelo que aún no había
    // insertado su sesión la encuentra aquí, o bien él mismo vuelve a leer
    // `enabled` al responder el streamer (stopIfCancelled) y se para. Entre dos
    // instancias, una de las dos lecturas ve la otra escritura.
    let stopped = false;
    if (disabling) {
      stopped = await serialized(async () => {
        if (!(await activeSession())) return false;
        await stopSession(req, "disabled");
        return true;
      });
    }
    const saved = await loadSettings(db);
    const after = await activeSession();
    const stamp = await credentialStamp(saved.platform);
    await refreshGauges();
    // EQ5c · cambiar la ingesta invalida las claves selladas para la anterior: se avisa.
    if (r.changed.some((k) => k === "ingestUrl" || k === "platform")) {
      for (const m of await credentialsMeta(saved)) {
        if (m.configured && m.incompatibleReason === "ingest_changed") {
          r.warnings.push(`la clave de ${m.platform} está sellada para otra URL de ingesta: vuelve a introducirla`);
        }
      }
    }
    res.json({
      settings: saved,
      changed: r.changed,
      warnings: r.warnings,
      impact: Object.fromEntries(r.changed.map((k) => [k, CHANGE_CLASSES[k] ?? "hot"])),
      pendingRestart: !!after && canon(after.config) !== canon(appliedConfig(saved, stamp)),
      stopped,
    });
  });

  // ── credenciales ──────────────────────────────────────────────────────────
  defineOperation(router, "setStreamingCredential", async (req, res) => {
    const platform = platformById(req.params.platform);
    if (!platform) throw notFound("Plataforma desconocida");
    const key = (req.body ?? {}).streamKey;
    if (!validStreamKey(key)) throw badRequest("La clave debe tener 8-256 caracteres imprimibles, sin espacios");
    const pk = publicKey();
    if (!pk) {
      // §3/§19: sin almacén sellado NO se guarda nada (nunca en claro).
      throw new ApiError(
        503,
        "sealed_store_unavailable",
        "No hay clave pública de sellado: no se pueden guardar claves",
      );
    }
    // EQ5c (P2-2) · la clave se sella atada a SU destino: plataforma + ingesta.
    const bind = credentialBinding(await loadSettings(db), platform.id);
    if (!bind) {
      throw conflict("ingest_missing", "Configura y guarda primero la URL de ingesta: la clave queda atada a ella");
    }
    const sealed = sealSecret(key, pk.pem, bind);
    const last4 = key.slice(-4);
    await db("streaming_credentials")
      .insert({
        platform: platform.id,
        sealed: JSON.stringify(sealed),
        key_id: sealed.kid,
        last4,
        updated_at: db.fn.now(),
        updated_by: actor(req),
      })
      .onConflict("platform")
      .merge();
    await log(req, "streaming.credential.set", `streaming:credential:${platform.id}`, { platform: platform.id });
    const session = await activeSession();
    res.json({
      platform: platform.id,
      configured: true,
      masked: `****${last4}`,
      appliesOnNextStart: !!session,
    });
  });

  defineOperation(router, "deleteStreamingCredential", async (req, res) => {
    const platform = platformById(req.params.platform);
    if (!platform) throw notFound("Plataforma desconocida");
    const n = await db("streaming_credentials").where({ platform: platform.id }).del();
    if (n > 0)
      await log(req, "streaming.credential.delete", `streaming:credential:${platform.id}`, { platform: platform.id });
    res.json({ platform: platform.id, configured: false, deleted: n > 0 });
  });

  // ── controles ─────────────────────────────────────────────────────────────
  async function callStreamer(method: "GET" | "POST", path: string, body?: unknown) {
    try {
      return await deps.streamer.call(method, path, body);
    } catch (e) {
      if (e instanceof StreamerUnavailable) throw unavailable(e.message);
      throw e;
    }
  }

  /**
   * EQ5d (revisión EQ6c, P3) · la sesión se marca parada en BD ANTES de pedir el
   * stop al streamer. Así, entre dos instancias de la API, un start/restart en
   * vuelo cuya recomprobación llegue después del marcado se para solo, y uno
   * cuya recomprobación llegue antes tiene su efecto ANTES que este stop: en
   * ningún orden queda el streamer emitiendo sin sesión activa. Si el streamer
   * no responde, la sesión queda parada igualmente (la intención del operador
   * manda) y, sin `force`, se responde 503 para que lo sepa y lo repita.
   */
  async function stopSession(req: Request, reason: string, force = false) {
    const session = await activeSession();
    let marked = false;
    if (session) {
      marked =
        (await db("streaming_sessions")
          .where({ id: session.id, state: "active" })
          .update({ state: "stopped", stopped_at: db.fn.now(), stopped_by: actor(req), stop_reason: reason })) === 1;
    }
    let streamerOk = true;
    let failure: Error | null = null;
    try {
      const r = await deps.streamer.call("POST", "/control/stop", {});
      streamerOk = r.ok;
    } catch (e) {
      streamerOk = false;
      failure = e as Error;
    }
    if (marked) {
      await log(req, "streaming.session.stop", `streaming:session:${session.id}`, {
        reason,
        streamerOk,
        forced: force,
      });
    }
    if (failure && !force) throw unavailable(failure.message);
    return { wasActive: marked, streamerOk };
  }

  defineOperation(router, "testStreaming", async (req, res) => {
    const s = await loadSettings(db);
    if (s.mode !== "rtmps") throw conflict("not_rtmps", "La prueba de ingesta sólo aplica al modo RTMPS");
    const body = await buildStartBody(s, "test", { kind: "battle", id: "00000000-0000-0000-0000-000000000000" });
    const r = await callStreamer("POST", "/control/test", {
      ingestUrl: body.ingestUrl,
      platform: body.platform,
      credential: body.credential,
    });
    await log(req, "streaming.test", "streaming:ingest", {
      platform: s.platform,
      ok: (r.body as Record<string, unknown>).ok === true,
    });
    if (!r.ok) throw new ApiError(502, "streamer_error", String((r.body as Record<string, unknown>).error ?? "error"));
    res.json(r.body);
  });

  defineOperation(router, "startStreaming", async (req, res) => {
    const t = parseTarget((req.body ?? {}).target?.kind, (req.body ?? {}).target?.id);
    if (!t) throw badRequest("target {kind: battle|tournament, id: UUID} obligatorio");
    // EQ5d (P2) · comprobaciones previas (y la medida del disco, que es lenta)
    // FUERA del cerrojo: un PUT `enabled:false` no espera detrás de ellas.
    const pre = await startPrecheck(t);
    await serialized(() => startLocked(req, res, t, pre));
  });

  /** Comprobaciones que no cambian el estado: fallan pronto sin tomar el cerrojo. */
  async function startPrecheck(t: { kind: "battle" | "tournament"; id: string }): Promise<{ diskCheckedFor: string }> {
    const s = await loadSettings(db);
    if (!s.enabled) throw conflict("streaming_disabled", "El streaming está desactivado: actívalo antes de emitir");
    const info = await resolveTarget(db, t);
    if (!info) throw notFound("Destino no encontrado");
    // VISIBILIDAD · la condición ya NO es «todos los bots públicos» sino «el destino está
    // autorizado para retransmisión» (resolveTarget → wherePubliclyShowable), con el motivo real.
    if (!info.broadcastable) {
      throw conflict(
        info.broadcastBlockedReason ?? "target_not_broadcastable",
        info.broadcastBlockedReason === "tournament_not_broadcastable"
          ? "La batalla tiene bots no públicos y su torneo no autoriza la retransmisión"
          : "La batalla no es de un torneo retransmisible y tiene bots no públicos: /broadcast (anónima) no podría mostrarla",
      );
    }
    if (s.mode === "record") await checkDisk();
    return { diskCheckedFor: s.mode };
  }

  // «Llenar el disco»: no se empieza a GRABAR con menos de MIN_FREE_BYTES libres
  // (la retención por tamaño evita que crezca sin límite; esto evita empezar sin sitio).
  async function checkDisk(): Promise<void> {
    const rec = await callStreamer("GET", "/recordings");
    const free = (rec.body as { disk?: { freeBytes?: number } | null }).disk?.freeBytes;
    // EQ5c (P3) · fail-closed: sin medida del disco no se empieza a grabar.
    if (!rec.ok || typeof free !== "number" || !Number.isFinite(free)) {
      throw conflict("disk_unknown", "El streamer no pudo medir el espacio libre: no se empieza a grabar");
    }
    if (free < MIN_FREE_BYTES) {
      throw conflict("disk_low", `Queda poco espacio para grabar (${Math.round(free / 1024 ** 2)} MiB libres)`);
    }
  }

  /**
   * Recomprobación al responder el streamer: si la sesión ya no está activa (un
   * stop ganó la carrera) o el streaming se DESACTIVÓ mientras arrancaba
   * (EQ5d, P2), para el streamer de verdad y lo audita. Devuelve el motivo o null.
   */
  async function stopIfCancelled(
    req: Request,
    sessionId: string,
    action: string,
  ): Promise<"stopped_during_operation" | "disabled_during_operation" | null> {
    const still = await db("streaming_sessions").where({ id: sessionId, state: "active" }).first();
    const enabled = (await loadSettings(db)).enabled;
    if (still && enabled) return null;
    const reason = still ? "disabled_during_operation" : "stopped_during_operation";
    if (still) {
      // Marcar antes de parar (mismo orden que stopSession).
      await db("streaming_sessions")
        .where({ id: sessionId, state: "active" })
        .update({ state: "stopped", stopped_at: db.fn.now(), stopped_by: actor(req), stop_reason: "disabled" });
    }
    const other = await activeSession();
    let streamerOk = false;
    if (!other) {
      try {
        // STREAMER · condicionado a ESTA sesión: sólo se para lo que ella arrancó.
        const r = await deps.streamer.call("POST", "/control/stop", { ifSession: sessionId });
        streamerOk = r.ok || r.status === 409;
      } catch {
        streamerOk = false;
      }
    } else {
      // EQ5e (R3-B) · hay OTRA sesión activa: sólo se para si el streamer dice
      // que emite una sesión distinta de ella (la nuestra, ya cancelada).
      streamerOk =
        (await reconcileOrphanEmission(db, deps.streamer, {
          trigger: action,
          actorId: actor(req),
          correlationId: req.correlationId,
        })) === "stopped";
    }
    await log(req, action, `streaming:session:${sessionId}`, {
      reason,
      streamerStopped: streamerOk,
      otherSessionActive: !!other,
    });
    await refreshGauges();
    return reason;
  }

  /**
   * EQ5e (R3-E) · stop compensatorio tras un start sin respuesta fiable. Si no
   * hay otra sesión activa, se para ESTA sesión (stop condicionado `ifSession`,
   * STREAMER/#241); si la hay, sólo se para lo huérfano. Queda auditado con el
   * resultado (`stopped`, `nothing_to_stop`, `stop_rejected`, `stop_unreachable`).
   */
  async function compensateStart(req: Request, sessionId: string, cause: string): Promise<void> {
    const other = await activeSession();
    let outcome: string;
    if (!other) {
      try {
        // STREAMER · condicionado a ESTA sesión (no corta otra que hubiera
        // ocupado el streamer) y, #241 (obs.), `stopped` sólo si de verdad emitía.
        const r = await deps.streamer.call<{ wasActive?: boolean }>("POST", "/control/stop", {
          ifSession: sessionId,
        });
        outcome =
          r.status === 409 || (r.ok && r.body?.wasActive === false)
            ? "nothing_to_stop"
            : r.ok
              ? "stopped"
              : "stop_rejected";
      } catch {
        outcome = "stop_unreachable";
      }
    } else {
      outcome =
        (await reconcileOrphanEmission(db, deps.streamer, {
          trigger: "start_compensation",
          actorId: actor(req),
          correlationId: req.correlationId,
        })) ?? "not_orphan";
    }
    await log(req, "streaming.session.start_compensated", `streaming:session:${sessionId}`, {
      cause,
      outcome,
      otherSessionActive: !!other,
    });
  }

  async function startLocked(
    req: Request,
    res: Response,
    t: { kind: "battle" | "tournament"; id: string },
    pre: { diskCheckedFor: string },
  ) {
    // Dentro del cerrojo se VUELVE a leer la configuración: pudo cambiar (o
    // desactivarse) mientras se hacían las comprobaciones previas.
    const s = await loadSettings(db);
    if (!s.enabled) throw conflict("streaming_disabled", "El streaming está desactivado: actívalo antes de emitir");
    const stamp = await credentialStamp(s.platform);
    const config = appliedConfig(s, stamp);
    let existing = await activeSession();
    if (existing) {
      // STREAMER §13 (RESTART_RECOVERY) · la BD dice «activa» pero el streamer,
      // que RESPONDE, no emite nada (reintentos agotados, streamer reiniciado,
      // proceso caído): la sesión está muerta. Antes, un START devolvía
      // `alreadyActive` y no emitía nada; ahora se cierra como `failed`
      // (auditado) y se arranca de nuevo. Si el streamer no responde no se toca
      // nada (no se sabe si emite).
      const st = await streamerStatus();
      const emitting = st.reachable && (st.status?.state === "streaming" || st.status?.state === "retrying");
      if (st.reachable && !emitting) {
        const closed = await db("streaming_sessions")
          .where({ id: existing.id, state: "active" })
          .update({ state: "failed", stopped_at: db.fn.now(), stop_reason: "not_emitting" });
        if (closed === 1) {
          await log(req, "streaming.session.recovered", `streaming:session:${existing.id}`, {
            streamerState: st.status?.state ?? "unknown",
            lastError: st.status?.lastError?.message ?? null,
          });
        }
        existing = await activeSession();
      }
    }
    if (existing) {
      // Idempotencia: el MISMO destino y configuración ⇒ la misma sesión, sin tocar nada.
      if (existing.target_kind === t.kind && existing.target_id === t.id && canon(existing.config) === canon(config)) {
        res.json({ session: { id: existing.id, target: t }, alreadyActive: true });
        return;
      }
      throw conflict("already_active", "Ya hay una emisión activa: detenla antes de iniciar otra", {
        session: { id: existing.id, target: { kind: existing.target_kind, id: existing.target_id } },
      });
    }
    // Si el modo pasó a «record» después de la comprobación previa, se mide aquí.
    if (s.mode === "record" && pre.diskCheckedFor !== "record") await checkDisk();
    const sessionId = randomUUID();
    const body = await buildStartBody(s, sessionId, t);
    try {
      await db("streaming_sessions").insert({
        id: sessionId,
        state: "active",
        mode: s.mode,
        target_kind: t.kind,
        target_id: t.id,
        config: JSON.stringify(config),
        started_by: actor(req),
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        throw conflict("already_active", "Ya hay una emisión activa (otra petición simultánea)");
      }
      throw e;
    }
    let r;
    try {
      r = await deps.streamer.call("POST", "/control/start", body);
    } catch (e) {
      await db("streaming_sessions")
        .where({ id: sessionId })
        .update({ state: "failed", stopped_at: db.fn.now(), stop_reason: "streamer_unreachable" });
      // EQ5e (R3-E) · el plazo pudo vencer DESPUÉS de que el streamer aplicara la
      // orden: sin respuesta no se sabe, así que se compensa con un stop.
      await compensateStart(req, sessionId, "streamer_unreachable");
      await refreshGauges();
      throw unavailable((e as Error).message);
    }
    if (!r.ok) {
      await db("streaming_sessions")
        .where({ id: sessionId })
        .update({ state: "failed", stopped_at: db.fn.now(), stop_reason: `streamer_${r.status}` });
      await log(req, "streaming.session.start_failed", `streaming:session:${sessionId}`, {
        status: r.status,
        target: t,
      });
      if (r.status >= 500) {
        // EQ5e (R3-E) · un 5xx tampoco garantiza que la orden no se aplicara.
        await compensateStart(req, sessionId, `streamer_${r.status}`);
      } else if (r.status === 409) {
        // EQ5e (R3-B) · el streamer YA emite algo y esta sesión no llegó a emitir:
        // si lo que emite no es una sesión activa en BD, es huérfano y se para.
        await reconcileOrphanEmission(db, deps.streamer, {
          trigger: "start_conflict",
          actorId: actor(req),
          correlationId: req.correlationId,
        });
      }
      await refreshGauges();
      const msg = String((r.body as Record<string, unknown>).error ?? "el streamer rechazó la orden");
      throw new ApiError(r.status === 409 ? 409 : 502, r.status === 409 ? "streamer_busy" : "streamer_error", msg);
    }
    // EQ5c (P2-4) · recomprobación: si mientras el streamer arrancaba alguien
    // (otra instancia de la API) paró la sesión, el stop confirmado manda.
    const cancelled = await stopIfCancelled(req, sessionId, "streaming.session.start_cancelled");
    if (cancelled === "disabled_during_operation") {
      throw conflict("streaming_disabled", "El streaming se desactivó mientras arrancaba: no queda nada emitiendo");
    }
    if (cancelled) {
      throw conflict("start_cancelled", "La emisión se detuvo mientras arrancaba: no queda nada emitiendo");
    }
    await log(req, "streaming.session.start", `streaming:session:${sessionId}`, {
      target: t,
      mode: s.mode,
      platform: s.mode === "rtmps" ? s.platform : null,
      preset: s.preset,
      fps: s.fps,
      videoBitrateKbps: s.videoBitrateKbps,
    });
    await refreshGauges();
    res.status(201).json({
      session: { id: sessionId, target: t },
      alreadyActive: false,
      streamer: publicStatus(r.body as StreamerStatus),
    });
  }

  defineOperation(router, "restartStreaming", async (req, res) => {
    await serialized(() => restartLocked(req, res));
  });

  async function restartLocked(req: Request, res: Response) {
    const session = await activeSession();
    if (!session) throw conflict("not_active", "No hay emisión activa que reiniciar");
    const s = await loadSettings(db);
    if (!s.enabled) throw conflict("streaming_disabled", "El streaming está desactivado");
    const t = { kind: session.target_kind, id: session.target_id };
    const body = { ...(await buildStartBody(s, session.id, t)), replace: true };
    const r = await callStreamer("POST", "/control/start", body);
    if (!r.ok) throw new ApiError(502, "streamer_error", String((r.body as Record<string, unknown>).error ?? "error"));
    // EQ5c (P2-4) · el reinicio no resucita una emisión que se paró mientras volaba.
    const cancelled = await stopIfCancelled(req, session.id, "streaming.session.restart_cancelled");
    if (cancelled === "disabled_during_operation") {
      throw conflict("streaming_disabled", "El streaming se desactivó mientras se reiniciaba: no queda nada emitiendo");
    }
    if (cancelled) {
      throw conflict("not_active", "La emisión se detuvo mientras se reiniciaba: no queda nada emitiendo");
    }
    const stamp = await credentialStamp(s.platform);
    await db("streaming_sessions")
      .where({ id: session.id, state: "active" })
      .update({ config: JSON.stringify(appliedConfig(s, stamp)), mode: s.mode });
    await log(req, "streaming.session.restart", `streaming:session:${session.id}`, { target: t });
    res.json({ session: { id: session.id, target: t }, restarted: true });
  }

  defineOperation(router, "stopStreaming", async (req, res) => {
    const force = (req.body ?? {}).force === true;
    const r = await serialized(() => stopSession(req, force ? "forced" : "operator", force));
    await refreshGauges();
    res.json(r);
  });

  // ── grabaciones y retención ───────────────────────────────────────────────
  defineOperation(router, "listStreamingRecordings", async (_req, res) => {
    const r = await callStreamer("GET", "/recordings");
    if (!r.ok) throw new ApiError(502, "streamer_error", "el streamer no devolvió las grabaciones");
    res.setHeader("Cache-Control", "no-store");
    res.json(r.body);
  });

  defineOperation(router, "applyStreamingRetention", async (req, res) => {
    const dryRun = (req.body ?? {}).dryRun === true;
    const s = await loadSettings(db);
    const result = await runRetention(db, deps.streamer, s, {
      dryRun,
      actorId: actor(req),
      trigger: "manual",
      correlationId: req.correlationId,
    });
    res.json(result);
  });

  defineOperation(router, "listStreamingAudit", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const rows = await db("audit_log").where("action", "like", "streaming.%").orderBy("id", "desc").limit(limit);
    res.json(
      rows.map((r: Record<string, unknown>) => ({
        id: String(r.id),
        actorId: r.actor_id ?? undefined,
        action: r.action,
        target: r.target,
        detail: r.detail,
        at: (r.at as Date).toISOString(),
      })),
    );
  });

  return router;
}

/** Modo de la emisión en curso según el streamer (`session.mode`, si no `mode`). */
function emissionMode(st: StreamerStatus | null): string | null {
  if (!st) return null;
  const sm = (st.session as { mode?: unknown } | null | undefined)?.mode;
  if (typeof sm === "string") return sm;
  const m = (st as Record<string, unknown>).mode;
  return typeof m === "string" ? m : null;
}

/**
 * EQ5e (R3-B, R3-E) · Reconciliación: para un streamer que EMITE (o lo intenta)
 * sin una sesión activa en BD que le corresponda. Huérfana = no hay sesión
 * activa, o el streamer dice qué sesión emite y no es la activa.
 *
 * Orden: primero el estado del streamer y DESPUÉS la BD. Un start legítimo
 * inserta su sesión ANTES de llamar al streamer, así que si el streamer ya la
 * emite, la BD leída después la tiene activa.
 *
 * STREAMER (#241, R4-1) · esa foto del streamer puede ser VIEJA (latencia, o un
 * stop(A)+start(B) del operador entre la foto y la lectura de la BD) y el stop
 * puede aterrizar DESPUÉS de un start nuevo. Por eso:
 *  1. tras leer la BD se VUELVE a leer `/status`: sólo es huérfana si la segunda
 *     foto sigue emitiendo la MISMA sesión y la BD no la tiene activa;
 *  2. el stop va CONDICIONADO a esa sesión (`ifSession`): si al llegar el
 *     streamer emite otra, responde 409 `session_mismatch` y no para nada.
 * Así el reconciliador ya no puede cortar una sesión legítima aunque no tome el
 * cerrojo de la ruta (que es por proceso y no cubre otras instancias).
 *
 * Devuelve "stopped", "stop_failed" o null (nada que hacer / sin señal / la
 * emisión cambió entretanto). `memo` (sólo el reconciliador periódico) evita
 * repetir la auditoría `stop_failed` de la MISMA emisión en cada tick.
 */
export interface ReconcileMemo {
  lastFailed?: string | null;
}

async function emittingSnapshot(streamer: StreamerClient): Promise<{ emitting: boolean; id: string | null } | null> {
  try {
    const r = await streamer.call<StreamerStatus>("GET", "/status");
    if (!r.ok) return null;
    const st = r.body;
    const emitting = st.desired === true || st.state === "streaming" || st.state === "retrying";
    return { emitting, id: st.session?.sessionId ?? null };
  } catch {
    return null;
  }
}

export async function reconcileOrphanEmission(
  db: Db,
  streamer: StreamerClient,
  o: { trigger: string; actorId?: string | null; correlationId?: string; memo?: ReconcileMemo },
): Promise<"stopped" | "stop_failed" | null> {
  if (!streamer.configured) return null;
  const first = await emittingSnapshot(streamer);
  if (!first || !first.emitting) {
    if (o.memo) o.memo.lastFailed = null;
    return null;
  }
  const emittingId = first.id;
  const act = await db("streaming_sessions").where({ state: "active" }).first();
  const orphan = !act || (emittingId !== null && emittingId !== act.id);
  if (!orphan) return null;
  // R4-1 (1) · segunda foto DESPUÉS de la BD: si ya no emite, o emite otra sesión,
  // la primera era vieja y no se toca nada (el siguiente tick decidirá).
  const second = await emittingSnapshot(streamer);
  if (!second || !second.emitting || second.id !== emittingId) return null;
  if (act && second.id === act.id) return null;
  let ok = false;
  let mismatch = false;
  try {
    // R4-1 (2) · stop condicionado: sólo para ESA emisión.
    const r = await streamer.call("POST", "/control/stop", { ifSession: emittingId });
    ok = r.ok;
    mismatch = r.status === 409;
  } catch {
    ok = false;
  }
  if (mismatch) return null; // otra emisión ocupó el streamer: ya no es la huérfana
  const key = emittingId ?? "sin-sesion";
  if (!ok && o.memo && o.memo.lastFailed === key) return "stop_failed"; // ya auditado
  if (o.memo) o.memo.lastFailed = ok ? null : key;
  await audit(db, {
    actorId: o.actorId ?? null,
    action: "streaming.session.orphan_stopped",
    target: `streaming:session:${emittingId ?? "desconocida"}`,
    detail: { trigger: o.trigger, emittingSession: emittingId, activeSession: act?.id ?? null, streamerStopped: ok },
    correlationId: o.correlationId,
  });
  return ok ? "stopped" : "stop_failed";
}

/** EQ5e (R3-B/R3-E) · Reconciliación periódica (por defecto cada 30 s). Sólo la arranca server.ts. */
export function startOrphanReconciler(db: Db, streamer: StreamerClient, everyMs = 30_000): NodeJS.Timeout | null {
  if (!streamer.configured) return null;
  const memo: ReconcileMemo = {};
  let running = false;
  const tick = async () => {
    // Un tick lento (streamer que tarda) no se solapa con el siguiente.
    if (running) return;
    running = true;
    try {
      await reconcileOrphanEmission(db, streamer, { trigger: "periodic", memo });
    } catch (e) {
      console.warn(
        JSON.stringify({
          level: "warn",
          service: "api",
          msg: "reconciliación de emisión fallida",
          detail: (e as Error).message,
        }),
      );
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), everyMs);
  t.unref();
  return t;
}

/**
 * Retención de MP4 (manual o programada): la decide el STREAMER sobre su
 * directorio (nunca replays, ni ficheros ajenos, ni la grabación en curso) y la
 * API audita CADA borrado.
 */
export async function runRetention(
  db: Db,
  streamer: StreamerClient,
  s: StreamingSettings,
  o: { dryRun: boolean; actorId: string | null; trigger: "manual" | "auto"; correlationId?: string },
) {
  const policy = {
    maxAgeDays: s.retention.maxAgeDays,
    maxTotalBytes: s.retention.maxTotalBytes,
  };
  if (policy.maxAgeDays === null && policy.maxTotalBytes === null) {
    throw badRequest("La política de retención no tiene edad ni tamaño máximo");
  }
  let r;
  try {
    r = await streamer.call<Record<string, unknown>>("POST", "/recordings/retention", { policy, dryRun: o.dryRun });
  } catch (e) {
    throw unavailable((e as Error).message);
  }
  if (!r.ok) throw new ApiError(502, "streamer_error", String(r.body.error ?? "retención rechazada"));
  const deleted = (r.body.deleted ?? []) as { name: string; sizeBytes: number; modifiedAt: string; reason: string }[];
  if (!o.dryRun) {
    for (const d of deleted) {
      await audit(db, {
        actorId: o.actorId,
        action: "streaming.recording.deleted",
        target: `recording:${d.name}`,
        detail: { sizeBytes: d.sizeBytes, modifiedAt: d.modifiedAt, reason: d.reason, trigger: o.trigger, policy },
        correlationId: o.correlationId,
      });
    }
    await audit(db, {
      actorId: o.actorId,
      action: "streaming.retention.run",
      target: "streaming:recordings",
      detail: {
        trigger: o.trigger,
        policy,
        deleted: deleted.length,
        errors: (r.body.errors as unknown[] | undefined)?.length ?? 0,
      },
      correlationId: o.correlationId,
    });
  }
  return r.body;
}

/** Retención programada (cada hora) si está activa. Sólo la arranca server.ts. */
export function startRetentionScheduler(db: Db, streamer: StreamerClient, everyMs = 3_600_000): NodeJS.Timeout | null {
  if (!streamer.configured) return null;
  const tick = async () => {
    try {
      const s = await loadSettings(db);
      if (!s.retention.enabled) return;
      await runRetention(db, streamer, s, { dryRun: false, actorId: null, trigger: "auto" });
    } catch (e) {
      console.warn(
        JSON.stringify({
          level: "warn",
          service: "api",
          msg: "retención de grabaciones fallida",
          detail: (e as Error).message,
        }),
      );
    }
  };
  const t = setInterval(() => void tick(), everyMs);
  t.unref();
  return t;
}
