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

/** Abre la vista de una batalla con replay S9R/1, o null (404 uniforme) si falta o está dañada. */
export async function openView(battle: Record<string, any>): Promise<ViewReader | null> {
  if (!isS9rReplayRef(battle.replay_ref)) return null;
  try {
    return await ViewReader.open(viewPathOf(String(battle.replay_ref)));
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
    debugOpen: false,
  };
}

/** Rango de ticks validado (mismas reglas que el segmento v1: numéricos y from <= to). */
export function parseRange(fromRaw: unknown, toRaw: unknown, ticks: number): { from: number; to: number } | null {
  const from = Number(fromRaw ?? 0);
  const to = Number(toRaw ?? ticks);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
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

/** Documento PÚBLICO proyectado de toda la batalla, ESCRITO en streaming (dos pasadas por la vista). */
export async function streamPublicDocument(
  res: Response,
  battle: Record<string, any>,
  view: ViewReader,
  meta: ViewerMeta | null,
): Promise<void> {
  const w = (s: string) => {
    res.write(s);
  };
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
  w(
    `{"projection":"s9.replay.public-competition.v2","projectionVersion":${JSON.stringify(PROJECTION_VERSION)},` +
      `"battleId":${JSON.stringify(battleId)}`,
  );
  if (typeof header?.rulesetId === "string") w(`,"rulesetId":${JSON.stringify(header.rulesetId)}`);
  if (typeof header?.recordedAt === "string") w(`,"recordedAt":${JSON.stringify(header.recordedAt)}`);
  if (meta) w(`,"world":${JSON.stringify(scrub(meta.world))}`);
  w(`,"snapshots":[`);
  let first = true;
  await projectViewStream(battleId, meta, view.records(), {
    onSnapshot: (b) => {
      w((first ? "" : ",") + JSON.stringify(b));
      first = false;
    },
  });
  w(`],"events":[`);
  first = true;
  const done = await projectViewStream(
    battleId,
    meta,
    view.records(),
    {
      onEvent: (e) => {
        w((first ? "" : ",") + JSON.stringify(e));
        first = false;
      },
    },
    { result },
  );
  w(`],"mappingId":${JSON.stringify(done.mappingId)}`);
  if (meta) w(`,"roster":${JSON.stringify(done.roster)}`);
  w(`,"result":${JSON.stringify(done.result ?? null)}}`);
  res.end();
}
