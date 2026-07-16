/** T7.4/T7.5 · Catálogo (lectura pública para el editor; importación admin auditada). */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { audit } from "../audit.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { CatalogImmutableError, getCatalog, importCatalogVersion, listCatalogVersions } from "../services/catalog.js";

export function catalogRoutes(db: Db): Router {
  const router = Router();

  defineOperation(router, "listCatalogVersions", async (_req, res) => {
    res.json(await listCatalogVersions(db));
  });

  defineOperation(router, "listModules", async (req, res) => {
    const modules = await getCatalog(db, req.params.catalogVersion);
    if (modules.length === 0) throw notFound();
    res.json(modules);
  });

  defineOperation(router, "importCatalogVersion", async (req, res) => {
    const { catalogVersion, modules } = req.body ?? {};
    if (typeof catalogVersion !== "string" || !Array.isArray(modules)) {
      throw badRequest("catalogVersion y modules obligatorios");
    }
    try {
      const result = await importCatalogVersion(db, catalogVersion, modules);
      await audit(db, {
        actorId: req.auth!.userId,
        action: "admin.catalog.imported",
        target: `catalog:${catalogVersion}`,
        detail: { inserted: result.inserted, unchanged: result.unchanged },
        correlationId: req.correlationId,
      });
      res.status(201).json(result);
    } catch (e) {
      if (e instanceof CatalogImmutableError) throw conflict("immutable", e.message);
      throw e;
    }
  });

  return router;
}
