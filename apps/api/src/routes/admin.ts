/** T7.4 · Panel de administración: hallazgos de seguridad y auditoría (solo admin). */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { parseLimit } from "../serialize.js";

export function adminRoutes(db: Db): Router {
  const router = Router();

  defineOperation(router, "listSecurityFindings", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const rows = await db("security_findings").orderBy("detected_at", "desc").limit(limit);
    res.json(
      rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        kind: r.kind,
        botId: r.bot_id ?? undefined,
        version: r.version ?? undefined,
        severity: r.severity,
        detail: r.detail,
        detectedAt: (r.detected_at as Date).toISOString(),
      })),
    );
  });

  defineOperation(router, "listAuditLog", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const rows = await db("audit_log").orderBy("id", "desc").limit(limit);
    res.json(
      rows.map((r: Record<string, unknown>) => ({
        id: String(r.id),
        actorId: r.actor_id ?? undefined,
        action: r.action,
        target: r.target,
        correlationId: r.correlation_id ?? undefined,
        at: (r.at as Date).toISOString(),
      })),
    );
  });

  return router;
}
