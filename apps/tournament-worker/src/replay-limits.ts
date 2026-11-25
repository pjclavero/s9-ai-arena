/**
 * V1 REPLAYS · PR-5 · Cableado de los límites de almacenamiento del grabador en el worker:
 *
 *  - `replayLimitsFromReader`: lee EN CALIENTE las tres claves `replays.*` de `system_settings`
 *    (`SystemSettingsReader`, sondeo ≈ 5 s). FAIL-CLOSED: sin lectura válida reciente, o con la BD
 *    caída pasada la ventana, valen los DEFECTOS del código (prudentes), recortados al techo del
 *    entorno, nunca el último valor viejo indefinidamente (lo garantiza el lector).
 *  - `makeStorageProbe`: mide el volumen. Libre = `statfs` del directorio de replays; usado =
 *    publicados + papelera (suma de `replay_artifacts`, en caché ≤ 30 s) + parciales vivos ajenos
 *    (lectura del directorio `.partial/`, sin caché: son pocos ficheros y un fragmento ≈ 1-2 MiB).
 *  - `buildReplayLimits`: lo que `main.ts` pasa al ejecutor.
 *
 * El worker es el único que escribe replays; la API valida y persiste los ajustes y no toca ficheros.
 */
import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Knex } from "knex";
import {
  REPLAYS_LIMIT_MAX_BYTES_PER_BATTLE,
  REPLAYS_QUOTA_MAX_BYTES,
  REPLAYS_QUOTA_MIN_FREE_BYTES,
} from "../../../packages/system-settings/replay-settings.js";
import { SYSTEM_SETTINGS_REGISTRY } from "../../../packages/system-settings/registry.js";
import { SystemSettingsReader } from "../../../packages/system-settings/reader.js";
import type { ReplayLimits, StorageProbe } from "../../replay-service/src/s9r/recording-budget.js";
import { PARTIAL_DIR } from "../../replay-service/src/s9r/recorder.js";
import { workerMetrics, type WorkerMetrics } from "./worker-metrics.js";

/** Lo que el ejecutor necesita para limitar el almacenamiento de una grabación. */
export interface ReplayLimitsConfig {
  /** Síncrona y en caliente: se llama en cada fragmento. */
  limits: () => ReplayLimits;
  /** Sonda del volumen. Sin ella (sólo tests) no hay compuerta previa ni reserva/cuota: sólo el tope por batalla. */
  probe?: StorageProbe;
}

/** Defectos del código: los del registro (prudentes). */
export function defaultReplayLimits(): ReplayLimits {
  const d = (k: string) => Number(SYSTEM_SETTINGS_REGISTRY.get(k)!.default);
  return {
    quotaMaxBytes: d(REPLAYS_QUOTA_MAX_BYTES),
    minFreeBytes: d(REPLAYS_QUOTA_MIN_FREE_BYTES),
    maxBytesPerBattle: d(REPLAYS_LIMIT_MAX_BYTES_PER_BATTLE),
  };
}

/** Límites vigentes desde el lector de `system_settings` (síncrono; lo refresca su sondeo). */
export function replayLimitsFromReader(reader: Pick<SystemSettingsReader, "get">): () => ReplayLimits {
  return () => ({
    quotaMaxBytes: Number(reader.get(REPLAYS_QUOTA_MAX_BYTES)),
    minFreeBytes: Number(reader.get(REPLAYS_QUOTA_MIN_FREE_BYTES)),
    maxBytesPerBattle: Number(reader.get(REPLAYS_LIMIT_MAX_BYTES_PER_BATTLE)),
  });
}

export interface StorageProbeOptions {
  db: Knex;
  /** `REPLAYS_DIR`. */
  dir: string;
  /** Vigencia de la suma de artefactos de la BD. Defecto 30 s (diseño 3.1). */
  cacheMs?: number;
  now?: () => number;
  /** Sólo tests: medida del espacio libre. */
  freeBytesFn?: (dir: string) => Promise<number>;
  metrics?: WorkerMetrics;
}

async function statfsFree(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export function makeStorageProbe(o: StorageProbeOptions): StorageProbe {
  const now = o.now ?? Date.now;
  const cacheMs = o.cacheMs ?? 30_000;
  const metrics = o.metrics ?? workerMetrics;
  let cached: { at: number; bytes: number } | null = null;

  async function publishedBytes(): Promise<number> {
    if (cached && now() - cached.at < cacheMs) return cached.bytes;
    // Publicados y en papelera siguen ocupando disco; los purgados no.
    const row = await o
      .db("replay_artifacts")
      .whereIn("state", ["published", "trashed"])
      .sum({ bytes: o.db.raw("recipe_bytes + COALESCE(view_bytes, 0)") })
      .first();
    const bytes = Number((row as { bytes?: unknown } | undefined)?.bytes ?? 0);
    cached = { at: now(), bytes: Number.isFinite(bytes) ? bytes : 0 };
    return cached.bytes;
  }

  async function foreignPartialBytes(exclude: readonly string[]): Promise<number> {
    const dir = join(o.dir, PARTIAL_DIR);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw e;
    }
    const skip = new Set(exclude);
    let total = 0;
    for (const n of names) {
      const p = join(dir, n);
      if (skip.has(p)) continue;
      try {
        total += (await stat(p)).size;
      } catch {
        /* desapareció entre el listado y el stat (lo publicó o descartó su titular) */
      }
    }
    return total;
  }

  return {
    async freeBytes() {
      const free = await (o.freeBytesFn ?? statfsFree)(o.dir);
      metrics.set("replay_volume_free_bytes", free);
      return free;
    },
    async usedBytes(excludePartials) {
      const used = (await publishedBytes()) + (await foreignPartialBytes(excludePartials));
      metrics.set("replay_volume_used_bytes", used);
      return used;
    },
  };
}

/**
 * Lo que `main.ts` cablea: lector de `system_settings` (arranca su sondeo), límites en caliente y sonda real.
 * Un fallo de la primera lectura NO es fatal: el lector queda cerrado y valen los defectos.
 */
export async function buildReplayLimits(
  db: Knex,
  dir: string,
  opts: { readerOptions?: ConstructorParameters<typeof SystemSettingsReader>[2]; metrics?: WorkerMetrics } = {},
): Promise<{ config: ReplayLimitsConfig; reader: SystemSettingsReader }> {
  const reader = new SystemSettingsReader(db as never, SYSTEM_SETTINGS_REGISTRY, opts.readerOptions);
  await reader.refresh();
  reader.start();
  return {
    config: {
      limits: replayLimitsFromReader(reader),
      probe: makeStorageProbe({ db, dir, ...(opts.metrics ? { metrics: opts.metrics } : {}) }),
    },
    reader,
  };
}
