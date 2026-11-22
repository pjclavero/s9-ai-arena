/**
 * ADM-1 · Lectura y escritura de `system_settings` desde la API.
 *
 *  - LISTA: cada clave del REGISTRO con su valor vigente, origen (BD/entorno/defecto),
 *    versión, techo del entorno y si el cambio EXIGE REINICIO del consumidor.
 *  - PATCH atómico (todo o nada): claves/valores validados contra el registro y el techo
 *    del entorno, concurrencia optimista por `version` y UNA fila de `audit_log` por clave
 *    cambiada (antes y después) en la MISMA transacción que la escritura.
 *
 * La lectura de los servicios NO pasa por aquí: usan `SystemSettingsReader`
 * (packages/system-settings/reader.ts).
 */
import type { Db } from "../db/connection.js";
import { audit } from "../audit.js";
import { badRequest, conflict } from "../errors.js";
import {
  effectiveValue,
  envCeiling,
  validateSettingValue,
  type SettingValue,
  type SettingsRegistry,
} from "../../../../packages/system-settings/registry.js";
import { SYSTEM_SETTINGS_TABLE } from "../../../../packages/system-settings/reader.js";

export const SETTINGS_AUDIT_ACTION = "settings.system.update";
export const MAX_PATCH_ITEMS = 50;

export interface SettingView {
  key: string;
  type: string;
  min: number | null;
  max: number | null;
  options: readonly string[] | null;
  default: SettingValue;
  consumer: string;
  apply: "hot" | "restart";
  /** true ⇒ el cambio sólo lo ve el consumidor tras reiniciarlo. */
  requiresRestart: boolean;
  description: string;
  /** Techo duro del entorno vigente (null si no hay). */
  envCeiling: number | null;
  value: SettingValue;
  source: "database" | "environment" | "default";
  /** 0 = sin fila en BD. Es el `expectedVersion` del próximo PATCH. */
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface Row {
  key: string;
  value: unknown;
  version: number;
  updated_at: Date | string;
  updated_by: string | null;
}

function view(registry: SettingsRegistry, key: string, row: Row | undefined, env: NodeJS.ProcessEnv): SettingView {
  const d = registry.get(key)!;
  const e = effectiveValue(d, row?.value, env);
  return {
    key: d.key,
    type: d.type,
    min: d.min ?? null,
    max: d.max ?? null,
    options: d.options ?? null,
    default: d.default,
    consumer: d.consumer,
    apply: d.apply,
    requiresRestart: d.apply === "restart",
    description: d.description,
    envCeiling: envCeiling(d, env),
    value: e.value,
    source: e.source,
    version: row?.version ?? 0,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row?.updated_by ?? null,
  };
}

export async function listSettings(
  db: Db,
  registry: SettingsRegistry,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SettingView[]> {
  const rows: Row[] = await db(SYSTEM_SETTINGS_TABLE).select("*");
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return registry.defs.map((d) => view(registry, d.key, byKey.get(d.key), env));
}

export interface PatchItem {
  key: string;
  value: unknown;
  expectedVersion: number;
}

/** Valida la FORMA del cuerpo del PATCH (no los valores: eso lo hace el registro). */
export function parsePatchBody(body: unknown): PatchItem[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("el cuerpo debe ser un objeto JSON");
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== "changes") throw badRequest(`campo no admitido: ${k}`);
  const items = o.changes;
  if (!Array.isArray(items) || items.length === 0) throw badRequest("changes debe ser una lista no vacía");
  if (items.length > MAX_PATCH_ITEMS) throw badRequest(`demasiados cambios (máximo ${MAX_PATCH_ITEMS})`);
  const seen = new Set<string>();
  return items.map((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest(`changes[${i}] debe ser un objeto`);
    const it = raw as Record<string, unknown>;
    for (const k of Object.keys(it)) {
      if (k !== "key" && k !== "value" && k !== "expectedVersion")
        throw badRequest(`changes[${i}]: campo no admitido: ${k}`);
    }
    if (typeof it.key !== "string") throw badRequest(`changes[${i}].key debe ser texto`);
    if (!("value" in it)) throw badRequest(`changes[${i}].value es obligatorio`);
    if (typeof it.expectedVersion !== "number" || !Number.isInteger(it.expectedVersion) || it.expectedVersion < 0) {
      throw badRequest(`changes[${i}].expectedVersion debe ser un entero ≥ 0 (0 = sin valor guardado)`);
    }
    if (seen.has(it.key)) throw badRequest(`clave repetida: ${it.key}`);
    seen.add(it.key);
    return { key: it.key, value: it.value, expectedVersion: it.expectedVersion };
  });
}

export interface PatchResult {
  settings: SettingView[];
  changed: { key: string; before: unknown; after: SettingValue; version: number; requiresRestart: boolean }[];
  /** Claves cambiadas cuyo consumidor debe reiniciarse para verlas. */
  pendingRestart: string[];
}

export async function patchSettings(
  db: Db,
  registry: SettingsRegistry,
  items: PatchItem[],
  ctx: { actorId: string | null; correlationId?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<PatchResult> {
  // 1) Validación COMPLETA antes de tocar nada (clave registrada, tipo, rango, techo del entorno).
  const errors: string[] = [];
  const valid: { item: PatchItem; value: SettingValue }[] = [];
  for (const it of items) {
    const d = registry.get(it.key);
    if (!d) {
      errors.push(`clave no registrada: ${it.key}`);
      continue;
    }
    const r = validateSettingValue(d, it.value, env);
    if (!r.ok) errors.push(r.error);
    else valid.push({ item: it, value: r.value });
  }
  if (errors.length) throw badRequest(errors.join("; "));

  // 2) Escritura + auditoría en UNA transacción: o todo o nada.
  const changed: PatchResult["changed"] = [];
  await db.transaction(async (trx) => {
    const t = trx as unknown as Db;
    for (const { item, value } of valid) {
      const d = registry.get(item.key)!;
      const row: Row | undefined = await t(SYSTEM_SETTINGS_TABLE).where({ key: item.key }).forUpdate().first();
      const currentVersion = row?.version ?? 0;
      if (currentVersion !== item.expectedVersion) {
        throw conflict("version_conflict", `${item.key} cambió mientras lo editabas (versión ${currentVersion})`, {
          key: item.key,
          currentVersion,
        });
      }
      if (row && JSON.stringify(row.value) === JSON.stringify(value)) continue; // sin cambio real: ni versión ni auditoría
      let version: number;
      if (row) {
        version = row.version + 1;
        await t(SYSTEM_SETTINGS_TABLE)
          .where({ key: item.key })
          .update({ value: JSON.stringify(value), version, updated_at: t.fn.now(), updated_by: ctx.actorId });
      } else {
        version = 1;
        // Sin fila no hay nada que bloquear: una inserción concurrente de la misma clave choca con la PK (409).
        try {
          await t(SYSTEM_SETTINGS_TABLE).insert({
            key: item.key,
            value: JSON.stringify(value),
            version,
            updated_by: ctx.actorId,
          });
        } catch (e) {
          if ((e as { code?: string }).code === "23505") {
            throw conflict("version_conflict", `${item.key} lo creó otro administrador a la vez`, { key: item.key });
          }
          throw e;
        }
      }
      await audit(t, {
        actorId: ctx.actorId,
        action: SETTINGS_AUDIT_ACTION,
        target: `setting:${item.key}`,
        detail: {
          key: item.key,
          before: row ? row.value : null,
          after: value,
          beforeVersion: currentVersion,
          afterVersion: version,
          requiresRestart: d.apply === "restart",
          consumer: d.consumer,
        },
        correlationId: ctx.correlationId,
      });
      changed.push({
        key: item.key,
        before: row ? row.value : null,
        after: value,
        version,
        requiresRestart: d.apply === "restart",
      });
    }
  });

  return {
    settings: await listSettings(db, registry, env),
    changed,
    pendingRestart: changed.filter((c) => c.requiresRestart).map((c) => c.key),
  };
}
