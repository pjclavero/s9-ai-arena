/**
 * V1 REPLAYS PR-4 · Lectores INCREMENTALES de la API sobre S9R/1 (receta `.s9r` + vista `.s9v`).
 *
 * Ninguno carga el replay entero:
 *  - índice del visor: cabecera y resumen de la vista (pie + índice + 2 frames pequeños);
 *  - segmento: sólo los fragmentos de la vista que cubren el rango; la proyección pública
 *    recorre la vista EN STREAMING hasta el rango (los ids públicos son los del documento
 *    entero) sin retener nada fuera de él;
 *  - verify: re-simulación con `RecipeCursor` (comandos por fragmentos) + integridad completa
 *    contra el sha de la BD en una pasada en streaming;
 *  - descarga del crudo: `createReadStream` de la receta;
 *  - descarga pública: el documento proyectado se ESCRIBE en streaming.
 *
 * Corte D-OP-30: una referencia que no es `.s9r` es «sin replay» (404 uniforme). La vista vive
 * junto a la receta (`<id>.<attempt>.s9v`).
 */
import type { Response } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import deps from "../../arena-engine/src/engine-deps.json" with { type: "json" };
import { verifyRecipePath } from "../../replay-service/src/recipe-verify.js";
import { ViewReader } from "../../replay-service/src/s9r/view.js";
import { verifyFile } from "../../replay-service/src/s9r/verify.js";
import { S9rReader } from "../../replay-service/src/s9r/reader.js";
import { PROJECTION_VERSION } from "../../../packages/projection/index.js";
import { isS9rReplayRef } from "../../replay-service/src/artifacts.js";
import type { Db } from "./db/connection.js";
import { projectViewStream, scrub, type ViewerMeta } from "./replay-projection.js";

export { isS9rReplayRef };

/**
 * Predicado SQL ÚNICO de «la batalla tiene replay» (diseño §8): `replay_ref` es una receta S9R/1.
 * Una referencia de formato anterior es «sin replay» en listados, detalle y estadísticas.
 */
export function whereS9rReplay<Q extends { where: (...a: any[]) => Q }>(q: Q, column = "battles.replay_ref"): Q {
  return q.where(column, "like", "%.s9r");
}

/** Ruta de la vista de una receta publicada. */
export function viewPathOf(recipeRef: string): string {
  return recipeRef.replace(/\.s9r$/, ".s9v");
}

/** Meta del visor (mundo, nómina con nombres, ids públicos del mapa) desde la cabecera de la VISTA. */
export async function viewerMetaFromView(db: Db, header: any): Promise<ViewerMeta> {
  const box = (b: any) => ({
    position: { x: Number(b?.position?.x) || 0, y: Number(b?.position?.y) || 0 },
    halfW: Number(b?.halfW) || 0,
    halfH: Number(b?.halfH) || 0,
  });
  const map = header?.map ?? {};
  const roster: any[] = Array.isArray(header?.roster) ? header.roster : [];
  const botIds = roster.map((r) => String(r.botId ?? "")).filter(Boolean);
  const names = new Map<string, string>();
  if (botIds.length > 0) {
    const rows = await db("bots")
      .whereIn("id", botIds)
      .select("id", "name")
      .catch(() => []);
    for (const r of rows as { id: string; name: string }[]) names.set(String(r.id), r.name);
  }
  const idsOf = (xs: unknown) =>
    (Array.isArray(xs) ? xs : []).map((x: any) => x?.id).filter((x: unknown): x is string => typeof x === "string");
  return {
    mapEntityIds: [...idsOf(map.walls), ...idsOf(map.destructibles), ...idsOf(map.zones)],
    world: {
      widthM: Number(map.widthM) || 0,
      heightM: Number(map.heightM) || 0,
      walls: (Array.isArray(map.walls) ? map.walls : []).map(box),
      destructibles: (Array.isArray(map.destructibles) ? map.destructibles : []).map(box),
      bases: (Array.isArray(map.bases) ? map.bases : []).map((b: any) => ({
        team: String(b.team),
        position: { x: Number(b?.position?.x) || 0, y: Number(b?.position?.y) || 0 },
        ...(typeof b.radiusM === "number" ? { radiusM: b.radiusM } : {}),
      })),
    },
    roster: roster.map((r) => ({
      id: String(r.id),
      botId: String(r.botId ?? ""),
      team: String(r.team ?? ""),
      ...(typeof r.chassis === "string" ? { chassis: r.chassis } : {}),
      ...(names.has(String(r.botId)) ? { name: names.get(String(r.botId)) } : {}),
    })),
  };
}

/** sha256 del fichero entero en streaming (memoria constante). */
/**
 * Vistas ya contrastadas con su `view_sha256`, por ruta + tamaño + mtime (una vista publicada no
 * cambia: si cambia el fichero, cambia la clave y se vuelve a contrastar). Acotada.
 */
const verifiedViews = new Map<string, string>();
const VERIFIED_VIEWS_MAX = 256;

/**
 * Abre la vista de una batalla con replay S9R/1, o null (404 uniforme) si falta, está dañada o
 * su sha256 no es el de `replay_artifacts.view_sha256` (P2-2: una vista reescrita de forma
 * coherente no se sirve). Sin fila de inventario no hay vista que servir.
 */
export async function openView(db: Db, battle: Record<string, any>): Promise<ViewReader | null> {
  if (!isS9rReplayRef(battle.replay_ref)) return null;
  const path = viewPathOf(String(battle.replay_ref));
  try {
    const art = await db("replay_artifacts")
      .where({ battle_id: battle.id, state: "published" })
      .first("view_path", "view_sha256");
    if (!art?.view_sha256 || art.view_path !== path) return null;
    const st = await stat(path);
    const key = `${path}:${st.size}:${st.mtimeMs}`;
    if (verifiedViews.get(key) !== art.view_sha256) {
      if ((await sha256OfFile(path)) !== art.view_sha256) return null;
      verifiedViews.set(key, art.view_sha256);
      while (verifiedViews.size > VERIFIED_VIEWS_MAX) verifiedViews.delete(verifiedViews.keys().next().value as string);
    }
    return await ViewReader.open(path);
  } catch {
    return null;
  }
}

/** Índice de ALMACÉN (sólo para quien recibe el crudo) en la forma que usa el visor. */
export function storeIndexOf(battle: Record<string, any>, view: ViewReader): Record<string, any> {
  const r = (battle.result ?? {}) as Record<string, any>;
  return {
    formatVersion: 3,
    battleId: String(battle.id),
    sha256: String(battle.replay_hash ?? ""),
    official: battle.official === true,
    createdAt: new Date(battle.finished_at ?? battle.created_at ?? 0).toISOString(),
    expiresAt: null,
    ticks: Number(r.ticks ?? view.summary.lastTick) || 0,
    snapshotCount: view.summary.snapshotCount,
    versions: battle.engine_versions ?? {},
    keyframes: view.summary.keyframes,
    result: {
      winner: r.winner ?? null,
      ...(r.endReason ? { endReason: r.endReason } : {}),
      ticks: Number(r.ticks) || 0,
      score: r.score ?? {},
      finalStateHash: battle.final_state_hash ?? null,
    },
  };
}

/**
 * Anchura MÁXIMA de un segmento (ticks). El visor pide trozos de 600 (`CHUNK_TICKS`); el tope es
 * el doble. Sin `toTick`, el segmento por defecto es de `DEFAULT_SEGMENT_TICKS` desde `fromTick`:
 * nunca la vista entera (un replay de 45 000 ticks no se materializa en una petición).
 */
export const MAX_SEGMENT_TICKS = 1200;
export const DEFAULT_SEGMENT_TICKS = 600;

/**
 * Rango de ticks validado: numéricos, `from <= to` y anchura `<= MAX_SEGMENT_TICKS`.
 * `null` = 400 `bad_range`; `"too_large"` = 400 `segment_range_too_large` (documentado en OpenAPI).
 */
export function parseRange(
  fromRaw: unknown,
  toRaw: unknown,
  _ticks: number,
): { from: number; to: number } | null | "too_large" {
  const from = Number(fromRaw ?? 0);
  const to = toRaw === undefined || toRaw === null || toRaw === "" ? from + DEFAULT_SEGMENT_TICKS - 1 : Number(toRaw);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
  if (to - from + 1 > MAX_SEGMENT_TICKS) return "too_large";
  return { from, to };
}

/**
 * Segmento CRUDO (ids internos): arranca en el keyframe anterior a `from` (estado completo) y
 * lee sólo los fragmentos de la vista que cubren [keyframe, to].
 */
export async function rawSegment(
  battle: Record<string, any>,
  view: ViewReader,
  range: { from: number; to: number },
): Promise<Record<string, unknown>> {
  // Cinturón: aunque el llamador no valide, el rango nunca pasa de MAX_SEGMENT_TICKS.
  const to = Math.min(range.to, range.from + MAX_SEGMENT_TICKS - 1);
  range = { from: range.from, to };
  const kf = view.nearestKeyframe(range.from);
  const fromKf = kf?.tick ?? 0;
  const snapshots: any[] = [];
  const events: any[] = [];
  for await (const r of view.records(fromKf, range.to)) {
    if (r.k === "s") snapshots.push(r.frame);
    else events.push(r.event);
  }
  return { battleId: String(battle.id), fromKeyframeTick: fromKf, snapshots, events };
}

/**
 * Segmento PROYECTADO: mismas filas que el crudo (ticks de sus snapshots y rango de sus eventos),
 * con los ids públicos del documento entero. Recorre la vista desde el principio en streaming
 * hasta pasar el rango, reteniendo sólo lo que cae dentro.
 */
export async function projectedSegment(
  battle: Record<string, any>,
  view: ViewReader,
  meta: ViewerMeta | null,
  raw: Record<string, any>,
): Promise<Record<string, unknown>> {
  const ticks = new Set<number>((raw.snapshots as any[]).map((s) => Number(s?.tick) || 0));
  const evTicks = (raw.events as any[]).map((e) => Number(e?.tick) || 0);
  const evFrom = evTicks.length ? Math.min(...evTicks) : Infinity;
  const evTo = evTicks.length ? Math.max(...evTicks) : -Infinity;
  const toTick = Math.max(...[...ticks, evTo, Number(raw.fromKeyframeTick) || 0].filter(Number.isFinite));
  const snapshots: any[] = [];
  const events: Record<string, unknown>[] = [];
  const done = await projectViewStream(
    String(battle.id),
    meta,
    view.records(),
    {
      onSnapshot: (b) => ticks.has(Number(b.tick)) && snapshots.push(b),
      onEvent: (e) => {
        const t = Number(e.tick) || 0;
        if (t >= evFrom && t <= evTo) events.push(e);
      },
    },
    { stopAfterTick: toTick },
  );
  return {
    projection: "s9.replay.public-competition.v2",
    mappingId: done.mappingId,
    battleId: String(battle.id),
    fromKeyframeTick: Number(raw.fromKeyframeTick) || 0,
    snapshots,
    events,
  };
}

async function sha256OfFile(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Descarga del CRUDO (receta) en streaming. */
export async function streamRecipe(res: Response, battle: Record<string, any>): Promise<void> {
  res.status(200).setHeader("Content-Type", "application/octet-stream");
  if (battle.replay_hash) res.setHeader("X-Replay-Sha256", String(battle.replay_hash));
  await pipeline(createReadStream(String(battle.replay_ref)), res);
}

/**
 * Verificación completa de la receta: integridad del fichero entero contra el sha de la BD
 * (streaming) y re-simulación por fragmentos. Forma de respuesta de `verifyReplay`.
 */
export async function verifyRecipe(battle: Record<string, any>): Promise<Record<string, unknown>> {
  const path = String(battle.replay_ref);
  // Manipulación byte a byte: el hash registrado en la BD manda (DoD T8.1), antes que la
  // estructura. sha256 del fichero entero en streaming (memoria constante).
  if (battle.replay_hash) {
    let sha: string;
    try {
      sha = await sha256OfFile(path);
    } catch {
      return { matches: false, valid: false, reason: "corrupt_file: unreadable" };
    }
    if (sha !== String(battle.replay_hash)) return { matches: false, valid: false, reason: "checksum_mismatch" };
  }
  const integrity = await verifyFile(path, {
    ...(battle.replay_hash ? { expectSha256: String(battle.replay_hash) } : {}),
  });
  if (!integrity.ok) {
    const code = integrity.reason ?? integrity.error?.code ?? "corrupt";
    return {
      matches: false,
      valid: false,
      reason: code === "file_sha_mismatch" ? "checksum_mismatch" : `corrupt_file: ${code}`,
    };
  }
  let out: Awaited<ReturnType<typeof verifyRecipePath>>;
  try {
    out = await verifyRecipePath(path);
  } catch (e) {
    return { matches: false, valid: false, reason: `corrupt_file: ${(e as { code?: string }).code ?? "bad_recipe"}` };
  }
  const v = out.verification;
  const recorded = out.header?.versions?.engine;
  if (v.rejected) {
    const engineMismatch = v.rejected.startsWith("engine_version_mismatch");
    return {
      matches: false,
      valid: false,
      reason: v.rejected,
      ...(engineMismatch
        ? {
            message:
              `Este replay se grabó con otra versión del motor (${recorded}; la actual es ${deps.engine.version}). ` +
              "No se puede re-simular con este motor, así que no se verifica; eso NO significa que esté manipulado.",
          }
        : {}),
      recordedWith: recorded,
    };
  }
  // Cinturón extra: el resultado oficial del ARCHIVO debe ser el que registró la BD.
  const dbHashOk = !battle.final_state_hash || battle.final_state_hash === out.result?.finalStateHash;
  return {
    matches: v.matches && dbHashOk,
    officialHash: v.officialHash,
    recomputedHash: v.recomputedHash,
    valid: dbHashOk,
    reason: !dbHashOk ? "final_state_hash_mismatch_with_db" : undefined,
    divergedAtTick: v.divergedAtTick ?? undefined,
    recordedWith: recorded,
    verifiedWith: deps.engine.version,
  };
}

/** El cliente cerró la conexión (o se destruyó la respuesta) a mitad de la escritura. */
export class ClientGoneError extends Error {
  constructor() {
    super("el cliente cerró la conexión");
    this.name = "ClientGoneError";
  }
}
/** El cliente no leyó nada durante `stallMs`: se aborta (nunca se acumula el documento en RAM). */
export class ClientStalledError extends Error {
  constructor(ms: number) {
    super(`el cliente no leyó en ${ms} ms`);
    this.name = "ClientStalledError";
  }
}

/** Plazo por defecto sin que el cliente lea antes de abortar una descarga. */
export const STREAM_STALL_MS = 30_000;

/**
 * Escritura con CONTRAPRESIÓN: si `write` devuelve false se espera a `'drain'`; si el cliente
 * cierra, `ClientGoneError`; si no lee en `stallMs`, `ClientStalledError`. Lo encolado en el
 * proceso queda acotado por el `highWaterMark` de la respuesta más un trozo.
 */
export async function writeWithBackpressure(res: Response, chunk: string, stallMs = STREAM_STALL_MS): Promise<void> {
  if (res.destroyed || res.writableEnded) throw new ClientGoneError();
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(timer);
      res.off("drain", onDrain);
      res.off("close", onClose);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new ClientGoneError());
    const timer = setTimeout(() => done(new ClientStalledError(stallMs)), stallMs);
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

/** Documento PÚBLICO proyectado de toda la batalla, ESCRITO en streaming (dos pasadas por la vista). */
export async function streamPublicDocument(
  res: Response,
  battle: Record<string, any>,
  view: ViewReader,
  meta: ViewerMeta | null,
  opts: {
    stallMs?: number;
    /** Sólo tests: observa cada frame proyectado (para comprobar que NO se retiene tras escribirlo). */
    observeProjectedSnapshot?: (frame: object) => void;
  } = {},
): Promise<void> {
  const w = (s: string) => writeWithBackpressure(res, s, opts.stallMs);
  const battleId = String(battle.id);
  // Resultado y metadatos públicos de la RECETA (pie + índice + cabecera + frame de resultado).
  const recipe = await S9rReader.open(String(battle.replay_ref));
  let header: any;
  let result: unknown;
  try {
    header = recipe.header;
    result = await recipe.readResult();
  } finally {
    await recipe.close();
  }
  await w(
    `{"projection":"s9.replay.public-competition.v2","projectionVersion":${JSON.stringify(PROJECTION_VERSION)},` +
      `"battleId":${JSON.stringify(battleId)}`,
  );
  if (typeof header?.rulesetId === "string") await w(`,"rulesetId":${JSON.stringify(header.rulesetId)}`);
  if (typeof header?.recordedAt === "string") await w(`,"recordedAt":${JSON.stringify(header.recordedAt)}`);
  if (meta) await w(`,"world":${JSON.stringify(scrub(meta.world))}`);
  await w(`,"snapshots":[`);
  let first = true;
  await projectViewStream(battleId, meta, view.records(), {
    onSnapshot: async (b) => {
      opts.observeProjectedSnapshot?.(b);
      await w((first ? "" : ",") + JSON.stringify(b));
      first = false;
    },
  });
  await w(`],"events":[`);
  first = true;
  const done = await projectViewStream(
    battleId,
    meta,
    view.records(),
    {
      onEvent: async (e) => {
        await w((first ? "" : ",") + JSON.stringify(e));
        first = false;
      },
    },
    { result },
  );
  await w(`],"mappingId":${JSON.stringify(done.mappingId)}`);
  if (meta) await w(`,"roster":${JSON.stringify(done.roster)}`);
  await w(`,"result":${JSON.stringify(done.result ?? null)}}`);
  res.end();
}
