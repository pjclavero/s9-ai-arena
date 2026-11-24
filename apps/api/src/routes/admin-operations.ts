/**
 * ADM-1 · Administración → Órdenes y confirmación en dos pasos. Sólo admin.
 *
 *  - POST /admin/operations              crea la orden (o simula con `dryRun`): impacto calculado por el servidor
 *  - GET  /admin/operations              historial
 *  - GET  /admin/operations/{id}         estado de una orden
 *  - POST /admin/operations/{id}/confirm token de un solo uso + frase literal + REAUTENTICACIÓN FUERTE
 *  - POST /admin/operations/{id}/cancel
 *
 * La API sólo inserta y confirma: NO ejecuta nada ni gana privilegios (ver settings/admin-operations.ts).
 */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { badRequest, notFound, tooMany } from "../errors.js";
import { isUuid } from "../params.js";
import { parseLimit } from "../serialize.js";
import { requireStrongReauth } from "./auth.js";
import type { RateLimiterLike } from "../middleware/shared-rate-limit.js";
import {
  cancelOperation,
  confirmOperation,
  createOperation,
  getOperation,
  listOperations,
} from "../settings/admin-operations.js";

function idParam(raw: unknown): string {
  if (typeof raw !== "string" || !isUuid(raw)) throw notFound();
  return raw;
}

export function adminOperationsRoutes(
  db: Db,
  deps: { confirmLimiter: RateLimiterLike; actionLimiter: RateLimiterLike },
): Router {
  const router = Router();
  const ctx = (req: { auth?: { userId: string }; correlationId?: string }) => ({
    actorId: req.auth?.userId ?? null,
    correlationId: req.correlationId,
  });

  /**
   * ADM-3 · crear y cancelar órdenes `user.*` (y cancelar las ajenas) exige REAUTENTICACIÓN fuerte y tiene límite por
   * admin: con un access token robado no se puede ocupar ni liberar a voluntad el hueco de la recuperación de otros.
   */
  async function reauth(req: { auth?: { userId: string } }, body: Record<string, unknown>): Promise<void> {
    if (!(await deps.actionLimiter.hit(`admin-users:${req.auth!.userId}`))) {
      throw tooMany("Demasiados intentos: espera unos minutos");
    }
    const me = await db("users").where({ id: req.auth!.userId }).first();
    if (!me) throw notFound();
    await requireStrongReauth(db, me, { password: body.password, totp: body.totp });
  }

  defineOperation(router, "createAdminOperation", async (req, res) => {
    let payload = req.body;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const { password, totp, ...rest } = payload as Record<string, unknown>;
      if (typeof rest.kind === "string" && rest.kind.startsWith("user.")) await reauth(req, { password, totp });
      payload = rest;
    }
    const r = await createOperation(db, ctx(req), payload);
    res.setHeader("Cache-Control", "no-store");
    res.status(r.dryRun ? 200 : 201).json(r);
  });

  defineOperation(router, "listAdminOperations", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await listOperations(db, parseLimit(req.query.limit)));
  });

  defineOperation(router, "getAdminOperation", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getOperation(db, idParam(req.params.id)));
  });

  // x-reauth: la reautenticación va PRIMERO (sin credenciales frescas ⇒ 401 aunque el token sea válido).
  defineOperation(router, "confirmAdminOperation", async (req, res) => {
    // Límite de intentos POR ADMIN (antes de verificar la contraseña): frena la fuerza bruta con un token robado.
    if (!(await deps.confirmLimiter.hit(`admin-confirm:${req.auth!.userId}`))) {
      throw tooMany("Demasiados intentos de confirmación: espera unos minutos");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const user = await db("users").where({ id: req.auth!.userId }).first();
    await requireStrongReauth(db, user, { password: body.password, totp: body.totp });
    const id = idParam(req.params.id);
    if (typeof body.phrase !== "string") throw badRequest("phrase es obligatoria");
    const r = await confirmOperation(db, ctx(req), id, { confirmToken: body.confirmToken, phrase: body.phrase });
    res.setHeader("Cache-Control", "no-store");
    res.json(r);
  });

  defineOperation(router, "cancelAdminOperation", async (req, res) => {
    const id = idParam(req.params.id);
    const row = await db("admin_operations").where({ id }).first("kind", "requested_by");
    if (row && (String(row.kind).startsWith("user.") || row.requested_by !== req.auth!.userId)) {
      await reauth(req, (req.body ?? {}) as Record<string, unknown>);
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(await cancelOperation(db, ctx(req), id));
  });

  return router;
}
