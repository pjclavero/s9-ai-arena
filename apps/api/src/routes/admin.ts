/** T7.4 · Panel de administración: hallazgos de seguridad y auditoría (solo admin). */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { parseLimit } from "../serialize.js";
import { buildEligibilityInventory } from "../services/version-eligibility.js";

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

  // ELIG · H5/H15: inventario de elegibilidad, SOLO LECTURA (transacción READ ONLY).
  // Sin escritura ni en audit_log: el acceso queda en el log estructurado (quién, cuándo).
  defineOperation(router, "getBotVersionEligibilityInventory", async (req, res) => {
    const summaryOnly = req.query.summaryOnly === "true" || req.query.summaryOnly === "1";
    const inv = await buildEligibilityInventory(db, { summaryOnly });
    console.info(
      JSON.stringify({
        audit: "admin.eligibility_inventory.read",
        actorId: req.auth?.userId ?? null,
        correlationId: req.correlationId,
        at: inv.generatedAt,
        summaryOnly,
        total: inv.summary.totalPublishedVersions,
        invalid: inv.summary.currentlyInvalid,
      }),
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(inv);
  });

  return router;
}
