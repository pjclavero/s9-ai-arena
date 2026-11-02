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
 */
import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";
import { audit } from "../audit.js";
import { parseLimit } from "../serialize.js";
import { sealSecret } from "../../../../packages/stream-secrets/index.js";
import { StreamerUnavailable, type StreamerClient } from "../services/streamer-client.js";
import {
  appliedConfig,
  applySettingsPatch,
  bitrateRecommendation,
  broadcastUrlFor,
  CHANGE_CLASSES,
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
}

const unavailable = (msg: string) => new ApiError(503, "streamer_unavailable", msg);

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
  session?: { sessionId?: string | null } | null;
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
  const actor = (req: Request) => req.auth?.userId ?? null;
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

  async function credentialsMeta() {
    const pk = publicKey();
    const rows = await db("streaming_credentials").select("platform", "key_id", "last4", "updated_at");
    return PLATFORMS.map((p) => {
      const r = rows.find((x: Record<string, unknown>) => x.platform === p.id);
      return {
        platform: p.id,
        configured: !!r,
        masked: r ? `****${r.last4}` : null,
        updatedAt: r ? new Date(r.updated_at).toISOString() : null,
        // Sellada con otra clave pública (rotada): hay que volver a introducirla.
        compatible: r ? !!pk && r.key_id === pk.kid : null,
      };
    });
  }

  async function activeSession() {
    return db("streaming_sessions").where({ state: "active" }).first();
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
      body.ingestUrl = ingest;
      body.credential = typeof cred.sealed === "string" ? JSON.parse(cred.sealed) : cred.sealed;
    }
    return body;
  }

  function uxState(s: StreamingSettings, st: { reachable: boolean; status: StreamerStatus | null }, session: unknown) {
    if (!s.enabled) return "disabled";
    if (!st.reachable) return "streamer_unreachable";
    const state = st.status?.state;
    if (state === "failed") return "failed";
    if (state === "retrying") return "retrying";
    if (state === "streaming") return s.mode === "record" ? "recording" : "live";
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
      credentials: await credentialsMeta(),
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
    const r = applySettingsPatch(current, patch, { nvenc: st.status?.capabilities?.nvenc ?? null });
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

    let stopped = false;
    if (disabling && session) {
      await stopSession(req, "disabled");
      stopped = true;
    }
    const saved = await loadSettings(db);
    const after = await activeSession();
    const stamp = await credentialStamp(saved.platform);
    await refreshGauges();
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
    const sealed = sealSecret(key, pk.pem);
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

  async function stopSession(req: Request, reason: string, force = false) {
    let streamerOk = true;
    try {
      const r = await deps.streamer.call("POST", "/control/stop", {});
      streamerOk = r.ok;
    } catch (e) {
      streamerOk = false;
      if (!force) throw unavailable((e as Error).message);
    }
    const session = await activeSession();
    if (session) {
      await db("streaming_sessions")
        .where({ id: session.id, state: "active" })
        .update({ state: "stopped", stopped_at: db.fn.now(), stopped_by: actor(req), stop_reason: reason });
      await log(req, "streaming.session.stop", `streaming:session:${session.id}`, {
        reason,
        streamerOk,
        forced: force,
      });
    }
    return { wasActive: !!session, streamerOk };
  }

  defineOperation(router, "testStreaming", async (req, res) => {
    const s = await loadSettings(db);
    if (s.mode !== "rtmps") throw conflict("not_rtmps", "La prueba de ingesta sólo aplica al modo RTMPS");
    const body = await buildStartBody(s, "test", { kind: "battle", id: "00000000-0000-0000-0000-000000000000" });
    const r = await callStreamer("POST", "/control/test", { ingestUrl: body.ingestUrl, credential: body.credential });
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
    const s = await loadSettings(db);
    if (!s.enabled) throw conflict("streaming_disabled", "El streaming está desactivado: actívalo antes de emitir");
    const info = await resolveTarget(db, t);
    if (!info) throw notFound("Destino no encontrado");
    if (!info.publicBroadcastable) {
      throw conflict(
        "target_not_public",
        "La batalla tiene bots no públicos: /broadcast (anónima) no podría mostrarla",
      );
    }
    const stamp = await credentialStamp(s.platform);
    const config = appliedConfig(s, stamp);
    const existing = await activeSession();
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
      await refreshGauges();
      const msg = String((r.body as Record<string, unknown>).error ?? "el streamer rechazó la orden");
      throw new ApiError(r.status === 409 ? 409 : 502, r.status === 409 ? "streamer_busy" : "streamer_error", msg);
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
  });

  defineOperation(router, "restartStreaming", async (req, res) => {
    const session = await activeSession();
    if (!session) throw conflict("not_active", "No hay emisión activa que reiniciar");
    const s = await loadSettings(db);
    if (!s.enabled) throw conflict("streaming_disabled", "El streaming está desactivado");
    const t = { kind: session.target_kind, id: session.target_id };
    const body = { ...(await buildStartBody(s, session.id, t)), replace: true };
    const r = await callStreamer("POST", "/control/start", body);
    if (!r.ok) throw new ApiError(502, "streamer_error", String((r.body as Record<string, unknown>).error ?? "error"));
    const stamp = await credentialStamp(s.platform);
    await db("streaming_sessions")
      .where({ id: session.id })
      .update({ config: JSON.stringify(appliedConfig(s, stamp)), mode: s.mode });
    await log(req, "streaming.session.restart", `streaming:session:${session.id}`, { target: t });
    res.json({ session: { id: session.id, target: t }, restarted: true });
  });

  defineOperation(router, "stopStreaming", async (req, res) => {
    const force = (req.body ?? {}).force === true;
    const r = await stopSession(req, force ? "forced" : "operator", force);
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
