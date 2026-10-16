/**
 * E9 · T9.2 — Ejecutor REAL de batallas sobre el motor de E2.
 *
 * Integra piezas reales, sin duplicarlas:
 *  - Battle + replay de apps/arena-engine (motor E2 + replay T2.6),
 *  - toEngineMap de apps/map-service (formato E4 → ArenaMap del motor),
 *  - resolveVehicle de packages/module-catalog (loadout congelado → VehicleSpec),
 *  - catálogo CONGELADO del torneo leído de module_definitions (T9.4),
 *  - ruleset del motor resuelto con `resolveBattleRuleset` (el mismo que usaba el
 *    launcher de /run: `rulesets.config.engineRulesetId` o el defecto del modo, y
 *    se exige que el modo coincida) + budgetCredits del torneo/ruleset de BD.
 *
 * QUIÉN CONDUCE LOS VEHÍCULOS (cierre funcional, DEV-B · TD-002): un `AgentDriver`
 * OBLIGATORIO. Ya NO hay resolver por defecto: antes era
 * `defaultAgentResolver = (botId) => new HunterBot(botId)`, una sustitución
 * SILENCIOSA del código de cada usuario por el stub del motor en todas las
 * batallas (práctica, torneo y ranking). Ahora:
 *  - producción: `containerAgents()` (container-agents.ts) — el código del bot en
 *    su contenedor del sandbox, hablando el protocolo arena/1 con el
 *    ProtocolServer que este proceso aloja;
 *  - tests/demo: `inProcessAgents(resolver)` con un resolver EXPLÍCITO (p. ej.
 *    testing/stub-agents.ts), que se niega a construirse con NODE_ENV=production.
 * Sin driver, `makeEngineExecutor` LANZA al construirse.
 */
import type { Knex } from "knex";
import { loadRuleset, type Ruleset } from "../../../packages/game-rules/index.js";
import { resolveVehicle } from "../../../packages/module-catalog/resolve/index.js";
import type { LoadoutInput, ModuleDefinition } from "../../../packages/module-catalog/types.js";
import { getCatalog } from "../../api/src/services/catalog.js";
import { toEngineMap } from "../../map-service/src/to-engine-map.js";
import type { InternalMap } from "../../map-service/src/types.js";
import { replayFromBattle, toJsonl, type Replay } from "../../arena-engine/src/replay.js";
import { Battle, type BattleResult, type BotAgent, type Participant } from "../../arena-engine/src/sim/battle.js";
import type { SpectateGateway } from "../../api/src/spectate/gateway.js";
import { resolveBattleRuleset } from "../../api/src/services/battle-ruleset-resolver.js";
import { InfrastructureFailure } from "./errors.js";
import type { AgentsKind, BattleContext, BattleExecution, BattleExecutor } from "./battle-runner.js";

export type AgentResolver = (botId: string, version: number, vehicleId: string) => BotAgent;

/** Un vehículo de la batalla y el bot (versión exacta) que lo conduce. */
export interface VehicleAssignment {
  vehicleId: string;
  botId: string;
  version: number;
  team: string;
}

export interface AgentDriverInput {
  battleId: string;
  /** Motor ya creado (mapa, ruleset y vehículos reales), con recordReplay. */
  engine: Battle;
  vehicles: VehicleAssignment[];
  ruleset: Ruleset;
  catalogVersion: string;
  signal?: AbortSignal;
}

export interface AgentDriverOutput {
  result: BattleResult;
  replay: Replay;
  /** CPU real por botId (contenedores); ausente si el driver no mide. */
  cpuMsByBot?: Record<string, number | null>;
}

/** Engancha agentes a los vehículos y hace avanzar la batalla hasta su final. */
export interface AgentDriver {
  readonly kind: AgentsKind;
  run(input: AgentDriverInput): Promise<AgentDriverOutput>;
}

/**
 * H2 (issue #6) · Lo que el ejecutor necesita del gateway de espectador de E8
 * (T8.2). Es un Pick del SpectateGateway REAL.
 */
export type SpectateSink = Pick<SpectateGateway, "attachBattle" | "detachBattle">;

/** Techo de ticks del bucle en proceso (mismo valor por defecto que Battle.run()). */
const MAX_TICKS = 100000;
/** Cada cuántos ticks se cede el bucle de eventos para que el gateway bombee. */
const YIELD_EVERY_N_TICKS = 25;

/**
 * Driver EN PROCESO: los agentes son objetos `BotAgent` del propio proceso. Sólo
 * para tests/demo (no ejecuta el código de ningún usuario). Avanza la batalla tan
 * rápido como puede, cediendo el bucle de eventos cada 25 ticks.
 */
export function inProcessAgents(resolver: AgentResolver): AgentDriver {
  return {
    kind: "in_process_stub",
    async run({ engine, vehicles, signal }) {
      for (const v of vehicles) engine.attachBot(v.vehicleId, resolver(v.botId, v.version, v.vehicleId));
      while (!engine.isFinished() && engine.tick < MAX_TICKS) {
        if (signal?.aborted) throw new Error(`batalla abortada: ${String(signal.reason)}`);
        engine.step();
        if (engine.tick % YIELD_EVERY_N_TICKS === 0) await new Promise((r) => setImmediate(r));
      }
      // Cierre por el MOTOR: si agotó los ticks, run() con el techo ya alcanzado
      // declara el empate; si terminó, devuelve el resultado ya calculado.
      const result = engine.run(MAX_TICKS);
      return { result, replay: replayFromBattle(engine, result) };
    },
  };
}

export interface EngineExecutorOptions {
  db: Knex;
  /** OBLIGATORIO (o `agentResolver`): quién conduce los vehículos. */
  agents?: AgentDriver;
  /**
   * Atajo para tests: resolver EN PROCESO explícito (equivale a
   * `agents: inProcessAgents(agentResolver)`). Nunca hay uno por defecto.
   */
  agentResolver?: AgentResolver;
  /** Overrides del ruleset del motor (p. ej. timeLimitTicks corto en tests). */
  rulesetOverrides?: Partial<Ruleset>;
  /**
   * H2 (issue #6) · Gateway de espectador de E8: si se pasa, cada batalla se
   * registra EN VIVO con attachBattle() al arrancar y se retira tras el resultado.
   */
  spectate?: SpectateSink;
  /** ms entre el final de la batalla y el detach (deja al pump del gateway entregar el resultado). */
  spectateDetachDelayMs?: number;
}

export function makeEngineExecutor(opts: EngineExecutorOptions): BattleExecutor {
  if (opts.agents && opts.agentResolver) {
    throw new Error("makeEngineExecutor: `agents` y `agentResolver` son excluyentes (no se adivina cuál usar)");
  }
  const driver = opts.agents ?? (opts.agentResolver ? inProcessAgents(opts.agentResolver) : undefined);
  if (!driver) {
    throw new Error(
      "makeEngineExecutor: falta el driver de agentes (opts.agents). No hay agente por defecto: " +
        "en producción es containerAgents() (código real de cada bot); en tests, un resolver explícito.",
    );
  }

  return async (ctx: BattleContext): Promise<BattleExecution> => {
    const db = opts.db;
    const { battle, participants } = ctx;

    // --- mapa (E4 real): contenido versionado en BD → ArenaMap del motor ----
    const mapRow = await db("map_versions").where({ map_id: battle.map_id, version: battle.map_version }).first();
    if (!mapRow?.content)
      throw new InfrastructureFailure("map_unavailable", `mapa ${battle.map_id}@${battle.map_version} sin contenido`);
    let arenaMap;
    try {
      const doc = (typeof mapRow.content === "string" ? JSON.parse(mapRow.content) : mapRow.content) as InternalMap;
      arenaMap = toEngineMap(doc);
    } catch (err) {
      throw new InfrastructureFailure("map_unavailable", `mapa ${battle.map_id} no convertible: ${String(err)}`);
    }

    // --- ruleset del motor (resolución única, B9) + presupuesto de BD --------
    const resolved = await resolveBattleRuleset(db, battle.mode, battle.ruleset_id);
    if (!resolved.ok) {
      throw new InfrastructureFailure("engine_start_failure", `${resolved.code}: ${resolved.message}`);
    }
    const dbRuleset = battle.ruleset_id ? await db("rulesets").where({ id: battle.ruleset_id }).first() : null;
    const tournament = battle.tournament_id
      ? await db("tournaments").where({ id: battle.tournament_id }).first()
      : null;
    const budgetCredits = (tournament?.budget_credits ?? dbRuleset?.budget_credits) as number | undefined;
    const ruleset = loadRuleset(resolved.ruleset.rulesetId, {
      ...(budgetCredits ? { budgetCredits } : {}),
      ...(opts.rulesetOverrides ?? {}),
    });

    // --- catálogo CONGELADO del torneo (T9.4) --------------------------------
    const catalogVersion = (tournament?.catalog_version ?? null) as string | null;
    let catalog: ModuleDefinition[];
    let effectiveCatalogVersion: string;
    if (catalogVersion) {
      catalog = await getCatalog(db, catalogVersion);
      effectiveCatalogVersion = catalogVersion;
      if (catalog.length === 0) {
        throw new InfrastructureFailure(
          "artifact_unavailable",
          `catálogo congelado '${catalogVersion}' vacío o no importado`,
        );
      }
    } else {
      // Batalla de práctica sin torneo: última versión importada.
      const latest = await db("catalog_versions").orderBy("imported_at", "desc").first();
      if (!latest) throw new InfrastructureFailure("artifact_unavailable", "sin catálogo importado");
      effectiveCatalogVersion = latest.catalog_version as string;
      catalog = await getCatalog(db, effectiveCatalogVersion);
    }

    // --- participantes: loadout CONGELADO (entrada del torneo, cap. 17.2) ----
    const engineParticipants: Participant[] = [];
    const vehicles: VehicleAssignment[] = [];
    /**
     * R3.4 (ERR-VIS-05) · Nómina PÚBLICA para el visor: id de vehículo → bot
     * (nombre, chasis, equipo). Viaja en la CABECERA `init.meta`.
     */
    const roster: { id: string; botId: string; team: string; chassis: string; name?: string }[] = [];
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
        throw new InfrastructureFailure(
          "artifact_unavailable",
          `bot ${p.bot_id}: loadout rev ${loadoutRevision} inexistente`,
        );
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
      roster.push({ id: vehicleId, botId: p.bot_id, team: p.team, chassis: loadout.chassis });
      vehicles.push({ vehicleId, botId: p.bot_id, version: p.version, team: p.team });
    }

    // Nombres de bot para la nómina (best-effort: no es camino crítico).
    try {
      const botRows = await db("bots")
        .whereIn(
          "id",
          roster.map((r) => r.botId),
        )
        .select("id", "name");
      const names = new Map<string, string>(botRows.map((b: any) => [b.id, b.name]));
      for (const r of roster) r.name = names.get(r.botId);
    } catch {
      /* la nómina es un adorno del visor: nunca tumba la batalla */
    }

    // --- batalla real del motor (con replay T2.6) ----------------------------
    let engine: Battle;
    try {
      engine = await Battle.create({
        battleId: battle.id,
        seed: battle.seed ?? battle.id,
        ruleset,
        map: arenaMap,
        participants: engineParticipants,
        recordReplay: true,
      });
    } catch (err) {
      // El motor no arrancó (p. ej. composición incompatible con el modo).
      throw new InfrastructureFailure("engine_start_failure", err instanceof Error ? err.message : String(err));
    }

    try {
      if (opts.spectate) {
        let round: number | null = null;
        if (battle.match_id) {
          const match = await db("matches").where({ id: battle.match_id }).first();
          round = (match?.round as number) ?? null;
        }
        // E8.M anti-coaching: retardo del ruleset, salvo batalla 'visible'.
        const spectator =
          battle.spectator_mode === "visible" ? { ...(ruleset.spectator ?? {}), delaySeconds: 0 } : ruleset.spectator;
        opts.spectate.attachBattle(battle.id, engine, {
          spectator,
          meta: {
            mode: battle.mode,
            mapId: battle.map_id,
            mapVersion: battle.map_version,
            tournamentId: battle.tournament_id,
            matchId: battle.match_id,
            round,
            official: battle.official,
            roster,
          },
        });
      }

      let out: AgentDriverOutput;
      try {
        out = await driver.run({
          battleId: battle.id,
          engine,
          vehicles,
          ruleset,
          catalogVersion: effectiveCatalogVersion,
          signal: ctx.signal,
        });
      } finally {
        if (opts.spectate) {
          const sink = opts.spectate;
          const t = setTimeout(() => sink.detachBattle(battle.id), opts.spectateDetachDelayMs ?? 3000);
          t.unref?.();
        }
      }
      const { result, replay } = out;

      // El motor descalifica VEHÍCULOS (`veh_N`); el runner y `participants`
      // hablan de BOTS. Antes se pasaba la lista de vehículos tal cual como si
      // fueran botIds, así que un bot descalificado por el motor (timeouts)
      // nunca quedaba `disqualified` en participants.outcome.
      const botOfVehicle = new Map(vehicles.map((v) => [v.vehicleId, v.botId]));
      const disqualifiedBots = result.disqualified.map((vid) => botOfVehicle.get(vid) ?? vid);

      return {
        winner: result.winner,
        ticks: result.ticks,
        score: result.score,
        finalStateHash: result.finalStateHash,
        disqualified: disqualifiedBots,
        versions: {
          ...result.versions,
          catalog: catalogVersion ?? "latest",
          mapChecksum: (mapRow.checksum as string) ?? "",
          rulesetDb: battle.ruleset_id ?? "",
          rulesetEngine: ruleset.rulesetId,
        },
        replayJsonl: toJsonl(replay),
        ...(out.cpuMsByBot ? { cpuMsByBot: out.cpuMsByBot } : {}),
        agents: driver.kind,
      };
    } catch (err) {
      if (err instanceof InfrastructureFailure) throw err;
      if (err && typeof err === "object" && (err as Error).name === "SportingFailure") throw err;
      // El motor o los agentes murieron: fallo técnico (19.2), reintentable.
      throw new InfrastructureFailure("engine_start_failure", err instanceof Error ? err.message : String(err));
    } finally {
      try {
        engine.free();
      } catch {
        /* ya liberado */
      }
    }
  };
}

/**
 * Todos los handlers del worker, cableados con las piezas reales. El driver de
 * agentes es OBLIGATORIO (ver makeEngineExecutor).
 */
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
