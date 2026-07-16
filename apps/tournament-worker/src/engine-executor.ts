/**
 * E9 · T9.2 — Ejecutor REAL de batallas sobre el motor de E2.
 *
 * Integra piezas reales, sin duplicarlas:
 *  - Battle + record() de apps/arena-engine (motor E2 + replay T2.6),
 *  - toEngineMap de apps/map-service (formato E4 → ArenaMap del motor),
 *  - resolveVehicle de packages/module-catalog (loadout congelado → VehicleSpec),
 *  - catálogo CONGELADO del torneo leído de module_definitions (importación E7
 *    de E3): un cambio de catálogo durante el torneo NO afecta (T9.4),
 *  - budgetCredits del torneo/ruleset de la BD (ADR-000/D7), congelado al
 *    cerrar inscripciones: aquí solo se propaga como override del ruleset.
 *
 * Código de usuario en contenedores: pendiente de entorno (sin Docker, igual
 * que E6/E7). El AgentResolver por defecto usa los stubs deterministas REALES
 * del motor (HunterBot etc.); el resolver de contenedores de E6 se enchufa por
 * la misma interfaz cuando exista el runtime.
 */
import type { Knex } from "knex";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import type { LoadoutInput, ModuleDefinition } from "../../../packages/module-catalog/types.js";
import { getCatalog } from "../../api/src/services/catalog.js";
import { toEngineMap } from "../../map-service/src/to-engine-map.js";
import type { InternalMap } from "../../map-service/src/types.js";
import { replayFromBattle, toJsonl } from "../../arena-engine/src/replay.js";
import { Battle, type BotAgent, type Participant } from "../../arena-engine/src/sim/battle.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import type { SpectateGateway } from "../../api/src/spectate/gateway.js";
import { InfrastructureFailure } from "./errors.js";
import type { BattleContext, BattleExecution, BattleExecutor } from "./battle-runner.js";

/** Modo de la plataforma → ruleset del motor (game-rules). El presupuesto y los
 * límites vienen del torneo/ruleset de BD como overrides (ADR-000). */
const ENGINE_RULESETS: Record<string, string> = {
  deathmatch: "dm_practice@1",
  team_deathmatch: "tdm_mvp@1",
  capture_the_flag: "ctf_mvp@1",
  zone_control: "zc_mvp@1",
};

export type AgentResolver = (botId: string, version: number, vehicleId: string) => BotAgent;

const defaultAgentResolver: AgentResolver = (botId) => new HunterBot(botId);

/**
 * H2 (issue #6) · Lo que el ejecutor necesita del gateway de espectador de E8
 * (T8.2). Es un Pick del SpectateGateway REAL: cualquier divergencia de firma
 * rompe en compilación — no se duplica ni se reimplementa nada de E8.
 */
export type SpectateSink = Pick<SpectateGateway, "attachBattle" | "detachBattle">;

/** Techo de ticks del motor (mismo valor por defecto que Battle.run()). */
const MAX_TICKS = 100000;
/** Cada cuántos ticks se cede el bucle de eventos para que el gateway bombee. */
const YIELD_EVERY_N_TICKS = 25;

export interface EngineExecutorOptions {
  db: Knex;
  /** Resolver de agentes: por defecto stubs deterministas del motor. */
  agentResolver?: AgentResolver;
  /** Overrides del ruleset del motor (p. ej. timeLimitTicks corto en tests). */
  rulesetOverrides?: Record<string, unknown>;
  /**
   * H2 (issue #6) · Gateway de espectador de E8: si se pasa, cada batalla se
   * registra EN VIVO con attachBattle() al arrancar (con `meta.round`, la
   * sugerencia de E11 para la vista broadcast) y se retira tras el resultado.
   */
  spectate?: SpectateSink;
  /** ms entre el final de la batalla y el detach (deja al pump del gateway entregar el resultado). */
  spectateDetachDelayMs?: number;
}

export function makeEngineExecutor(opts: EngineExecutorOptions): BattleExecutor {
  const resolver = opts.agentResolver ?? defaultAgentResolver;

  return async (ctx: BattleContext): Promise<BattleExecution> => {
    const db = opts.db;
    const { battle, participants } = ctx;

    // --- mapa (E4 real): contenido versionado en BD → ArenaMap del motor ----
    const mapRow = await db("map_versions").where({ map_id: battle.map_id, version: battle.map_version }).first();
    if (!mapRow?.content) throw new InfrastructureFailure("map_unavailable", `mapa ${battle.map_id}@${battle.map_version} sin contenido`);
    let arenaMap;
    try {
      const doc = (typeof mapRow.content === "string" ? JSON.parse(mapRow.content) : mapRow.content) as InternalMap;
      arenaMap = toEngineMap(doc);
    } catch (err) {
      throw new InfrastructureFailure("map_unavailable", `mapa ${battle.map_id} no convertible: ${String(err)}`);
    }

    // --- ruleset: presupuesto del torneo/ruleset de BD (ADR-000, congelado) --
    const dbRuleset = battle.ruleset_id ? await db("rulesets").where({ id: battle.ruleset_id }).first() : null;
    const tournament = battle.tournament_id ? await db("tournaments").where({ id: battle.tournament_id }).first() : null;
    const budgetCredits = (tournament?.budget_credits ?? dbRuleset?.budget_credits) as number | undefined;
    const engineRulesetId = ENGINE_RULESETS[battle.mode] ?? "dm_practice@1";
    const ruleset = loadRuleset(engineRulesetId, {
      ...(budgetCredits ? { budgetCredits } : {}),
      ...(opts.rulesetOverrides ?? {}),
    });

    // --- catálogo CONGELADO del torneo (T9.4) --------------------------------
    const catalogVersion = (tournament?.catalog_version ?? null) as string | null;
    let catalog: ModuleDefinition[];
    if (catalogVersion) {
      catalog = await getCatalog(db, catalogVersion);
      if (catalog.length === 0) {
        throw new InfrastructureFailure("artifact_unavailable", `catálogo congelado '${catalogVersion}' vacío o no importado`);
      }
    } else {
      // Batalla de práctica sin torneo: última versión importada.
      const latest = await db("catalog_versions").orderBy("imported_at", "desc").first();
      if (!latest) throw new InfrastructureFailure("artifact_unavailable", "sin catálogo importado");
      catalog = await getCatalog(db, latest.catalog_version as string);
    }

    // --- participantes: loadout CONGELADO (entrada del torneo, cap. 17.2) ----
    const engineParticipants: Participant[] = [];
    const agents = new Map<string, BotAgent>();
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (ctx.adminDisqualified.includes(p.bot_id)) continue; // DQ E6: no se lanza
      let loadoutRevision = null as number | null;
      if (battle.tournament_id) {
        const entry = await db("entries").where({ tournament_id: battle.tournament_id, bot_id: p.bot_id }).first();
        loadoutRevision = (entry?.loadout_revision as number) ?? null;
      }
      if (loadoutRevision === null) {
        const version = await db("bot_versions").where({ bot_id: p.bot_id, version: p.version }).first();
        loadoutRevision = (version?.loadout_revision as number) ?? 1;
      }
      const loadoutRow = await db("bot_loadouts").where({ bot_id: p.bot_id, revision: loadoutRevision }).first();
      if (!loadoutRow) {
        throw new InfrastructureFailure("artifact_unavailable", `bot ${p.bot_id}: loadout rev ${loadoutRevision} inexistente`);
      }
      const loadout: LoadoutInput = {
        loadoutId: loadoutRow.id,
        revision: loadoutRow.revision,
        catalogVersion: loadoutRow.catalog_version,
        chassis: loadoutRow.chassis,
        modules: typeof loadoutRow.modules === "string" ? JSON.parse(loadoutRow.modules) : loadoutRow.modules,
      };
      const spec = resolveVehicle(loadout, catalog);
      const vehicleId = `veh_${i + 1}`;
      engineParticipants.push({ id: vehicleId, botId: p.bot_id, team: p.team, spec });
      agents.set(vehicleId, resolver(p.bot_id, p.version, vehicleId));
    }

    // --- batalla real del motor (con replay T2.6) ----------------------------
    try {
      const b = await Battle.create({
        battleId: battle.id,
        seed: battle.seed ?? battle.id,
        ruleset,
        map: arenaMap,
        participants: engineParticipants,
        recordReplay: true,
      });
      for (const [vehicleId, agent] of agents) b.attachBot(vehicleId, agent);

      // H2 (issue #6) · Registro EN VIVO en el gateway de espectador de E8:
      // el visor/broadcast de E11 muestra la batalla de torneo en directo.
      if (opts.spectate) {
        // `meta.round` = sugerencia de E11 (entrega-E11, decisión 2): la vista
        // broadcast promociona el progreso del torneo sin tocar el contrato.
        let round: number | null = null;
        if (battle.match_id) {
          const match = await db("matches").where({ id: battle.match_id }).first();
          round = (match?.round as number) ?? null;
        }
        // E8.M anti-coaching: retardo del ruleset, salvo que E9 marque la
        // batalla 'visible' (la final se emite sin retardo, migración 008).
        const spectator =
          battle.spectator_mode === "visible"
            ? { ...(ruleset.spectator ?? {}), delaySeconds: 0 }
            : ruleset.spectator;
        opts.spectate.attachBattle(battle.id, b, {
          spectator,
          meta: {
            mode: battle.mode,
            mapId: battle.map_id,
            mapVersion: battle.map_version,
            tournamentId: battle.tournament_id,
            matchId: battle.match_id,
            round,
            official: battle.official,
          },
        });
      }

      let result;
      try {
        // Tick a tick CEDIENDO el bucle de eventos: record()/run() corren
        // síncronos y el pump del gateway no emitiría nada hasta el final.
        while (!b.isFinished() && b.tick < MAX_TICKS) {
          b.step();
          if (b.tick % YIELD_EVERY_N_TICKS === 0) await new Promise((r) => setImmediate(r));
        }
        // Cierre por el MOTOR (no se duplica su lógica): si agotó los ticks,
        // run() con el techo ya alcanzado declara el empate; si terminó,
        // devuelve el resultado ya calculado.
        result = b.run(MAX_TICKS);
      } finally {
        if (opts.spectate) {
          const sink = opts.spectate;
          const t = setTimeout(() => sink.detachBattle(battle.id), opts.spectateDetachDelayMs ?? 3000);
          t.unref?.();
        }
      }
      const replay = replayFromBattle(b, result);
      b.free();
      const statsPerBot: Record<string, unknown> = {};
      for (const p of engineParticipants) {
        statsPerBot[p.botId] = {
          team: p.team,
          teamScore: result.score[p.team] ?? 0,
          ticks: result.ticks,
          disqualified: result.disqualified.includes(p.botId),
        };
      }
      return {
        winner: result.winner,
        ticks: result.ticks,
        score: result.score,
        finalStateHash: result.finalStateHash,
        disqualified: result.disqualified,
        versions: {
          ...result.versions,
          catalog: catalogVersion ?? "latest",
          mapChecksum: (mapRow.checksum as string) ?? "",
          rulesetDb: battle.ruleset_id ?? "",
        },
        replayJsonl: toJsonl(replay),
        statsPerBot,
      };
    } catch (err) {
      if (err instanceof InfrastructureFailure) throw err;
      // El motor no arrancó o murió: fallo técnico (19.2), reintentable.
      throw new InfrastructureFailure("engine_start_failure", err instanceof Error ? err.message : String(err));
    }
  };
}

/** Todos los handlers del worker, cableados con las piezas reales. */
export function makeDefaultHandlers(opts: EngineExecutorOptions & { replaysDir?: string }) {
  // Import diferido para evitar ciclos en la carga de módulos.
  return import("./battle-runner.js").then(async ({ makeRunBattleHandler, markBattleForReview }) => {
    const { handleGenerateSchedule, handleTournamentDryRun } = await import("./scheduler.js");
    const { handleProcessResult } = await import("./results.js");
    const { handleUpdateStandings } = await import("./standings.js");
    return {
      handlers: {
        run_battle: makeRunBattleHandler({ executor: makeEngineExecutor(opts), replaysDir: opts.replaysDir }),
        generate_schedule: handleGenerateSchedule,
        process_result: handleProcessResult,
        update_standings: handleUpdateStandings,
        tournament_dry_run: handleTournamentDryRun,
      },
      onExhausted: markBattleForReview,
    };
  });
}
