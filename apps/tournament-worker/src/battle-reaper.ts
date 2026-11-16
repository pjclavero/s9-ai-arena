/**
 * OLA2-MF · REAPER: reconciliador independiente de recursos de batalla.
 *
 * SEGUNDA barrera, no sustituye al teardown normal (battle-resources.ts). Busca
 * lo que haya quedado de batallas que ya NO se están ejecutando y lo elimina:
 *
 *  1. En proceso: battleIds con recursos aún registrados y SIN ejecución viva en
 *     este worker (un teardown que falló a medias) → se repite el teardown.
 *  2. Fuera del proceso: contenedores PROPIOS (los lista el proxy, acotado a sus
 *     labels de propiedad) con `arena.role=battle-bot`, agrupados por
 *     `arena.battle-id`. Se borran (forzado) si su batalla:
 *       - está `finished` o `failed` (terminal: en BD no hay TIMEOUT/CANCELLED,
 *         esos finales se registran como finished/failed o vuelven a scheduled);
 *       - no existe;
 *       - está `scheduled` (ningún intento vivo: un intento sólo lanza tras
 *         reservar) y el contenedor tiene más de `graceMs`;
 *       - está `running` con OTRO titular que el de la label `arena.battle-owner`
 *         (contenedor de un intento anterior) y más de `graceMs`.
 *     Nunca toca una batalla `running` cuyo titular coincide con la label, ni
 *     una con ejecución viva en este proceso, ni un contenedor sin label de
 *     batalla (builds, servicios base: ni siquiera los lista).
 */
import type { Knex } from "knex";
import {
  LABEL_BATTLE_ID,
  LABEL_BATTLE_OWNER,
  LABEL_ROLE,
  ROLE_BATTLE_BOT,
  type ManagedContainer,
} from "../../bot-manager/src/container-runner.js";
import { defaultBattleResources, withinDeadline, type BattleResourceRegistry } from "./battle-resources.js";

/**
 * Plazo de CADA llamada externa del reaper (listado y borrado en el proxy, consulta a la BD).
 * G2 · ronda 2 (P2-1): el reaper va en serie y `startReaper` no solapa pasadas; una llamada
 * colgada sin plazo lo dejaba parado para siempre.
 */
export const DEFAULT_REAPER_CALL_DEADLINE_MS = 15_000;

export interface ReaperRunner {
  list(labels: Record<string, string>): Promise<ManagedContainer[]>;
  removeById(id: string, battleId?: string): Promise<void>;
}

export interface ReaperDeps {
  db: Knex;
  runner?: ReaperRunner;
  resources?: BattleResourceRegistry;
  /** Antigüedad mínima de un contenedor de batalla no terminal para reclamarlo. Def. 120 s. */
  graceMs?: number;
  now?: () => number;
  /** Plazo de cada llamada externa (ms). Def. DEFAULT_REAPER_CALL_DEADLINE_MS. */
  callDeadlineMs?: number;
}

export interface ReapReport {
  inProcessRetried: string[];
  removed: { id: string; battleId: string; why: string }[];
  kept: number;
  errors: string[];
}

const TERMINAL = new Set(["finished", "failed"]);

export async function reapOnce(deps: ReaperDeps): Promise<ReapReport> {
  const res = deps.resources ?? defaultBattleResources;
  const now = (deps.now ?? Date.now)();
  const graceMs = deps.graceMs ?? 120_000;
  const report: ReapReport = { inProcessRetried: [], removed: [], kept: 0, errors: [] };
  const callMs = deps.callDeadlineMs ?? DEFAULT_REAPER_CALL_DEADLINE_MS;

  // 1 · en proceso: lo registrado aquí es SIEMPRE de este proceso; sin ejecución
  // viva, es resto de un teardown incompleto. Se comprueba justo antes (sin await
  // de por medio) que ningún intento nuevo haya arrancado. También se repasan las
  // batallas cuyo teardown no pudo VERIFICARSE fuera del proceso (verificador colgado
  // o caído): el teardown completo vuelve a preguntar, con su propio plazo.
  for (const id of res.retryIds()) {
    if (res.isActive(id)) continue;
    const wasUnverified = res.isUnverified(id);
    const r = await res.cleanupBattleResources(id, "FAILED");
    if (r.steps.length || wasUnverified) report.inProcessRetried.push(id);
    for (const s of r.steps) if (s.outcome === "failed") report.errors.push(`${id}/${s.kind}: ${s.error}`);
    if (res.isUnverified(id)) report.errors.push(`${id}/verificación: ${r.externalLeftovers.join("; ")}`);
  }

  // 2 · fuera del proceso
  if (!deps.runner) return report;
  const runner = deps.runner;
  let containers: ManagedContainer[];
  try {
    containers = await withinDeadline(
      Promise.resolve().then(() => runner.list({ [LABEL_ROLE]: ROLE_BATTLE_BOT })),
      callMs,
      "listado del reaper",
    );
  } catch (err) {
    report.errors.push(`listado: ${err instanceof Error ? err.message : String(err)}`);
    return report;
  }
  const ids = [...new Set(containers.map((c) => c.labels[LABEL_BATTLE_ID]).filter((x): x is string => !!x))];
  let rows: { id: string; status: string; claimed_by: string | null }[] = [];
  if (ids.length) {
    try {
      rows = (await withinDeadline(
        Promise.resolve().then(() => deps.db("battles").whereIn("id", ids).select("id", "status", "claimed_by")),
        callMs,
        "consulta de batallas del reaper",
      )) as { id: string; status: string; claimed_by: string | null }[];
    } catch (err) {
      // Sin la BD no se sabe qué es de quién: no se borra NADA en esta pasada (fail-closed).
      report.errors.push(`consulta: ${err instanceof Error ? err.message : String(err)}`);
      report.kept += containers.length;
      return report;
    }
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const c of containers) {
    const battleId = c.labels[LABEL_BATTLE_ID];
    if (!battleId) {
      report.kept++;
      continue;
    }
    if (res.isActive(battleId)) {
      report.kept++;
      continue;
    }
    const row = byId.get(battleId);
    const old = now - c.createdAtMs >= graceMs;
    let why: string | null = null;
    if (!row) why = "batalla inexistente";
    else if (TERMINAL.has(row.status)) why = `batalla ${row.status}`;
    else if (row.status === "scheduled" && old) why = "batalla sin intento vivo (scheduled)";
    else if (
      row.status === "running" &&
      old &&
      c.labels[LABEL_BATTLE_OWNER] !== undefined &&
      row.claimed_by !== null &&
      !sameOwner(row.claimed_by, c.labels[LABEL_BATTLE_OWNER])
    )
      why = "contenedor de un intento anterior";
    if (!why) {
      report.kept++;
      continue;
    }
    try {
      await withinDeadline(
        Promise.resolve().then(() => runner.removeById(c.id, battleId)),
        callMs,
        "borrado del reaper",
      );
      report.removed.push({ id: c.id, battleId, why });
    } catch (err) {
      report.errors.push(`${c.id.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}

/** La label se sanea (battleLabels); se compara con la misma regla. */
function sameOwner(claimedBy: string, label: string): boolean {
  return claimedBy.replace(/[^A-Za-z0-9_.:@-]/g, "-").slice(0, 200) === label;
}

/**
 * Bucle del reaper: una pasada cada `everyMs`, sin solaparse. Devuelve `stop()`.
 * El temporizador no retiene el proceso (unref).
 */
export function startReaper(deps: ReaperDeps & { everyMs?: number; onReport?: (r: ReapReport) => void }): () => void {
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    reapOnce(deps)
      .then((r) => deps.onReport?.(r))
      .catch((err) => deps.onReport?.({ inProcessRetried: [], removed: [], kept: 0, errors: [String(err)] }))
      .finally(() => {
        busy = false;
      });
  }, deps.everyMs ?? 60_000);
  t.unref?.();
  return () => clearInterval(t);
}
