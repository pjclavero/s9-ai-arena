/**
 * T8.4 · Pipeline de estadísticas (cap. 20.3).
 *
 * Se calcula A PARTIR DEL ARCHIVO DE REPLAY, no de una BD de eventos (política
 * 23.1). Los eventos privados (daño, fallos, timeouts) no viajan en el replay
 * (D8): se REGENERAN re-simulando con los comandos grabados vía
 * `resimulateWithEvents` del motor de E2 — determinismo mediante, son idénticos
 * a los de la batalla original.
 *
 * El job es idempotente por battle_id: reescribe (delete+insert transaccional)
 * las filas de `battle_stats`, nunca acumula.
 *
 * Honestidad sobre dos métricas del dosier:
 *  - "CPU reportada por el motor": el motor NO mide CPU por bot (eso lo hará el
 *    runner containerizado de E6/E9); se persiste `cpuMs: null` como hueco
 *    explícito del esquema. Los "turnos omitidos" sí: eventos decision_timeout.
 *  - Daño por módulo: hit_dealt no dice qué arma disparó; se atribuye a los
 *    slots de arma proporcionalmente a sus disparos aceptados (exacto con un
 *    arma, aproximado con varias; anotado en la entrega para E2).
 */
import type { Db } from "../../api/src/db/connection.js";
import { resimulateWithEvents, type Replay } from "../../arena-engine/src/replay.js";
import { loadStored } from "./store.js";

export interface ModuleStats {
  moduleId: string | null;
  /** Acciones aceptadas por el motor (disparos, minas…). */
  uses: number;
  /** Daño atribuido (proporcional a los usos entre slots de arma). */
  damageDealt: number;
  /** Acciones rechazadas (energía, cooldown, arco, munición). */
  rejections: number;
  /** Daño por uso; null si no se usó. */
  efficiency: number | null;
  /** Estado del módulo al final de la batalla (supervivencia del módulo). */
  finalState: string;
}

export interface BotBattleStats {
  botId: string;
  team: string;
  damageDealt: number;
  damageTaken: number;
  shotsFired: number;
  shotsHit: number;
  /** shotsHit / shotsFired, null si no disparó. */
  accuracy: number | null;
  kills: number;
  died: boolean;
  survivedTicks: number;
  flagCaptures: number;
  flagsTaken: number;
  minesDeployed: number;
  minesTriggered: number;
  /** Turnos omitidos reportados por el motor (decision_timeout). */
  decisionTimeouts: number;
  disqualified: boolean;
  /** El motor no mide CPU por bot; hueco explícito hasta el runner de E6/E9. */
  cpuMs: number | null;
  perModule: Record<string, ModuleStats>;
}

export interface TeamBattleStats {
  team: string;
  score: number;
  damageDealt: number;
  kills: number;
  flagCaptures: number;
  survivors: number;
}

export interface BattleStatsResult {
  battleId: string;
  mode: string;
  mapId: string;
  mapVersion: number;
  durationTicks: number;
  winner: string;
  draw: boolean;
  /** Lado del mapa (spawn) del equipo ganador: para la "ventaja por lado" del 20.3. */
  winnerSide: "left" | "right" | null;
  perBot: Record<string, BotBattleStats>; // clave: vehicleId
  perTeam: Record<string, TeamBattleStats>;
}

/** Calcula todas las métricas de una batalla desde su Replay (re-simulando). */
export async function computeBattleStats(replay: Replay): Promise<BattleStatsResult> {
  const header = replay.header;
  const byVehicle = new Map<string, BotBattleStats>();
  const moduleIdBySlot = new Map<string, Map<string, string>>(); // vehicleId → slot → moduleId
  const weaponSlots = new Map<string, Set<string>>();

  for (const p of header.participants) {
    const mods = new Map<string, string>();
    const weapons = new Set<string>();
    const perModule: Record<string, ModuleStats> = {};
    for (const m of p.spec?.modules ?? []) {
      mods.set(m.slot, m.moduleId);
      if (m.category === "weapon" || m.category === "mine") weapons.add(m.slot);
      perModule[m.slot] = {
        moduleId: m.moduleId,
        uses: 0,
        damageDealt: 0,
        rejections: 0,
        efficiency: null,
        finalState: "operational",
      };
    }
    moduleIdBySlot.set(p.id, mods);
    weaponSlots.set(p.id, weapons);
    byVehicle.set(p.id, {
      botId: p.botId,
      team: p.team,
      damageDealt: 0,
      damageTaken: 0,
      shotsFired: 0,
      shotsHit: 0,
      accuracy: null,
      kills: 0,
      died: false,
      survivedTicks: 0,
      flagCaptures: 0,
      flagsTaken: 0,
      minesDeployed: 0,
      minesTriggered: 0,
      decisionTimeouts: 0,
      disqualified: false,
      cpuMs: null,
      perModule,
    });
  }

  // ---- 1 · Comandos grabados: intentos de acción por slot.
  const fireAttempts = new Map<string, Map<string, number>>(); // vehicleId → slot → intentos
  for (const c of replay.commands) {
    const v = fireAttempts.get(c.vehicleId) ?? new Map<string, number>();
    for (const slot of c.command?.fire ?? []) v.set(slot, (v.get(slot) ?? 0) + 1);
    if (c.command?.deployMine?.slot) v.set(c.command.deployMine.slot, (v.get(c.command.deployMine.slot) ?? 0) + 1);
    fireAttempts.set(c.vehicleId, v);
  }

  // ---- 2 · Re-simulación: eventos privados por vehículo (daño, fallos, timeouts).
  const lastDamager = new Map<string, string>(); // targetId → attackerId
  const carrierOfFlag = new Map<string, string>(); // flagTeam → vehicleId
  const mineOwnerByPos = new Map<string, string>(); // "x,y" → vehicleId (las minas no se mueven)
  await resimulateWithEvents(replay, (vehicleId, e) => {
    const s = byVehicle.get(vehicleId);
    if (!s) return;
    switch (e.kind) {
      case "hit_dealt":
        s.damageDealt += e.damage;
        s.shotsHit += 1;
        lastDamager.set(e.targetId, vehicleId);
        break;
      case "hit_taken":
        s.damageTaken += e.damage;
        break;
      case "decision_timeout":
        s.decisionTimeouts += 1;
        break;
      case "rejected_action":
        if (e.reason === "timeout_disqualified") s.disqualified = true;
        else if (e.slot && s.perModule[e.slot]) s.perModule[e.slot].rejections += 1;
        break;
      case "mine_deployed":
        s.minesDeployed += 1;
        if (e.position) mineOwnerByPos.set(`${e.position.x},${e.position.y}`, vehicleId);
        break;
      case "flag_taken":
        // Evento público (lo reciben todos): solo cuenta para el portador real.
        if (e.sourceId === vehicleId) {
          s.flagsTaken += 1;
          carrierOfFlag.set(e.team, vehicleId);
        }
        break;
      case "flag_captured": {
        // e.team = equipo que captura; el crédito es del portador rastreado.
        for (const [flagTeam, carrier] of carrierOfFlag) {
          if (carrier === vehicleId && byVehicle.get(carrier)?.team === e.team) {
            s.flagCaptures += 1;
            carrierOfFlag.delete(flagTeam);
            break;
          }
        }
        break;
      }
      default:
        break;
    }
  });

  // La descalificación oficial la dice el RESULTADO (fuente de verdad), no un evento.
  for (const vehicleId of replay.result.disqualified ?? []) {
    const s = byVehicle.get(vehicleId);
    if (s) s.disqualified = true;
  }

  // ---- 3 · Eventos públicos del replay: muertes y minas detonadas (con atribución).
  const deathTick = new Map<string, number>();
  for (const e of replay.events) {
    if (e.kind === "vehicle_destroyed" && byVehicle.has(e.targetId) && !deathTick.has(e.targetId)) {
      deathTick.set(e.targetId, e.tick);
      const killer = lastDamager.get(e.targetId);
      if (killer && killer !== e.targetId) {
        const ks = byVehicle.get(killer);
        if (ks) ks.kills += 1;
      }
    }
    if (e.kind === "mine_triggered" && e.position) {
      // El dueño no viaja en el evento público; se resuelve por la posición de
      // despliegue (las minas no se mueven).
      const owner = mineOwnerByPos.get(`${e.position.x},${e.position.y}`);
      const os = owner ? byVehicle.get(owner) : undefined;
      if (os) os.minesTriggered += 1;
    }
  }

  // ---- 4 · Cierre por bot: supervivencia, precisión, uso de módulos.
  const duration = replay.result.ticks;
  const lastSnapshot = replay.snapshots.at(-1);
  for (const [vehicleId, s] of byVehicle) {
    s.died = deathTick.has(vehicleId);
    s.survivedTicks = s.died ? deathTick.get(vehicleId)! : duration;
    const attempts = fireAttempts.get(vehicleId) ?? new Map();
    const weapons = weaponSlots.get(vehicleId) ?? new Set();
    let totalAcceptedShots = 0;
    for (const [slot, n] of attempts) {
      const pm = s.perModule[slot];
      if (!pm) continue;
      const accepted = Math.max(0, n - pm.rejections);
      pm.uses = accepted;
      if (weapons.has(slot) && slot !== "mine_bay") totalAcceptedShots += accepted;
    }
    // Disparos = intentos aceptados de slots de arma (las minas cuentan aparte).
    s.shotsFired = totalAcceptedShots;
    s.accuracy = s.shotsFired > 0 ? s.shotsHit / s.shotsFired : null;
    // Daño por módulo: proporcional a los usos de cada arma (exacto con 1 arma).
    const totalUses = [...weapons].reduce((acc, slot) => acc + (s.perModule[slot]?.uses ?? 0), 0);
    for (const slot of weapons) {
      const pm = s.perModule[slot];
      if (!pm || totalUses === 0) continue;
      pm.damageDealt = (s.damageDealt * pm.uses) / totalUses;
      pm.efficiency = pm.uses > 0 ? pm.damageDealt / pm.uses : null;
    }
    // Estado final de cada módulo: del último snapshot público.
    const snapVehicle = lastSnapshot?.vehicles?.find((v: any) => v.id === vehicleId);
    for (const m of snapVehicle?.modules ?? []) {
      if (s.perModule[m.slot]) s.perModule[m.slot].finalState = m.state;
    }
  }

  // ---- 5 · Por equipo y por mapa.
  const perTeam: Record<string, TeamBattleStats> = {};
  for (const s of byVehicle.values()) {
    const t = (perTeam[s.team] ??= {
      team: s.team,
      score: replay.result.score[s.team] ?? 0,
      damageDealt: 0,
      kills: 0,
      flagCaptures: 0,
      survivors: 0,
    });
    t.damageDealt += s.damageDealt;
    t.kills += s.kills;
    t.flagCaptures += s.flagCaptures;
    if (!s.died) t.survivors += 1;
  }

  const winner = replay.result.winner;
  let winnerSide: "left" | "right" | null = null;
  if (winner !== "draw") {
    const spawn = header.map.spawns?.find((sp: any) => sp.team === winner);
    if (spawn) winnerSide = spawn.position.x <= header.map.widthM / 2 ? "left" : "right";
  }

  return {
    battleId: header.battleId,
    mode: header.ruleset.mode,
    mapId: header.map.mapId,
    mapVersion: header.map.version,
    durationTicks: duration,
    winner,
    draw: winner === "draw",
    winnerSide,
    perBot: Object.fromEntries(byVehicle),
    perTeam,
  };
}

// -------------------------------------------------------------------- el job

export interface StatsJobResult {
  battleId: string;
  rowsWritten: number;
  stats: BattleStatsResult;
}

/**
 * Job de fin de batalla: lee el replay del almacén, calcula y escribe
 * `battle_stats` (una fila por bot participante, jsonb). IDEMPOTENTE por
 * battle_id: reprocesar sobrescribe, jamás duplica ni acumula.
 *
 * `dbBattleId` es el uuid de la fila `battles`; los participantes del replay
 * llevan el botId de la plataforma (uuid de `bots`) en producción.
 */
export async function runStatsJob(
  db: Db,
  dir: string,
  dbBattleId: string,
  replayBattleId?: string,
): Promise<StatsJobResult> {
  const loaded = loadStored(dir, replayBattleId ?? dbBattleId);
  if (!loaded.valid || !loaded.replay) {
    throw new Error(`No se puede procesar ${dbBattleId}: ${loaded.reason}`);
  }
  const stats = await computeBattleStats(loaded.replay);

  const rows = Object.entries(stats.perBot).map(([vehicleId, s]) => ({
    battle_id: dbBattleId,
    bot_id: s.botId,
    stats: JSON.stringify({
      vehicleId,
      ...s,
      battle: {
        mode: stats.mode,
        mapId: stats.mapId,
        mapVersion: stats.mapVersion,
        durationTicks: stats.durationTicks,
        winner: stats.winner,
        draw: stats.draw,
        winnerSide: stats.winnerSide,
        team: stats.perTeam[s.team],
      },
    }),
  }));

  await db.transaction(async (trx) => {
    await trx("battle_stats").where({ battle_id: dbBattleId }).delete();
    if (rows.length > 0) await trx("battle_stats").insert(rows);
  });

  return { battleId: dbBattleId, rowsWritten: rows.length, stats };
}

// ------------------------------------------------------------- agregados

export interface BotVersionAggregate {
  botId: string;
  version: number;
  battles: number;
  wins: number;
  draws: number;
  damageDealt: number;
  accuracy: number | null;
  survivalRate: number;
}

/** Agregados por bot-versión (clasificaciones de E9), desde battle_stats + participants. */
export async function aggregateByBotVersion(db: Db): Promise<BotVersionAggregate[]> {
  const rows = await db("battle_stats as bs")
    .join("participants as p", function joinOn() {
      this.on("p.battle_id", "bs.battle_id").andOn("p.bot_id", "bs.bot_id");
    })
    .select("bs.bot_id", "p.version", "p.outcome", "bs.stats");

  const acc = new Map<string, BotVersionAggregate & { shots: number; hits: number; survived: number }>();
  for (const r of rows) {
    const key = `${r.bot_id}:${r.version}`;
    const a = acc.get(key) ?? {
      botId: r.bot_id,
      version: r.version,
      battles: 0,
      wins: 0,
      draws: 0,
      damageDealt: 0,
      accuracy: null,
      survivalRate: 0,
      shots: 0,
      hits: 0,
      survived: 0,
    };
    const s = typeof r.stats === "string" ? JSON.parse(r.stats) : r.stats;
    a.battles += 1;
    if (r.outcome === "win") a.wins += 1;
    if (r.outcome === "draw") a.draws += 1;
    a.damageDealt += s.damageDealt ?? 0;
    a.shots += s.shotsFired ?? 0;
    a.hits += s.shotsHit ?? 0;
    if (!s.died) a.survived += 1;
    acc.set(key, a);
  }
  return [...acc.values()].map(({ shots, hits, survived, ...a }) => ({
    ...a,
    accuracy: shots > 0 ? hits / shots : null,
    survivalRate: a.battles > 0 ? survived / a.battles : 0,
  }));
}

export interface ModuleAggregate {
  moduleId: string;
  battles: number;
  uses: number;
  damageDealt: number;
  rejections: number;
  /** Daño medio por uso; null si nunca se usó. */
  efficiency: number | null;
  /** Fracción de batallas en las que el módulo acabó operativo. */
  survivalRate: number;
}

/**
 * Agregados por módulo del CATÁLOGO (el insumo del informe de balance de E3 y
 * del balance del cap. 20.3): suma sobre una lista de resultados de batalla.
 */
export function aggregateByModule(statsList: BattleStatsResult[]): ModuleAggregate[] {
  const acc = new Map<string, ModuleAggregate & { operational: number }>();
  for (const battle of statsList) {
    for (const bot of Object.values(battle.perBot)) {
      for (const pm of Object.values(bot.perModule)) {
        if (!pm.moduleId) continue;
        const a = acc.get(pm.moduleId) ?? {
          moduleId: pm.moduleId,
          battles: 0,
          uses: 0,
          damageDealt: 0,
          rejections: 0,
          efficiency: null,
          survivalRate: 0,
          operational: 0,
        };
        a.battles += 1;
        a.uses += pm.uses;
        a.damageDealt += pm.damageDealt;
        a.rejections += pm.rejections;
        if (pm.finalState === "operational") a.operational += 1;
        acc.set(pm.moduleId, a);
      }
    }
  }
  return [...acc.values()].map(({ operational, ...a }) => ({
    ...a,
    efficiency: a.uses > 0 ? a.damageDealt / a.uses : null,
    survivalRate: a.battles > 0 ? operational / a.battles : 0,
  }));
}
