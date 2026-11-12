/**
 * MG · Administración → Acceso público / Broadcast. Sólo admin (`x-min-role: admin`
 * en el contrato; el RBAC lo aplica el registry: anónimo ⇒ 401, rol menor ⇒ 403).
 *
 *  - GET  /admin/settings/public-access: valor VIGENTE (releído de la BD), su origen
 *    (BD o entorno), quién y cuándo lo cambió, la latencia máxima de propagación y el
 *    estado efectivo global de la retransmisión con su motivo.
 *  - PATCH /admin/settings/public-access: booleanos ESTRICTOS; cada cambio queda en
 *    `audit_log` (actor, instante, valor anterior y nuevo) en la MISMA transacción.
 *
 * Sin secretos: estos ajustes sólo son dos booleanos.
 */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { badRequest } from "../errors.js";
import { parsePublicAccessPatch, type RuntimeSettingsStore } from "../runtime-settings.js";
import type { BroadcastUnavailableReason } from "../broadcast-effective.js";

export interface RuntimeSettingsDeps {
  /** ¿Hay streamer configurado? (STREAMER_CONTROL_URL). */
  streamerConfigured: boolean;
}

function view(store: RuntimeSettingsStore, deps: RuntimeSettingsDeps) {
  const s = store.snapshot();
  // Estado efectivo GLOBAL: lo mínimo para que /broadcast pueda mostrar una batalla en
  // directo. El detalle por destino (bots, torneo, estado) lo da getStreamingTarget.
  const reason: BroadcastUnavailableReason | null = !s.publicSpectate
    ? "public_spectate_disabled"
    : !deps.streamerConfigured
      ? "streaming_not_configured"
      : null;
  return {
    publicSpectateEnabled: s.publicSpectate,
    publicReplaysEnabled: s.publicReplays,
    source: s.source,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
    propagationMaxMs: s.refreshMs,
    defaults: {
      publicSpectateEnabled: store.defaults.publicSpectate,
      publicReplaysEnabled: store.defaults.publicReplays,
    },
    effective: {
      publicSpectate: s.publicSpectate,
      publicReplays: s.publicReplays,
      broadcastLiveAvailable: reason === null,
      reason,
      // Replays públicos: estado global (la lectura por batalla/bots la da getStreamingTarget).
      publicReplaysAvailable: s.publicReplays,
      replaysReason: (s.publicReplays ? null : "public_replays_disabled") as BroadcastUnavailableReason | null,
    },
  };
}

export function runtimeSettingsRoutes(_db: Db, store: RuntimeSettingsStore, deps: RuntimeSettingsDeps): Router {
  const router = Router();

  defineOperation(router, "getPublicAccessSettings", async (_req, res) => {
    await store.refresh();
    res.setHeader("Cache-Control", "no-store");
    res.json(view(store, deps));
  });

  defineOperation(router, "updatePublicAccessSettings", async (req, res) => {
    const { patch, errors } = parsePublicAccessPatch(req.body);
    if (errors.length) throw badRequest(errors.join("; "));
    const r = await store.update(patch, { actorId: req.auth?.userId ?? null, correlationId: req.correlationId });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ...view(store, deps),
      changed: r.changed,
      before: { publicSpectateEnabled: r.before.publicSpectate, publicReplaysEnabled: r.before.publicReplays },
    });
  });

  return router;
}
