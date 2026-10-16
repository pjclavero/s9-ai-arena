/**
 * T7.4/T7.5 · Catálogo (lectura pública para el editor; importación admin auditada).
 *
 * FC-C (TD-003) · también el catálogo de RULESETS y MODOS de plataforma: la web
 * obtiene de aquí los ids reales de la tabla `rulesets` (nada de ids hardcodeados),
 * y `checkBattleContent` es la única comprobación de compatibilidad
 * modo ↔ ruleset ↔ mapa que deben usar quienes crean batallas.
 */
import { Router } from "express";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { pathParam } from "../params.js";
import { audit } from "../audit.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { CatalogImmutableError, getCatalog, importCatalogVersion, listCatalogVersions } from "../services/catalog.js";
import { safeLookup } from "../../../../packages/game-rules/safe-lookup.js";

/** Modos de plataforma (contrato compartido RULESET). Orden estable para la UI. */
export const PLATFORM_MODES = ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"] as const;
export type PlatformMode = (typeof PLATFORM_MODES)[number];
export const isPlatformMode = (m: unknown): m is PlatformMode =>
  typeof m === "string" && (PLATFORM_MODES as readonly string[]).includes(m);

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

/** Fila de `rulesets` → forma pública. `mode` sale de `config.mode` (null = agnóstico). */
export function rulesetToJson(r: Record<string, unknown>) {
  const config = parseJson(r.config);
  const cfg = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  const mode = safeLookup(cfg, "mode");
  const engine = safeLookup(cfg, "engineRulesetId");
  const forbidden = parseJson(r.forbidden_categories);
  return {
    id: r.id as string,
    name: r.name as string,
    mode: isPlatformMode(mode) ? mode : null,
    engineRulesetId: typeof engine === "string" && engine ? engine : null,
    budgetCredits: r.budget_credits as number,
    forbiddenCategories: Array.isArray(forbidden) ? (forbidden as string[]) : [],
  };
}

export type BattleContentCheck =
  | {
      ok: true;
      ruleset: ReturnType<typeof rulesetToJson>;
      map: { mapId: string; version: number; supportedModes: string[] };
      status?: undefined;
      code?: undefined;
      message?: undefined;
    }
  | { ok: false; status: 400 | 409; code: string; message: string; ruleset?: undefined; map?: undefined };

/**
 * FC-C (TD-003/TD-010) · Compatibilidad modo ↔ ruleset ↔ mapa ANTES de encolar una
 * batalla. Fail-closed y con códigos distinguibles:
 *   mode_invalid (400)          · el modo no es de plataforma.
 *   ruleset_unknown (400)       · el id no existe en la tabla `rulesets`.
 *   ruleset_mode_mismatch (409) · el ruleset declara otro modo (config.mode).
 *   map_not_published (400)     · no hay versión publicada (la pedida, o la última).
 *   map_mode_unsupported (409)  · el modo no está en supported_modes del mapa.
 * Si `mapVersion` se omite se usa la última PUBLICADA (comportamiento previo de POST /battles).
 */
export async function checkBattleContent(
  db: Db,
  input: { mode: unknown; rulesetId: unknown; mapId: unknown; mapVersion?: unknown },
): Promise<BattleContentCheck> {
  if (!isPlatformMode(input.mode)) return { ok: false, status: 400, code: "mode_invalid", message: "mode inválido" };
  const mode = input.mode;
  if (typeof input.rulesetId !== "string" || !input.rulesetId) {
    return { ok: false, status: 400, code: "ruleset_unknown", message: "rulesetId desconocido" };
  }
  const rsRow = await db("rulesets").where({ id: input.rulesetId }).first();
  if (!rsRow) return { ok: false, status: 400, code: "ruleset_unknown", message: "rulesetId desconocido" };
  const ruleset = rulesetToJson(rsRow);
  if (ruleset.mode !== null && ruleset.mode !== mode) {
    return {
      ok: false,
      status: 409,
      code: "ruleset_mode_mismatch",
      message: `El ruleset ${ruleset.id} es de modo ${ruleset.mode}, no ${mode}`,
    };
  }
  if (typeof input.mapId !== "string" || !input.mapId) {
    return { ok: false, status: 400, code: "map_not_published", message: "Mapa inexistente o no publicado" };
  }
  let q = db("map_versions").where({ map_id: input.mapId, state: "published" });
  if (input.mapVersion !== undefined && input.mapVersion !== null) {
    const v = Number(input.mapVersion);
    if (!Number.isInteger(v) || v < 1) {
      return { ok: false, status: 400, code: "map_not_published", message: "mapVersion inválida" };
    }
    q = q.where({ version: v });
  }
  const mapRow = await q.orderBy("version", "desc").first();
  if (!mapRow) return { ok: false, status: 400, code: "map_not_published", message: "Mapa inexistente o no publicado" };
  const modes = parseJson(mapRow.supported_modes);
  const supportedModes = Array.isArray(modes) ? (modes as string[]) : [];
  if (!supportedModes.includes(mode)) {
    return {
      ok: false,
      status: 409,
      code: "map_mode_unsupported",
      message: `El mapa ${mapRow.map_id} v${mapRow.version} no soporta el modo ${mode} (soporta: ${
        supportedModes.join(", ") || "ninguno"
      })`,
    };
  }
  return { ok: true, ruleset, map: { mapId: mapRow.map_id, version: mapRow.version, supportedModes } };
}

export function catalogRoutes(db: Db): Router {
  const router = Router();

  defineOperation(router, "listCatalogVersions", async (_req, res) => {
    res.json(await listCatalogVersions(db));
  });

  defineOperation(router, "listModules", async (req, res) => {
    const modules = await getCatalog(db, pathParam(req, "catalogVersion"));
    if (modules.length === 0) throw notFound();
    res.json(modules);
  });

  // FC-C (TD-003) · rulesets REALES de la BD + modos de plataforma, para la web.
  defineOperation(router, "listRulesets", async (req, res) => {
    const mode = req.query.mode;
    if (mode !== undefined && !isPlatformMode(mode)) throw badRequest("mode inválido");
    const rows = await db("rulesets").orderBy("id", "asc");
    const items = rows.map(rulesetToJson).filter((r) => mode === undefined || r.mode === null || r.mode === mode);
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json({ modes: [...PLATFORM_MODES], items });
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
