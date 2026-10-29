/**
 * T7.5 · Recursos públicos de espectador (rol visitante): batallas en directo,
 * ticket WebSocket, auditoría de batalla, estadísticas y replays.
 *
 * El canal WebSocket real lo sirve el gateway/visor (E8/E10): aquí se emite el
 * ticket firmado — pendiente de reconciliación con E8 para el consumo del ticket.
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Db } from "../db/connection.js";
import { defineOperation } from "../registry.js";
import { audit } from "../audit.js";
import { pathParam } from "../params.js";
import { ROLE_RANK } from "../openapi.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, parseLimit } from "../serialize.js";
import { emptyDict } from "../../../../packages/game-rules/safe-lookup.js";
import { signSpectateTicket } from "../auth/tokens.js";
import { anonQuota, type AnonQuotaConfig } from "../middleware/anon-quota.js";
import type { BattleRunConfig } from "../battle-run.js";
import { publicSpectateEnabledFromEnv } from "../public-spectate.js";
import { publicReplaysEnabledFromEnv } from "../public-replays.js";
import { checkBattleContent } from "./catalog.js";
import { wherePublicReplay } from "../replay-access.js";
import {
  canSeeBotDiagnostics,
  getReadableBattleOr404,
  whereBattleReadable,
  whereOnlyPublicBots,
  type BattleVisibility,
} from "../battle-access.js";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { resolveBattleRuleset } from "../services/battle-ruleset-resolver.js";
import type { Request } from "express";

const SPECTATE_TICKET_TTL_S = 60;

/** Modos que se juegan por equipos: exactamente 2 bandos (4v4 como máximo). */
export const TEAM_BATTLE_MODES: readonly string[] = ["team_deathmatch", "capture_the_flag", "zone_control"];
/** Tamaño máximo de un bando en un modo de equipos (8 participantes = 4v4). */
export const MAX_PARTICIPANTS_PER_TEAM = 4;

/**
 * 4v4 · Reglas de composición de POST /battles (fases 2 y 8). Se llama con la forma
 * de cada participante ya validada (team es una cadena válida).
 *  - modos de equipo: exactamente 2 bandos, cada uno con 1..4 vehículos ⇒ 400;
 *  - deathmatch: cada vehículo su propio bando; compartir etiqueta ⇒ 409 con la
 *    salida explícita («usa team_deathmatch»), la misma regla que aplica el motor
 *    (DeathmatchMode, ERR-ENG-07) pero ANTES de encolar.
 */
export function assertTeamComposition(mode: string, participants: { team: string }[]): void {
  const byTeam = new Map<string, number>();
  for (const p of participants) byTeam.set(p.team, (byTeam.get(p.team) ?? 0) + 1);
  if (TEAM_BATTLE_MODES.includes(mode)) {
    if (byTeam.size !== 2) {
      throw new ApiError(
        400,
        "team_composition_invalid",
        `${mode} exige exactamente 2 bandos con al menos 1 participante cada uno; recibidos ${byTeam.size}`,
      );
    }
    for (const [team, n] of byTeam) {
      if (n > MAX_PARTICIPANTS_PER_TEAM) {
        throw new ApiError(
          400,
          "team_too_large",
          `el bando ${team} tiene ${n} participantes; máximo ${MAX_PARTICIPANTS_PER_TEAM} por bando`,
        );
      }
    }
    return;
  }
  if (mode === "deathmatch") {
    const shared = [...byTeam].filter(([, n]) => n > 1).map(([t]) => t);
    if (shared.length > 0) {
      throw conflict(
        "deathmatch_shared_team",
        `deathmatch exige que cada participante tenga su propio bando; compartidos: ${shared.join(", ")}. ` +
          `Para jugar por equipos usa team_deathmatch`,
        { teams: shared },
      );
    }
  }
}

/**
 * R2.6 (ERR-SEC-16): base del WebSocket de espectador. En producción es
 * OBLIGATORIO configurar SPECTATE_WS_URL con esquema wss:// (el ticket viaja
 * por ese canal); si falta o va en claro, se falla CERRADO con 500 de
 * configuración en vez de emitir tickets que viajarían sin cifrar.
 */
/**
 * Base del WebSocket de espectador que se devuelve al navegador.
 *
 * REVIEW (cierre funcional, TD-030/D2) · además de `wss://…` se admite una ruta
 * RELATIVA al origen (`/ws/spectate`, la que enruta el gateway): el cliente la ancla
 * a `location` (wss bajo https, apps/web/src/viewer/spectator-client.ts
 * resolveWsUrl), así que nunca viaja en claro detrás de TLS y no depende del nombre
 * público. En producción sigue fallando CERRADO: sin valor, `ws://` en claro o
 * una ruta protocol-relative (`//host`) ⇒ 500. El compose pasa `/ws/spectate`.
 */
export function spectateWsBase(): string {
  const wsBase = process.env.SPECTATE_WS_URL ?? "ws://localhost:8081/spectate";
  const sameOriginPath = /^\/(?!\/)/.test(wsBase);
  if (process.env.NODE_ENV === "production" && !(wsBase.startsWith("wss://") || sameOriginPath)) {
    throw new ApiError(
      500,
      "spectate_ws_misconfigured",
      "SPECTATE_WS_URL debe ser wss:// o una ruta del mismo origen (/ws/spectate) en producción",
    );
  }
  if (process.env.NODE_ENV === "production" && process.env.SPECTATE_WS_URL === undefined) {
    throw new ApiError(500, "spectate_ws_misconfigured", "SPECTATE_WS_URL no configurada");
  }
  return wsBase.replace(/\/+$/, "");
}

// DEV-B (TD-002) · La reserva atómica de una batalla (`scheduled → running`) ya
// NO vive en la API: la hace la autoridad única de ejecución, el tournament-worker
// (`claimBattle` en apps/tournament-worker/src/battle-runner.ts, con lease).

/**
 * Encola `run_battle` de forma IDEMPOTENTE (dedupe_key `run_battle:<id>`, el mismo
 * convenio que usa el scheduler de torneos). Devuelve true si insertó la fila.
 */
export async function enqueueRunBattle(db: Db, battleId: string): Promise<boolean> {
  const rows = await db("jobs")
    .insert({ kind: "run_battle", payload: JSON.stringify({ battleId }), dedupe_key: `run_battle:${battleId}` })
    .onConflict("dedupe_key")
    .ignore()
    .returning("id");
  return rows.length > 0;
}

/**
 * Participantes de una batalla con el NOMBRE del bot (UX-D · D1: la web mostraba
 * UUIDs) y su dueño (sólo para decidir quién ve diagnósticos; nunca se serializa).
 */
export async function loadParticipants(db: Db, battleId: string): Promise<Record<string, unknown>[]> {
  return db("participants")
    .leftJoin("bots", "bots.id", "participants.bot_id")
    .where("participants.battle_id", battleId)
    .select("participants.*", "bots.name as bot_name", "bots.owner_id as bot_owner_id")
    .orderBy("participants.team", "asc");
}

/**
 * Proyección de una batalla. `viewer` decide qué participantes llevan su CPU
 * (diagnóstico: sólo el dueño del bot y el staff, TD-047); sin `viewer`, ninguno.
 */
export function battleToJson(
  b: Record<string, unknown>,
  participants: Record<string, unknown>[],
  viewer?: Request["auth"] | null,
) {
  return {
    id: b.id,
    tournamentId: b.tournament_id ?? undefined,
    status: b.status,
    official: b.official,
    mode: b.mode,
    rulesetId: b.ruleset_id ?? undefined,
    mapId: b.map_id,
    mapName: b.map_name ?? undefined,
    mapVersion: b.map_version,
    participants: participants.map((p) => {
      const mine = viewer !== undefined && canSeeBotDiagnostics(viewer ?? undefined, p.bot_owner_id as string | null);
      return {
        botId: p.bot_id,
        botName: p.bot_name ?? undefined,
        version: p.version,
        team: p.team,
        outcome: p.outcome ?? undefined,
        // Sólo dice si EL SOLICITANTE puede ver el diagnóstico de este bot.
        ...(viewer !== undefined ? { diagnosticsVisible: mine } : {}),
        cpuMs: !mine || p.cpu_ms === null || p.cpu_ms === undefined ? null : Number(p.cpu_ms),
      };
    }),
    result: b.result ?? undefined,
    failureKind: b.failure_kind,
    createdAt: b.created_at ? new Date(b.created_at as string).toISOString() : undefined,
    startedAt: b.started_at ? new Date(b.started_at as string).toISOString() : undefined,
    finishedAt: b.finished_at ? new Date(b.finished_at as string).toISOString() : undefined,
    replayAvailable: Boolean(b.replay_ref),
    replayHash: b.replay_hash ?? undefined,
  };
}

/**
 * R11 · Proyección PÚBLICA de una batalla en directo: SOLO id, estado, modo,
 * mapa (id+nombre) y timestamps. Nunca seed, tickets, participantes ni datos
 * de propietario.
 */
function publicLiveBattleToJson(b: Record<string, unknown>): Record<string, unknown> {
  return {
    id: b.id,
    status: b.status,
    mode: b.mode,
    mapId: b.map_id,
    mapName: b.map_name,
    createdAt: (b.created_at as Date).toISOString(),
    startedAt: b.started_at ? (b.started_at as Date).toISOString() : undefined,
    finishedAt: b.finished_at ? (b.finished_at as Date).toISOString() : undefined,
  };
}

/**
 * R11 · Proyección PÚBLICA de una batalla FINALIZADA con replay: id, estado,
 * modo, mapa (id+nombre), timestamps, participantes (SOLO botId/version/team/
 * outcome deportivo) y resultado agregado (score+ticks). Nunca seed,
 * seedCommitment, seedRevealProof, tickets, replay_ref (ruta interna del
 * archivo) ni datos de propietario/cuenta.
 */
function publicReplayBattleToJson(b: Record<string, unknown>, participants: Record<string, unknown>[]) {
  const result = (b.result ?? undefined) as { score?: Record<string, number>; ticks?: number } | undefined;
  return {
    id: b.id,
    status: b.status,
    mode: b.mode,
    mapId: b.map_id,
    mapName: b.map_name,
    createdAt: (b.created_at as Date).toISOString(),
    startedAt: b.started_at ? (b.started_at as Date).toISOString() : undefined,
    finishedAt: b.finished_at ? (b.finished_at as Date).toISOString() : undefined,
    participants: participants.map((p) => ({
      botId: p.bot_id,
      version: p.version,
      team: p.team,
      outcome: p.outcome ?? undefined,
    })),
    result: result ? { score: result.score, ticks: result.ticks } : undefined,
    replayAvailable: Boolean(b.replay_ref),
  };
}

/** Límite de página del listado público de replays: más estricto que parseLimit (100), tope 50. */
function parsePublicReplayLimit(raw: unknown): number {
  const n = Number(raw ?? 20);
  if (!Number.isInteger(n) || n < 1) return 20;
  return Math.min(n, 50);
}

async function getFinishedBattleWithReplayOr404(db: Db, id: string) {
  // PRC (TD-004) · mismo predicado público que el listado y que el visor.
  const battle = await wherePublicReplay(db, db("battles").join("maps", "maps.id", "battles.map_id"))
    .where({ "battles.id": id })
    .whereNotNull("battles.replay_ref")
    .select(
      "battles.id as id",
      "battles.status as status",
      "battles.mode as mode",
      "battles.map_id as map_id",
      "maps.name as map_name",
      "battles.created_at as created_at",
      "battles.started_at as started_at",
      "battles.finished_at as finished_at",
      "battles.result as result",
      "battles.replay_ref as replay_ref",
    )
    .first()
    .catch(() => null);
  if (!battle) throw notFound();
  return battle;
}

/** Nombre del mapa de una batalla (la web lo muestra en vez del id). */
async function withMapName(db: Db, battle: Record<string, any>): Promise<Record<string, any>> {
  const map = await db("maps")
    .where({ id: battle.map_id })
    .first("name")
    .catch(() => null);
  return { ...battle, map_name: map?.name ?? undefined };
}

const NO_STORE = "private, no-store";

/** `maxConsecutiveTimeouts` del ruleset con el que corrió la batalla, o null si no se sabe. */
async function maxConsecutiveTimeoutsOf(db: Db, battle: Record<string, any>): Promise<number | null> {
  const versions = (battle.engine_versions ?? {}) as Record<string, unknown>;
  try {
    // El ruleset del MOTOR que se usó (engine-executor lo deja en engine_versions);
    // si no está (batalla sin ejecutar), la misma resolución que usa el worker.
    if (typeof versions.rulesetEngine === "string" && versions.rulesetEngine) {
      return Number(loadRuleset(versions.rulesetEngine).maxConsecutiveTimeouts);
    }
    const r = await resolveBattleRuleset(db, battle.mode, battle.ruleset_id);
    return r.ok ? Number(r.ruleset.maxConsecutiveTimeouts) : null;
  } catch {
    return null;
  }
}

/**
 * UX-06 · Diagnóstico de UN bot para su dueño: combina lo que midió quien ejecutó
 * la batalla (`participants.diagnostics`: arranque, transporte, contenedor) con lo
 * que sale del replay (`battle_stats`: decisiones, timeouts, rechazos). Lo que no
 * se midió va a `null` (la web dice «no medido»), nunca a un cero inventado.
 * Sólo códigos y contadores: nada del sandbox.
 */
function buildDiagnostics(
  p: Record<string, unknown>,
  s: Record<string, any> | undefined,
  result: { disqualified?: string[]; endReason?: string },
  maxConsecutiveTimeouts: number | null,
) {
  const raw = p.diagnostics;
  const d = (typeof raw === "string" ? JSON.parse(raw) : (raw ?? null)) as Record<string, any> | null;
  const proto = d?.protocol ?? null;
  const disqualified = p.outcome === "disqualified" || (result.disqualified ?? []).includes(String(p.bot_id));
  let disqualifiedReason: string | null = null;
  if (disqualified) {
    if (d?.startup?.ok === false) disqualifiedReason = d.startup.reason ?? "startup_failed";
    else if (s?.disqualified) disqualifiedReason = "consecutive_timeouts";
    else if (result.endReason === "walkover" || !s) disqualifiedReason = "administrative";
    else disqualifiedReason = "unknown";
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    botId: p.bot_id,
    botName: p.bot_name ?? undefined,
    version: p.version,
    /** Hay medida del ejecutor (arranque/transporte); false en batallas antiguas. */
    measured: d !== null,
    startup: d?.startup ?? null,
    hello: proto ? { ok: Boolean(proto.helloOk), tick: num(proto.helloTick), reconnects: num(proto.reconnects) } : null,
    decisions: num(s?.decisions),
    decisionTimeouts: num(s?.decisionTimeouts),
    maxConsecutiveTimeouts,
    disqualified,
    disqualifiedReason,
    commands: proto
      ? {
          received: num(proto.commandsReceived),
          invalid: num(proto.invalidCommands),
          firstInvalidReason: typeof proto.firstInvalidReason === "string" ? proto.firstInvalidReason : null,
          invalidJson: num(proto.invalidJson),
          late: num(proto.lateCommands),
          wrongTick: num(proto.wrongTickCommands),
          extra: num(proto.extraCommands),
        }
      : null,
    rejectionsByReason: s?.rejectionsByReason ?? null,
    disconnectedAtTick: proto ? num(proto.disconnectedAtTick) : null,
    container: d?.container
      ? {
          exitCode: num(d.container.exitCode),
          oomKilled: Boolean(d.container.oomKilled),
          exitedDuringBattle: Boolean(d.container.exitedDuringBattle),
        }
      : null,
    cpuMs: p.cpu_ms === null || p.cpu_ms === undefined ? null : Number(p.cpu_ms),
    shotsFired: num(s?.shotsFired),
    shotsHit: num(s?.shotsHit),
    damageDealt: num(s?.damageDealt),
  };
}

export function battleRoutes(
  db: Db,
  quota: AnonQuotaConfig,
  // Se mantiene la firma (app.ts la pasa); `/run` ya no usa el launcher (TD-002).
  _runCfg?: BattleRunConfig,
  publicSpectateEnabled: boolean = publicSpectateEnabledFromEnv(),
  publicReplaysEnabled: boolean = publicReplaysEnabledFromEnv(),
): Router {
  const router = Router();
  // UX-D (G-08) · una sola política de lectura para listado, detalle, stats,
  // auditoría, ticket de espectador y /run (battle-access.ts).
  const vis: BattleVisibility = { publicReplays: publicReplaysEnabled, publicSpectate: publicSpectateEnabled };

  // R11 · Slice mínimo de espectador público: gateado por S9_PUBLIC_SPECTATE_ENABLED
  // (apagado por defecto). Responde 200 SIEMPRE, sin cuenta; si está apagado,
  // enabled=false y battles=[] (nunca 403/404).
  defineOperation(
    router,
    "listPublicLiveBattles",
    async (_req, res) => {
      if (!publicSpectateEnabled) {
        res.json({ enabled: false, battles: [] });
        return;
      }
      // UX-D (G-08) · sólo las que un anónimo puede VER de verdad: sin bots no
      // públicos (las demás darían 404 al pedir el ticket).
      const rows = await whereOnlyPublicBots(
        db,
        db("battles").join("maps", "maps.id", "battles.map_id").where({ "battles.status": "running" }),
      )
        .select(
          "battles.id as id",
          "battles.status as status",
          "battles.mode as mode",
          "battles.map_id as map_id",
          "maps.name as map_name",
          "battles.created_at as created_at",
          "battles.started_at as started_at",
          "battles.finished_at as finished_at",
        )
        .orderBy("battles.started_at", "desc")
        .limit(50);
      res.setHeader("Cache-Control", "public, max-age=5");
      res.json({ enabled: true, battles: rows.map(publicLiveBattleToJson) });
    },
    // R13.2 · REGRESSION LOCK: cuota anónima (T7.5, DoD) — igual que el resto de
    // rutas públicas (spectate-ticket, replay, replay-verify). Un listado sin
    // cuenta y sin cuota es un vector de scraping/DoS barato.
    (req, res, next) => anonQuota(db, "public-live", quota)(req, res, next),
  );

  /**
   * N5/R11 · Estado público de UNA batalla por id (a diferencia de la LISTA,
   * que responde 200 enabled:false para que la UI muestre el aviso): con la
   * capability apagada, un recurso por-id responde 404 SIEMPRE, exista o no
   * la batalla — revelar la existencia/estado de un id concreto cuando la
   * capability está apagada filtraría más que un listado vacío. Con la
   * capability encendida, también 404 si la batalla no existe o no está
   * `running` (no está en directo ⇒ no es públicamente visible por id):
   * nunca se distingue "no existe" de "no está en directo" a un visitante.
   */
  defineOperation(
    router,
    "getPublicLiveBattle",
    async (req, res) => {
      if (!publicSpectateEnabled) throw notFound();
      const battleId = pathParam(req, "battleId");
      const battle = await whereOnlyPublicBots(
        db,
        db("battles")
          .join("maps", "maps.id", "battles.map_id")
          .where({ "battles.id": battleId, "battles.status": "running" }),
      )
        .select(
          "battles.id as id",
          "battles.status as status",
          "battles.mode as mode",
          "battles.map_id as map_id",
          "maps.name as map_name",
          "battles.created_at as created_at",
          "battles.started_at as started_at",
          "battles.finished_at as finished_at",
        )
        .first();
      if (!battle) throw notFound();
      res.setHeader("Cache-Control", "public, max-age=5");
      res.json(publicLiveBattleToJson(battle));
    },
    // Igual patrón que listPublicLiveBattles: ruta pública sin cuenta, cuota
    // anti-scraping/DoS propia (route distinta para no compartir presupuesto
    // con el listado).
    (req, res, next) => anonQuota(db, "public-battle", quota)(req, res, next),
  );

  // ---------------------------------------------- R11 · replay público
  // Namespace propio /public/replays* (no /public/battles/{battleId}, ya
  // ocupado por getPublicLiveBattle para batallas `running`). Gateado por
  // S9_PUBLIC_REPLAYS_ENABLED, apagado por defecto. Solo batallas `finished`
  // CON replay publicado: una batalla en curso nunca se expone por esta vía
  // (para eso está el espectador, con su propio flag).
  defineOperation(
    router,
    "listPublicReplays",
    async (req, res) => {
      if (!publicReplaysEnabled) {
        res.json({ enabled: false, items: [] });
        return;
      }
      const limit = parsePublicReplayLimit(req.query.limit);
      const cursor = decodeCursor(req.query.cursor as string | undefined);
      // PRC (TD-004) · «público» = finished + ningún bot participante no-público
      // (replay-access.ts). Activar la capability NO publica todos los ficheros.
      let q = wherePublicReplay(db, db("battles").join("maps", "maps.id", "battles.map_id"))
        .whereNotNull("battles.replay_ref")
        .select(
          "battles.id as id",
          "battles.status as status",
          "battles.mode as mode",
          "battles.map_id as map_id",
          "maps.name as map_name",
          "battles.created_at as created_at",
          "battles.started_at as started_at",
          "battles.finished_at as finished_at",
          "battles.result as result",
          "battles.replay_ref as replay_ref",
        )
        .orderBy([
          { column: "battles.created_at", order: "desc" },
          { column: "battles.id", order: "desc" },
        ])
        .limit(limit + 1);
      if (cursor) q = q.whereRaw("(battles.created_at, battles.id) < (?, ?)", [cursor.createdAt, cursor.id]);
      const rows = await q;
      const page = rows.slice(0, limit);
      const items = await Promise.all(
        page.map(async (b: Record<string, unknown>) =>
          publicReplayBattleToJson(b, await db("participants").where({ battle_id: b.id })),
        ),
      );
      res.setHeader("Cache-Control", "public, max-age=30");
      res.json({
        enabled: true,
        items,
        nextCursor:
          rows.length > limit
            ? encodeCursor(page[page.length - 1].created_at as Date, page[page.length - 1].id as string)
            : undefined,
      });
    },
    (req, res, next) => anonQuota(db, "public-replays-list", quota)(req, res, next),
  );

  defineOperation(
    router,
    "getPublicReplay",
    async (req, res) => {
      if (!publicReplaysEnabled) throw notFound();
      const battleId = pathParam(req, "battleId");
      const battle = await getFinishedBattleWithReplayOr404(db, battleId);
      const participants = await db("participants").where({ battle_id: battle.id });
      res.setHeader("Cache-Control", "public, max-age=3600, immutable");
      res.json(publicReplayBattleToJson(battle, participants));
    },
    (req, res, next) => anonQuota(db, "public-replay", quota)(req, res, next),
  );

  defineOperation(
    router,
    "downloadPublicReplay",
    async (req, res) => {
      if (!publicReplaysEnabled) throw notFound();
      const battleId = pathParam(req, "battleId");
      const battle = await getFinishedBattleWithReplayOr404(db, battleId);
      let bytes: Buffer;
      try {
        bytes = await readFile(battle.replay_ref as string);
      } catch {
        throw notFound("Replay no disponible");
      }
      res
        .status(200)
        .setHeader("Content-Type", "application/octet-stream")
        .setHeader("Cache-Control", "public, max-age=3600, immutable")
        .send(bytes);
    },
    (req, res, next) => anonQuota(db, "public-replay-download", quota)(req, res, next),
  );

  defineOperation(router, "listBattles", async (req, res) => {
    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    // UX-D (G-08 · TD-047) · sólo las batallas que el solicitante puede leer.
    let q = db("battles")
      .leftJoin("maps", "maps.id", "battles.map_id")
      .select("battles.*", "maps.name as map_name")
      .orderBy([
        { column: "battles.created_at", order: "desc" },
        { column: "battles.id", order: "desc" },
      ])
      .limit(limit + 1);
    q = whereBattleReadable(db, q, req.auth, vis);
    if (typeof req.query.status === "string") q = q.where("battles.status", req.query.status);
    if (cursor) q = q.whereRaw("(battles.created_at, battles.id) < (?, ?)", [cursor.createdAt, cursor.id]);
    const rows = await q;
    const page = rows.slice(0, limit);
    const items = await Promise.all(
      page.map(async (b: Record<string, unknown>) =>
        battleToJson(b, await loadParticipants(db, b.id as string), req.auth ?? null),
      ),
    );
    // Depende de quién pregunta: nunca en una caché compartida.
    res.setHeader("Cache-Control", NO_STORE);
    res.json({
      items,
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id) : undefined,
    });
  });

  defineOperation(router, "getBattle", async (req, res) => {
    const battle = await withMapName(db, await getReadableBattleOr404(db, pathParam(req, "battleId"), req.auth, vis));
    res.setHeader("Cache-Control", NO_STORE);
    res.json(battleToJson(battle, await loadParticipants(db, battle.id), req.auth ?? null));
  });

  defineOperation(router, "createPracticeBattle", async (req, res) => {
    const { mode, rulesetId, mapId, mapVersion, seed, participants } = req.body ?? {};
    if (!["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"].includes(mode)) {
      throw badRequest("mode inválido");
    }
    if (!Array.isArray(participants) || participants.length < 1 || participants.length > 8) {
      throw badRequest("participants: entre 1 y 8");
    }
    // REVIEW (R4.5, TD-NEW-C1) · compatibilidad modo ↔ ruleset ↔ mapa con la
    // MISMA regla que usa la web (checkBattleContent de catalog.ts, DEV-C). Antes
    // POST /battles aceptaba un ruleset de otro modo o un mapa que no soporta el
    // modo, y el fallo aparecía tarde, en el worker.
    const content = await checkBattleContent(db, { mode, rulesetId, mapId, mapVersion });
    if (!content.ok) throw new ApiError(content.status, content.code, content.message);
    const map = { map_id: content.map.mapId, version: content.map.version };

    // DEV-B · forma de cada participante y composición mínima. PK de participants
    // = (battle_id, bot_id): un mismo bot NO puede ir en dos bandos (ni dos veces
    // en el mismo); antes eso acababa en un 500 por violación de PK.
    const seen = new Set<string>();
    for (const p of participants) {
      if (!p || typeof p !== "object") throw badRequest("participants: cada elemento debe ser un objeto");
      if (typeof p.botId !== "string" || p.botId.length === 0) throw badRequest("participants[].botId obligatorio");
      if (!Number.isInteger(p.version) || p.version < 1) throw badRequest("participants[].version: entero >= 1");
      if (typeof p.team !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(p.team)) {
        throw badRequest("participants[].team: 1-32 caracteres [A-Za-z0-9_-]");
      }
      if (seen.has(p.botId)) throw badRequest("participants: un bot solo puede aparecer una vez por batalla");
      seen.add(p.botId);
    }

    // 4v4 · COMPOSICIÓN por bando, antes de tocar bots o cola. Sin esto, una
    // combinación que el motor rechaza (DM con bandos compartidos) se encolaba y
    // acababa en `engine_start_failure`, que el worker reintenta como si fuera un
    // fallo de infraestructura. No depende de ningún dato privado: se puede
    // responder antes de la comprobación de visibilidad sin filtrar nada.
    assertTeamComposition(mode, participants);

    // TD-005 · PROPIEDAD/VISIBILIDAD: sólo se puede meter en una batalla un bot
    // propio, público o de un equipo del que el solicitante es miembro (los
    // admin, cualquiera). Un bot privado ajeno responde EXACTAMENTE igual que uno
    // inexistente (404): no se revela que existe. Antes no se comprobaba nada.
    const userId = req.auth?.userId ?? null;
    const isAdmin = (req.auth?.rank ?? 0) >= ROLE_RANK.admin;
    for (const p of participants) {
      const bot = await db("bots")
        .where({ id: p.botId })
        .first()
        .catch(() => null);
      let visible = Boolean(bot) && (isAdmin || bot.owner_id === userId || bot.visibility === "public");
      if (bot && !visible && bot.visibility === "team" && bot.team_id && userId) {
        visible = Boolean(await db("team_members").where({ team_id: bot.team_id, user_id: userId }).first());
      }
      if (!visible) throw new ApiError(404, "bot_not_found", `El bot ${p.botId} no existe o no es accesible`);
    }

    for (const p of participants) {
      const v = await db("bot_versions")
        .where({ bot_id: p.botId, version: p.version })
        .first()
        .catch(() => null);
      if (!v || !["published", "frozen"].includes(v.state)) {
        throw conflict("bot_not_published", `El bot ${p.botId} v${p.version} no está publicado`);
      }
    }

    // Una sola transacción: batalla + participantes + trabajo. Antes eran tres
    // escrituras sueltas (una batalla podía quedar sin trabajo, o sin participantes).
    const battle = await db.transaction(async (trx) => {
      const [row] = await trx("battles")
        .insert({
          status: "scheduled",
          official: false, // las de práctica no afectan al rating
          mode,
          ruleset_id: rulesetId,
          map_id: map.map_id,
          map_version: map.version,
          seed: seed ?? null,
        })
        .returning("*");
      await trx("participants").insert(
        participants.map((p: { botId: string; version: number; team: string }) => ({
          battle_id: row.id,
          bot_id: p.botId,
          version: p.version,
          team: p.team,
        })),
      );
      // AUTORIDAD ÚNICA (TD-002): la batalla la ejecuta el tournament-worker. El
      // dedupe_key hace idempotente el encolado (mismo convenio que el scheduler).
      await enqueueRunBattle(trx, row.id);
      return row;
    });
    res.status(202).json(battleToJson(battle, await db("participants").where({ battle_id: battle.id })));
  });

  defineOperation(
    router,
    "getSpectateTicket",
    async (req, res) => {
      // Carril J · FAIL-CLOSED del espectador PÚBLICO. Este endpoint es
      // `security: []` (x-min-role visitor): antes emitía un ticket de espectador
      // a CUALQUIER visitante anónimo aunque S9_PUBLIC_SPECTATE_ENABLED estuviera
      // apagada, así que la puerta pública NO gobernaba el canal WebSocket — solo
      // los endpoints REST /public/*. Con la capability apagada el ticket anónimo
      // ya no se emite: 404 (mismo trato que getPublicLiveBattle, para no revelar
      // si el id existe). Una sesión autenticada sigue pudiendo espectar: el
      // espectador interno del producto no es "espectador público".
      if (!publicSpectateEnabled && !req.auth) throw notFound();
      // UX-D (G-08) · el ticket sigue la MISMA política que el resto de vistas de
      // la batalla: antes cualquier sesión (y, con el directo público, cualquier
      // anónimo) obtenía ticket para la batalla de un bot privado ajeno.
      const battle = await getReadableBattleOr404(db, pathParam(req, "battleId"), req.auth, vis);
      // E8/T8.2: jti ⇒ el gateway hace el ticket de UN SOLO USO; debug ⇒ capas de
      // depuración (sensores, rutas, colisiones) solo para roles autorizados: el flag
      // viaja FIRMADO por la API, el visor no puede autoconcedérselo.
      const debug = (req.auth?.rank ?? 0) >= ROLE_RANK.moderator;
      // `anon` viaja FIRMADO por la API para que el gateway (otro proceso) pueda
      // aplicar la capability sin consultar la BD ni creerse al cliente.
      const ticket = signSpectateTicket(
        { battleId: battle.id, jti: randomUUID(), debug, anon: !req.auth },
        SPECTATE_TICKET_TTL_S,
      );
      // El canal transporta SOLO snapshots públicos (D8): lo sirve el gateway (E8/E10).
      // R2.6 (ERR-SEC-16): en producción se EXIGE wss:// — el defecto en claro
      // solo vale para dev/test. Falla cerrado: mejor 500 que un ticket que
      // viajaría sin cifrar (y acabaría en logs de red intermedios).
      const wsBase = spectateWsBase();
      res.status(201).json({
        ticket,
        wsUrl: `${wsBase}/${battle.id}`,
        expiresAt: new Date(Date.now() + SPECTATE_TICKET_TTL_S * 1000).toISOString(),
      });
    },
    // Cuota anónima (DoD T7.5)
    (req, res, next) => anonQuota(db, "spectate-ticket", quota)(req, res, next),
  );

  defineOperation(router, "getBattleAudit", async (req, res) => {
    const battle = await getReadableBattleOr404(db, pathParam(req, "battleId"), req.auth, vis);
    const map = await db("map_versions").where({ map_id: battle.map_id, version: battle.map_version }).first();
    const participants = await db("participants").where({ battle_id: battle.id });
    const artifacts = [];
    for (const p of participants) {
      const v = await db("bot_versions").where({ bot_id: p.bot_id, version: p.version }).first();
      const art = v?.artifact_hash ? await db("artifacts").where({ hash: v.artifact_hash }).first() : null;
      artifacts.push({
        botId: p.bot_id,
        version: p.version,
        artifactHash: v?.artifact_hash ?? undefined,
        signature: art?.signature ?? undefined,
      });
    }
    // La auditabilidad no exige revelar código (contrato E1); la ve quien ve la batalla.
    res.setHeader("Cache-Control", NO_STORE);
    res.json({
      battleId: battle.id,
      seed: battle.seed ?? undefined,
      seedCommitment: battle.seed_commitment ?? undefined,
      seedRevealProof: battle.seed_reveal_proof ?? undefined,
      versions: battle.engine_versions ?? {},
      map: { mapId: battle.map_id, version: battle.map_version, checksum: map?.checksum ?? undefined },
      artifacts,
      finalStateHash: battle.final_state_hash ?? undefined,
    });
  });

  defineOperation(router, "getBattleStats", async (req, res) => {
    const battle = await getReadableBattleOr404(db, pathParam(req, "battleId"), req.auth, vis);
    const rows = await db("battle_stats").where({ battle_id: battle.id });
    const participants = await loadParticipants(db, battle.id);
    const statsByBot = new Map<string, Record<string, any>>();
    for (const r of rows) statsByBot.set(String(r.bot_id), typeof r.stats === "string" ? JSON.parse(r.stats) : r.stats);

    // B8 · `emptyDict()`, NO `{}`: `bot_id` es un valor de BD usado como clave.
    const perBot: Record<string, unknown> = emptyDict<unknown>();
    const diagnostics: Record<string, unknown> = emptyDict<unknown>();
    const result = (battle.result ?? {}) as { disqualified?: string[]; endReason?: string };
    const maxTimeouts = await maxConsecutiveTimeoutsOf(db, battle);
    for (const p of participants) {
      const botId = String(p.bot_id);
      const s = statsByBot.get(botId);
      const owner = canSeeBotDiagnostics(req.auth, p.bot_owner_id as string | null);
      if (s) {
        // Lo deportivo lo ve quien ve la batalla; la CPU y el desglose de
        // decisiones y rechazos son diagnóstico (TD-047): sólo dueño y staff.
        const { cpuMs: _cpu, decisions: _dec, rejectionsByReason: _rej, ...sporting } = s;
        // UX-F (DEF-R12) · los turnos sin responder y los rechazos por módulo
        // también son diagnóstico (cuánto falla TU código), no deporte: un rival no
        // los ve. Daño, disparos, aciertos y estado final de los módulos, sí.
        if (!owner) {
          delete sporting.decisionTimeouts;
          if (sporting.perModule && typeof sporting.perModule === "object") {
            sporting.perModule = Object.fromEntries(
              Object.entries(sporting.perModule as Record<string, Record<string, unknown>>).map(([slot, m]) => {
                const { rejections: _r, ...rest } = m ?? {};
                return [slot, rest];
              }),
            );
          }
        }
        perBot[botId] = { ...sporting, botName: p.bot_name ?? undefined, version: p.version };
      }
      if (owner) {
        diagnostics[botId] = buildDiagnostics(p, s, result, maxTimeouts);
      }
    }

    // TD-065 · justo tras `finished` el job de stats aún no ha escrito: eso es
    // «pendiente», no «sin estadísticas». Sin replay (walkover, fallo deportivo,
    // fallida) no habrá estadísticas nunca: «unavailable». Nada se cachea.
    let status: "ready" | "pending" | "unavailable" = "unavailable";
    if (rows.length > 0) status = "ready";
    else if (battle.status === "scheduled" || battle.status === "running") status = "pending";
    else if (battle.status === "finished" && battle.replay_ref) status = "pending";
    res.setHeader("Cache-Control", NO_STORE);
    res.json({ battleId: battle.id, status, perBot, diagnostics });
  });

  // PRC (TD-004) · getReplay, getReplayIndex, getReplaySegment, verifyReplay y
  // listReplays viven en routes/replays.ts, detrás de la política única de
  // replay-access.ts.

  // DEV-B (TD-002) · `POST /battles/{id}/run` YA NO EJECUTA NADA. Antes lanzaba la
  // batalla por un segundo camino (API → arena-engine → contenedores) que competía
  // con el tournament-worker por la misma batalla y, al completar, la dejaba
  // `running` para siempre sin resultado. Ahora DELEGA en la autoridad única: se
  // asegura de que el trabajo `run_battle` está en la cola (idempotente por
  // `dedupe_key`) y responde 202. Llamarlo dos veces no ejecuta dos veces nada.
  defineOperation(router, "runBattle", async (req, res) => {
    const battleId = pathParam(req, "battleId");
    // UX-D (G-08) · misma política de lectura: antes cualquier usuario «tocaba» por
    // id la batalla de otro.
    const battle = await getReadableBattleOr404(db, battleId, req.auth, vis);
    if (battle.status !== "scheduled") {
      res.status(409).json({ error: "invalid_state", message: `La batalla está en estado ${battle.status}` });
      return;
    }
    const enqueued = await enqueueRunBattle(db, battleId);
    await audit(db, {
      actorId: req.auth?.userId ?? null,
      action: "battle.run_requested",
      target: `battle:${battleId}`,
      detail: { delegatedTo: "tournament-worker", jobEnqueued: enqueued },
      correlationId: req.correlationId,
    });
    res.status(202).json({ battleId, status: "scheduled", delegatedTo: "tournament-worker", jobEnqueued: enqueued });
  });

  return router;
}
