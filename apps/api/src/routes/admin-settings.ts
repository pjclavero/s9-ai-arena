/**
 * ADM-1 · Administración → Ajustes del sistema (`system_settings`). Sólo admin (x-min-role del
 * contrato; el RBAC lo aplica el registry).
 *
 *  - GET   /admin/settings: cada clave REGISTRADA con valor vigente, origen, versión, techo del
 *          entorno y si requiere reinicio del consumidor.
 *  - PATCH /admin/settings: lista de `{key, value, expectedVersion}`; atómico, validado en el
 *          servidor y auditado (una fila por clave) en la misma transacción.
 *
 * (`/admin/settings/public-access` es otra ruta, ya existente, y no se toca.)
 */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { listSettings, parsePatchBody, patchSettings } from "../settings/system-settings.js";
import type { SettingsRegistry } from "../../../../packages/system-settings/registry.js";

export interface AdminSettingsDeps {
  registry: SettingsRegistry;
  env?: NodeJS.ProcessEnv;
}

export function adminSettingsRoutes(db: Db, deps: AdminSettingsDeps): Router {
  const router = Router();
  const env = () => deps.env ?? process.env;

  defineOperation(router, "listSystemSettings", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ settings: await listSettings(db, deps.registry, env()) });
  });

  defineOperation(router, "updateSystemSettings", async (req, res) => {
    const items = parsePatchBody(req.body);
    const r = await patchSettings(
      db,
      deps.registry,
      items,
      { actorId: req.auth?.userId ?? null, correlationId: req.correlationId },
      env(),
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(r);
  });

  return router;
}
