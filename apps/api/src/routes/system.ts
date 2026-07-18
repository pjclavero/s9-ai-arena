/**
 * R8.6/R8.9 · Sistema/operaciones: estado agregado y matriz RBAC, ambos SOLO
 * LECTURA y solo admin (x-min-role del contrato). No dispara acciones, no toca el
 * runner real ni VM108, y NUNCA expone secretos: de S9_RUN_REAL_DOCKER_E2E y
 * SMOKE_BOT_DIGEST solo se publica un booleano, jamás su valor.
 */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { loadContract } from "../openapi.js";
import { ROLES } from "../db/migrations.js";

/** Cuenta filas agrupadas por una columna y devuelve { valor: n }. */
async function countBy(db: Db, table: string, column: string): Promise<Record<string, number>> {
  const rows = (await db(table).select(column).count<{ c: string }[]>({ c: "*" }).groupBy(column)) as unknown as Array<
    Record<string, unknown>
  >;
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r[column])] = Number(r.c);
  return out;
}

export function systemRoutes(db: Db): Router {
  const router = Router();

  defineOperation(router, "getSystemStatus", async (_req, res) => {
    let databaseOk = true;
    let battlesByStatus: Record<string, number> = {};
    let buildsByStatus: Record<string, number> = {};
    let botVersionsByState: Record<string, number> = {};
    let publishedMaps = 0;
    try {
      battlesByStatus = await countBy(db, "battles", "status");
      buildsByStatus = await countBy(db, "builds", "status");
      botVersionsByState = await countBy(db, "bot_versions", "state");
      const m = await db("map_versions").where({ state: "published" }).count<{ c: string }[]>({ c: "*" }).first();
      publishedMaps = Number(m?.c ?? 0);
    } catch {
      databaseOk = false;
    }

    res.json({
      env: process.env.NODE_ENV ?? "unknown",
      commit: process.env.GIT_COMMIT ?? process.env.COMMIT_SHA ?? "unknown",
      databaseOk,
      // Lectura pura de banderas de operación: nunca se modifican aquí.
      realRunnerEnabled: process.env.S9_RUN_REAL_DOCKER_E2E === "1",
      smokeDigestConfigured: Boolean(process.env.SMOKE_BOT_DIGEST),
      battlesByStatus,
      buildsByStatus,
      botVersionsByState,
      // "ready" para batalla = versión publicada (máquina de estados de bots).
      readyBots: botVersionsByState.published ?? 0,
      publishedMaps,
      // Invariantes de seguridad SIEMPRE vigentes (no configurables desde aquí).
      runtimePolicy: {
        privileged: false,
        dockerSocketMounted: false,
        seccompEnforced: true,
        digestRequired: true,
        signatureRequired: true,
        networkMode: "arena",
      },
    });
  });

  defineOperation(router, "getRbacMatrix", async (_req, res) => {
    const contract = loadContract();
    res.json({
      roles: ROLES.map((name, rank) => ({ name, rank })),
      endpoints: contract.operations
        .map((o) => ({ operationId: o.operationId, method: o.method.toUpperCase(), path: o.path, minRole: o.minRole }))
        .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
    });
  });

  return router;
}
