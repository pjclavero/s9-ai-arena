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
import { badRequest, notFound } from "../errors.js";
import { isUuid } from "../params.js";
import { parseLimit } from "../serialize.js";
import { requireStrongReauth } from "./auth.js";
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

export function adminOperationsRoutes(db: Db): Router {
  const router = Router();
  const ctx = (req: { auth?: { userId: string }; correlationId?: string }) => ({
    actorId: req.auth?.userId ?? null,
    correlationId: req.correlationId,
  });

  defineOperation(router, "createAdminOperation", async (req, res) => {
    const r = await createOperation(db, ctx(req), req.body);
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const user = await db("users").where({ id: req.auth!.userId }).first();
    await requireStrongReauth(db, user, { password: body.password, totp: body.totp });
    const id = idParam(req.params.id);
    if (typeof body.confirmToken !== "string" || typeof body.phrase !== "string") {
      throw badRequest("confirmToken y phrase son obligatorios");
    }
    const r = await confirmOperation(db, ctx(req), id, { confirmToken: body.confirmToken, phrase: body.phrase });
    res.setHeader("Cache-Control", "no-store");
    res.json(r);
  });

  defineOperation(router, "cancelAdminOperation", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(await cancelOperation(db, ctx(req), idParam(req.params.id)));
  });

  return router;
}
