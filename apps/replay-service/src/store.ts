/**
 * T8.1 · Almacén de replays (volumen arena_replays + índice).
 *
 * El servicio recibe el replay del motor (o del worker de E9) al terminar la batalla,
 * lo VALIDA (cabecera con versiones, checksum de mapa, hashes intermedios), lo comprime
 * y lo persiste como dos archivos:
 *   <battleId>.replay        — JSONL de E2 comprimido (zstd, o gzip de reserva; ver format.ts)
 *   <battleId>.replay.json   — StoredReplayIndex: checksum, keyframes, retención
 *
 * La BD de plataforma (cap. 23) guarda solo la REFERENCIA (battles.replay_ref +
 * replay_hash): la política 23.1 dice que los eventos de batalla viven en archivos.
 * La integración con la tabla `battles` la hace quien tenga la conexión (API/worker)
 * con el `StoredReplay` que devuelve `ingestReplay` — este módulo no abre conexiones.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromJsonl, toJsonl, verify, type Replay, type VerifyResult } from "../../arena-engine/src/replay.js";
import engineDeps from "../../arena-engine/src/engine-deps.json" with { type: "json" };
import { buildKeyframes, compress, decompress, sha256, type StoredReplayIndex } from "./format.js";

/** Retención por defecto de los replays TEMPORALES (prácticas/pruebas): 7 días (23.1). */
export const DEFAULT_TEMPORARY_TTL_MS = 7 * 24 * 3600_000;

export interface StoredReplay {
  index: StoredReplayIndex;
  /** Ruta del archivo comprimido: es lo que va a battles.replay_ref. */
  path: string;
  indexPath: string;
}

export interface IngestOptions {
  /** Los oficiales se conservan siempre; los temporales caducan (política 23.1). */
  official: boolean;
  temporaryTtlMs?: number;
  keyframeEveryNSnapshots?: number;
  /** T8.3 · El dueño permite abrir las capas de depuración (comandos) a todos en replay. */
  debugOpen?: boolean;
  /** Reloj inyectable: los tests de retención NO esperan días de verdad. */
  now?: () => number;
}

export function replayPath(dir: string, battleId: string): string {
  return join(dir, `${battleId}.replay`);
}
export function indexPath(dir: string, battleId: string): string {
  return join(dir, `${battleId}.replay.json`);
}

/**
 * Validación de ingesta: un replay sin cabecera completa, sin hashes intermedios o sin
 * checksum de mapa NO entra al almacén — sin estos campos verify() y la auditoría de
 * E9 (cap. 28) serían imposibles después, cuando ya no hay forma de regenerarlos.
 */
export function validateReplay(replay: Replay): string[] {
  const problems: string[] = [];
  const h = replay.header;
  if (!h) return ["sin cabecera"];
  if (h.formatVersion !== 1) problems.push(`formatVersion no soportada: ${String(h.formatVersion)}`);
  if (!h.battleId) problems.push("cabecera sin battleId");
  if (!h.seed) problems.push("cabecera sin seed");
  if (!h.ruleset || !h.rulesetId) problems.push("cabecera sin ruleset");
  if (!h.map) problems.push("cabecera sin mapa");
  else if (typeof h.map.checksum !== "string" || h.map.checksum.length === 0) {
    problems.push("mapa sin checksum");
  }
  if (!Array.isArray(h.participants) || h.participants.length === 0) problems.push("cabecera sin participantes");
  for (const k of ["engine", "physics", "rules", "protocol"]) {
    if (!h.versions?.[k]) problems.push(`cabecera sin versión de ${k}`);
  }
  if (!Array.isArray(replay.stateHashes) || replay.stateHashes.length === 0) {
    problems.push("sin hashes intermedios: verify() no podría localizar divergencias");
  }
  if (!replay.result?.finalStateHash) problems.push("sin resultado oficial (finalStateHash)");
  if (!Array.isArray(replay.snapshots) || replay.snapshots.length === 0) {
    problems.push("sin snapshots: el reproductor no tendría nada que enseñar");
  }
  return problems;
}

/** Valida, comprime y persiste un replay. Idempotente por battleId (re-ingesta = sobrescribe). */
export function ingestReplay(dir: string, replay: Replay, opts: IngestOptions): StoredReplay {
  const problems = validateReplay(replay);
  if (problems.length > 0) {
    throw new Error(`Replay inválido, no se almacena: ${problems.join("; ")}`);
  }
  mkdirSync(dir, { recursive: true });

  const jsonl = Buffer.from(toJsonl(replay), "utf8");
  const { algo, bytes } = compress(jsonl);
  const now = (opts.now ?? Date.now)();
  const ttl = opts.temporaryTtlMs ?? DEFAULT_TEMPORARY_TTL_MS;

  const index: StoredReplayIndex = {
    formatVersion: 1,
    battleId: replay.header.battleId,
    algo,
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
    official: opts.official,
    createdAt: new Date(now).toISOString(),
    // Política 23.1: los oficiales NUNCA caducan.
    expiresAt: opts.official ? null : new Date(now + ttl).toISOString(),
    ticks: replay.result.ticks,
    snapshotCount: replay.snapshots.length,
    versions: replay.header.versions,
    mapChecksum: replay.header.map.checksum,
    keyframes: buildKeyframes(replay.snapshots, opts.keyframeEveryNSnapshots),
    result: {
      winner: replay.result.winner,
      ticks: replay.result.ticks,
      score: replay.result.score,
      finalStateHash: replay.result.finalStateHash,
    },
    debugOpen: opts.debugOpen === true,
  };

  const path = replayPath(dir, index.battleId);
  const idxPath = indexPath(dir, index.battleId);
  writeFileSync(path, bytes);
  writeFileSync(idxPath, JSON.stringify(index, null, 2) + "\n");
  return { index, path, indexPath: idxPath };
}

/** Resumen de un replay para el listado global (R7-A). */
export interface ReplaySummary {
  battleId: string;
  ticks: number;
  winner: string;
  official: boolean;
  createdAt: string;
  sizeBytes: number;
}

/**
 * R7-A · Lista TODOS los replays gestionados (lee los índices `<battleId>.replay.json`).
 * Orden por defecto: más recientes primero. `limit` acota el resultado.
 */
export function listReplays(dir: string, opts: { limit?: number; order?: "asc" | "desc" } = {}): ReplaySummary[] {
  if (!existsSync(dir)) return [];
  const items: ReplaySummary[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".replay.json"))) {
    try {
      const ix = JSON.parse(readFileSync(join(dir, f), "utf8")) as StoredReplayIndex;
      items.push({
        battleId: ix.battleId,
        ticks: ix.ticks,
        winner: ix.result?.winner ?? "unknown",
        official: ix.official,
        createdAt: ix.createdAt,
        sizeBytes: ix.sizeBytes,
      });
    } catch {
      /* índice corrupto: se ignora en el listado (no rompe la lista entera). */
    }
  }
  items.sort((a, b) =>
    opts.order === "asc" ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt),
  );
  return opts.limit && opts.limit > 0 ? items.slice(0, opts.limit) : items;
}

export function readIndex(dir: string, battleId: string): StoredReplayIndex | null {
  const p = indexPath(dir, battleId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as StoredReplayIndex;
}

export interface LoadedReplay {
  valid: boolean;
  reason?: string;
  index: StoredReplayIndex | null;
  replay: Replay | null;
}

/**
 * Carga un replay almacenado verificando su integridad. Un solo byte alterado en el
 * archivo comprimido rompe el sha256 del índice ⇒ `valid: false` (DoD T8.1).
 */
export function loadStored(dir: string, battleId: string): LoadedReplay {
  const index = readIndex(dir, battleId);
  const p = replayPath(dir, battleId);
  if (!existsSync(p)) return { valid: false, reason: "replay_not_found", index, replay: null };

  const bytes = readFileSync(p);
  if (index && sha256(bytes) !== index.sha256) {
    return { valid: false, reason: "checksum_mismatch", index, replay: null };
  }
  let replay: Replay;
  try {
    replay = fromJsonl(decompress(bytes).toString("utf8"));
  } catch (e) {
    return { valid: false, reason: `corrupt_file: ${(e as Error).message}`, index, replay: null };
  }
  const problems = validateReplay(replay);
  if (problems.length > 0) return { valid: false, reason: problems.join("; "), index, replay };
  if (index && replay.header.battleId !== index.battleId) {
    return { valid: false, reason: "battleId no coincide con el índice", index, replay };
  }
  return { valid: true, index, replay };
}

// ---------------------------------------------------------------- verify

export interface StoredVerifyResult {
  battleId: string;
  /** false si el archivo está manipulado/corrupto o el motor no puede re-simular. */
  valid: boolean;
  reason?: string;
  /** Resultado de la re-simulación (solo si valid). */
  verification: VerifyResult | null;
}

/**
 * `replay-service verify <id>` (criterio cap. 28): re-simula el replay con la versión
 * de motor REGISTRADA en la cabecera y comprueba que resultado y hashes intermedios
 * coinciden con el oficial. Este despliegue es de versión única de motor: si la
 * cabecera registra OTRA versión, verificar con esta sería mentir — se rechaza con
 * `engine_version_mismatch` (multi-versión: pendiente de reconciliación con E10).
 */
export async function verifyStored(dir: string, battleId: string): Promise<StoredVerifyResult> {
  const loaded = loadStored(dir, battleId);
  if (!loaded.valid || !loaded.replay) {
    return { battleId, valid: false, reason: loaded.reason, verification: null };
  }
  return verifyLoaded(battleId, loaded.replay);
}

/** Verifica un Replay ya decodificado (lo usa también el endpoint verifyReplay de la API). */
export async function verifyLoaded(battleId: string, replay: Replay): Promise<StoredVerifyResult> {
  const recorded = replay.header.versions.engine;
  if (recorded !== engineDeps.engine.version) {
    return {
      battleId,
      valid: false,
      reason: `engine_version_mismatch: replay=${recorded}, disponible=${engineDeps.engine.version}`,
      verification: null,
    };
  }
  const verification = await verify(replay);
  return { battleId, valid: true, verification };
}

// ---------------------------------------------------------------- retención

export interface RetentionReport {
  deleted: string[];
  kept: string[];
}

/**
 * Barrido de retención (política 23.1): borra los replays TEMPORALES caducados.
 * Los oficiales tienen `expiresAt: null` y además `official: true` — doble cinturón:
 * aunque un índice corrupto trajera una fecha, un oficial JAMÁS se borra.
 */
export function sweepRetention(dir: string, now: () => number = Date.now): RetentionReport {
  const report: RetentionReport = { deleted: [], kept: [] };
  if (!existsSync(dir)) return report;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".replay.json"))) {
    const index = JSON.parse(readFileSync(join(dir, f), "utf8")) as StoredReplayIndex;
    const expired = !index.official && index.expiresAt !== null && now() > Date.parse(index.expiresAt);
    if (expired) {
      rmSync(replayPath(dir, index.battleId), { force: true });
      rmSync(indexPath(dir, index.battleId), { force: true });
      report.deleted.push(index.battleId);
    } else {
      report.kept.push(index.battleId);
    }
  }
  return report;
}
