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
 *  - "CPU reportada por el motor": el motor NO mide CPU por bot, y NO se puede
 *    deducir del replay (el replay es determinista y no lleva tiempos; deducir
 *    CPU de él sería inventarla). B10 (issue #9): la mide el runner
 *    containerizado leyendo el cgroup del contenedor de cada bot
 *    (`cpuMsFromDockerStats`, bot-manager) y llega hasta aquí por un canal
 *    APARTE del replay: `participants.cpu_ms` en BD, o el parámetro
 *    `cpuMsByBot` de `computeBattleStats`. Sin medida ⇒ `cpuMs: null`; nunca un
 *    número estimado. Los "turnos omitidos" sí salen del replay: eventos
 *    decision_timeout.
 *  - Daño por módulo: hit_dealt no dice qué arma disparó; se atribuye a los
 *    slots de arma proporcionalmente a sus disparos aceptados (exacto con un
 *    arma, aproximado con varias; anotado en la entrega para E2).
 */
import { safeLookup } from "../../../packages/game-rules/safe-lookup.js";
import type { Db } from "../../api/src/db/connection.js";
import { resimulateWithEvents, type Replay } from "../../arena-engine/src/replay.js";
import { loadStored } from "./store.js";
import { emptyDict } from "../../../packages/game-rules/safe-lookup.js";
import { addBotToTeam, emptyTeamStats, type TeamBattleStats } from "./team-stats.js";

export { addBotToTeam, emptyTeamStats, type TeamBattleStats } from "./team-stats.js";

/**
 * UX-D · QUÉ cuenta `uses` en cada módulo. Antes sólo se contaban armas y minas
 * y el resto salía con `uses: 0` (p. ej. `drive.uses = 0` en un bot que se movió
 * toda la batalla): ahora cada módulo dice qué mide, y los pasivos lo declaran.
 *  - `shots`: disparos aceptados (armas).
 *  - `mines`: minas desplegadas aceptadas.
 *  - `move_commands`: decisiones con orden de movimiento distinta de parar
 *    (movimiento). La distancia recorrida va en `BotBattleStats.distanceM`.
 *  - `radio_messages`: MENSAJES de radio aceptados por el motor y emitidos por
 *    ese slot (4v4-STATS: antes contaba DECISIONES con radio, no mensajes, y
 *    contaba también los descartados y los enviados estando muerto). Es lo mismo
 *    que `BotBattleStats.radio.sent`, desglosado por slot.
 *  - `passive`: el módulo actúa solo (blindaje, energía, sensores, munición):
 *    `uses` es 0 por definición, no porque no se usara.
 */
export type ModuleUsesKind = "shots" | "mines" | "move_commands" | "radio_messages" | "passive";

export interface ModuleStats {
  moduleId: string | null;
  /** Qué cuenta `uses` (ver ModuleUsesKind). */
  usesKind: ModuleUsesKind;
  /** Acciones aceptadas del tipo `usesKind` (disparos, minas, órdenes de movimiento…). */
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
  /**
   * Bajas de ENEMIGOS causadas por este bot: el golpe que destruye al rival es
   * suyo (atribución exacta por orden de emisión del motor, no «último que le
   * dio» en toda la batalla). Con respawn (TDM) cuenta TODAS, no sólo la primera.
   */
  kills: number;
  /** 4v4-STATS · Bajas de compañeros (o propias) con fuego amigo activo. */
  teamKills: number;
  /** 4v4-STATS · Veces que este bot fue destruido (con respawn puede ser > 1). */
  deaths: number;
  /** 4v4-STATS · Veces que reapareció. */
  respawns: number;
  /** `deaths > 0`: fue destruido AL MENOS una vez (con respawn puede acabar vivo). */
  died: boolean;
  /** 4v4-STATS · Vivo y no descalificado al terminar la batalla. */
  aliveAtEnd: boolean;
  /**
   * Ticks que estuvo VIVO en total (suma de tramos entre (re)aparición y muerte).
   * Sin respawn coincide con el tick de su muerte, como antes. Un descalificado
   * deja de sumar al descalificarse.
   */
  survivedTicks: number;
  flagCaptures: number;
  flagsTaken: number;
  minesDeployed: number;
  minesTriggered: number;
  /** Turnos omitidos reportados por el motor (decision_timeout). */
  decisionTimeouts: number;
  /** UX-06 · Decisiones con COMMAND aplicado por el motor (las grabadas en el replay). */
  decisions: number;
  /**
   * UX-06 · Acciones rechazadas por el motor, por motivo (`cooldown`, `no_ammo`,
   * `no_energy`, `out_of_arc`, `module_destroyed`…). No incluye la descalificación
   * por timeouts (eso es `disqualified`).
   */
  rejectionsByReason: Record<string, number>;
  /** UX-D · Distancia recorrida en metros (suma entre snapshots públicos). */
  distanceM: number;
  disqualified: boolean;
  /**
   * B10 (issue #9) · CPU consumida por el CONTENEDOR del bot durante la batalla,
   * en ms (cgroup del contenedor: usuario + sistema, todo el ciclo de vida del
   * proceso, no solo el `decide()`). `null` = no medida — batalla sin
   * contenedores (stubs en proceso) o medición no disponible. NUNCA estimada.
   */
  cpuMs: number | null;
  /** 4v4-STATS · Actividad de radio (juego, pública: ver `RadioActivity`). */
  radio: RadioActivity;
  /**
   * 4v4-STATS · Mensajes de radio que el motor DESCARTÓ, por motivo
   * (`rate_limited`, `too_large`, `no_radio`, `queue_full`). Mide cuánto falla el
   * código del bot: es DIAGNÓSTICO del dueño (TD-047/R12); la API no lo da a rivales.
   */
  radioDroppedByReason: Record<string, number>;
  perModule: Record<string, ModuleStats>;
  /**
   * R-RULES (ADR-021) · Sólo con respawn LIMITADO (`ruleset.respawn.maxRespawns`):
   * vidas totales (1 + reapariciones permitidas), reapariciones que le quedaban al
   * acabar y si quedó ELIMINADO (sin vidas). Ausentes en el resto de batallas: no se
   * inventan métricas que no tienen sentido para el modo (FASE 13).
   */
  lives?: number;
  respawnsRemaining?: number;
  eliminated?: boolean;
}

/**
 * 4v4-STATS (Fase 6) · Radio observada SIN cambiar el contrato: la radio se
 * sigue entregando también al rival (`sensors.ts`, fijado por
 * `radio-regression.test.ts`); esto sólo lo MIDE.
 *  - `sent`: mensajes aceptados por el motor (los de `command.radio` aplicados
 *    estando vivo, menos los `radio_dropped` del emisor). Bajo latencia simulada
 *    el tick de aplicación no está en el replay y se usa el de decisión.
 *  - `received`: suma de `obs.radio.length` de todas sus observaciones.
 *  - `receivedFromTeammates` / `receivedFromEnemies`: el mismo total partido por
 *    el bando del emisor. `receivedFromEnemies > 0` es la prueba de que el rival
 *    oye la radio ajena según el contrato actual.
 * Son contadores de actividad de juego, no de fallo del código: públicos en `perBot`.
 */
export interface RadioActivity {
  sent: number;
  received: number;
  receivedFromTeammates: number;
  receivedFromEnemies: number;
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

/**
 * B10 (issue #9) · Medidas que NO están en el replay y llegan por un canal
 * aparte (hoy: el runner containerizado). Todo lo que no venga aquí queda en
 * `null`, nunca estimado.
 */
export interface BattleStatsInputs {
  /**
   * CPU por bot en ms, indexada por botId (el de la plataforma, el mismo que
   * `participants.botId` del replay). Origen: `ContainerBattleOutcome.cpuMsByBot`
   * o `participants.cpu_ms` en BD. Se lee con `safeLookup` y se valida: solo un
   * número finito ≥ 0 se acepta; cualquier otra cosa (string, negativo, NaN,
   * clave heredada del prototipo) se trata como no medida.
   */
  cpuMsByBot?: Record<string, unknown>;
}

function usesKindOf(category: string | undefined): ModuleUsesKind {
  if (category === "weapon") return "shots";
  if (category === "mine") return "mines";
  if (category === "movement") return "move_commands";
  if (category === "radio") return "radio_messages";
  return "passive";
}

/** Normaliza una medida de CPU externa: número finito ≥ 0, o `null`. */
function sanitizeCpuMs(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/** Calcula todas las métricas de una batalla desde su Replay (re-simulando). */
export async function computeBattleStats(replay: Replay, inputs: BattleStatsInputs = {}): Promise<BattleStatsResult> {
  const header = replay.header;
  const byVehicle = new Map<string, BotBattleStats>();
  const moduleIdBySlot = new Map<string, Map<string, string>>(); // vehicleId → slot → moduleId
  const weaponSlots = new Map<string, Set<string>>();

  for (const p of header.participants) {
    const mods = new Map<string, string>();
    const weapons = new Set<string>();
    // B8 · `emptyDict()`, NO `{}`: `m.slot` viene del CONTENIDO DEL REPLAY
    // (dato externo; hasta B8 cualquiera podía ingestar uno).
    const perModule: Record<string, ModuleStats> = emptyDict<ModuleStats>();
    for (const m of p.spec?.modules ?? []) {
      mods.set(m.slot, m.moduleId);
      if (m.category === "weapon" || m.category === "mine") weapons.add(m.slot);
      perModule[m.slot] = {
        moduleId: m.moduleId,
        usesKind: usesKindOf(m.category),
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
      teamKills: 0,
      deaths: 0,
      respawns: 0,
      died: false,
      aliveAtEnd: true,
      survivedTicks: 0,
      flagCaptures: 0,
      flagsTaken: 0,
      minesDeployed: 0,
      minesTriggered: 0,
      decisionTimeouts: 0,
      decisions: 0,
      rejectionsByReason: emptyDict<number>(),
      distanceM: 0,
      disqualified: false,
      // B10 · botId viene del replay (dato externo): safeLookup, no p.botId
      // indexado a pelo — con botId "__proto__" un `dict[key]` devolvería algo
      // truthy que no es una medida.
      cpuMs: inputs.cpuMsByBot ? sanitizeCpuMs(safeLookup(inputs.cpuMsByBot, p.botId)) : null,
      radio: { sent: 0, received: 0, receivedFromTeammates: 0, receivedFromEnemies: 0 },
      radioDroppedByReason: emptyDict<number>(),
      perModule,
    });
  }

  // ---- 1 · Re-simulación: eventos privados por vehículo (daño, fallos,
  // timeouts) + orden global de emisión (bajas, muertes, respawns) + lo que cada
  // bot OYÓ por radio (sus observaciones).
  const carrierOfFlag = new Map<string, string>(); // flagTeam → vehicleId
  const mineOwnerByPos = new Map<string, string>(); // "x,y" → vehicleId (las minas no se mueven)
  // Transiciones de vida por vehículo, en orden de tick: muerte, respawn, DQ.
  const lifeline = new Map<string, { tick: number; alive: boolean }[]>();
  const pushLife = (id: string, tick: number, alive: boolean) => {
    const l = lifeline.get(id) ?? [];
    l.push({ tick, alive });
    lifeline.set(id, l);
  };
  const radioDroppedBySlot = new Map<string, Map<string, number>>(); // vehicleId → slot → descartes

  const onEvent = (vehicleId: string, e: any) => {
    const s = byVehicle.get(vehicleId);
    if (!s) return;
    switch (e.kind) {
      case "hit_dealt":
        s.damageDealt += e.damage;
        s.shotsHit += 1;
        break;
      case "radio_dropped": {
        const reason = typeof e.reason === "string" && e.reason ? e.reason : "unknown";
        s.radioDroppedByReason[reason] = (s.radioDroppedByReason[reason] ?? 0) + 1;
        // Un descarte es un rechazo del módulo (diagnóstico: la API lo oculta a rivales).
        if (typeof e.slot === "string" && s.perModule[e.slot]) s.perModule[e.slot].rejections += 1;
        const bySlot = radioDroppedBySlot.get(vehicleId) ?? new Map<string, number>();
        bySlot.set(String(e.slot), (bySlot.get(String(e.slot)) ?? 0) + 1);
        radioDroppedBySlot.set(vehicleId, bySlot);
        break;
      }
      case "hit_taken":
        s.damageTaken += e.damage;
        break;
      case "decision_timeout":
        s.decisionTimeouts += 1;
        break;
      case "rejected_action":
        if (e.reason === "timeout_disqualified") s.disqualified = true;
        else {
          if (e.slot && s.perModule[e.slot]) s.perModule[e.slot].rejections += 1;
          // `reason` viene del motor re-simulado; emptyDict: clave de dato externo.
          const reason = typeof e.reason === "string" && e.reason ? e.reason : "unknown";
          s.rejectionsByReason[reason] = (s.rejectionsByReason[reason] ?? 0) + 1;
        }
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
  };

  /**
   * Orden EXACTO de emisión del motor: muertes, reapariciones y descalificaciones
   * por vehículo. Con respawn se cuentan TODAS las muertes. La AUTORÍA de cada
   * baja no se deduce de aquí (4v4-FIX): un golpe NO letal seguido en el mismo
   * tick de la muerte por ácido deja un `hit_dealt` justo antes del
   * `vehicle_destroyed` sin que el motor puntúe nada. La da `onKill`.
   */
  const onEmission = (e: any, to: string | null) => {
    if (to === null && e.kind === "vehicle_destroyed" && byVehicle.has(e.targetId)) {
      const victim = byVehicle.get(e.targetId)!;
      victim.deaths += 1;
      pushLife(e.targetId, e.tick, false);
    } else if (to !== null && e.kind === "respawned" && byVehicle.has(to)) {
      byVehicle.get(to)!.respawns += 1;
      pushLife(to, e.tick, true);
    } else if (to !== null && e.kind === "rejected_action" && e.reason === "timeout_disqualified") {
      pushLife(to, e.tick, false);
    }
  };

  /** Radio OÍDA: lo que el motor entregó en `obs.radio`, partido por bando del emisor. */
  const onObservation = (vehicleId: string, obs: any) => {
    const s = byVehicle.get(vehicleId);
    if (!s || !Array.isArray(obs?.radio)) return;
    for (const m of obs.radio) {
      s.radio.received += 1;
      const fromTeam = byVehicle.get(String(m?.from))?.team;
      if (fromTeam === undefined) continue;
      if (fromTeam === s.team) s.radio.receivedFromTeammates += 1;
      else s.radio.receivedFromEnemies += 1;
    }
  };

  /**
   * 4v4-FIX · Autoría de las bajas EXACTAMENTE como la ve el marcador: el motor
   * llama a `mode.onKill(victim, killerTeam)` y la re-simulación nos dice quién
   * hizo el daño letal (`null` = zona de daño: nadie puntúa, nadie suma baja).
   * Fuego amigo y suicidio (killer del mismo equipo que la víctima) son
   * `teamKills`, nunca `kills`.
   */
  const onKill = (k: { victimId: string; killerId: string | null }) => {
    const victim = byVehicle.get(k.victimId);
    if (!victim || k.killerId === null) return;
    const killer = byVehicle.get(k.killerId);
    if (!killer) return;
    if (killer.team === victim.team) killer.teamKills += 1;
    else killer.kills += 1;
  };

  await resimulateWithEvents(replay, onEvent, { onEmission, onObservation, onKill });

  // La descalificación oficial la dice el RESULTADO (fuente de verdad), no un evento.
  for (const vehicleId of replay.result.disqualified ?? []) {
    const s = byVehicle.get(vehicleId);
    if (s) s.disqualified = true;
  }

  /**
   * ¿Estaba vivo `vehicleId` cuando el motor aplicó (PASO 3) una orden del tick
   * `tick`? Muerte y respawn ocurren DESPUÉS del PASO 3 de su tick, así que sólo
   * cuentan las transiciones de ticks anteriores. Un muerto decide (recibe
   * observaciones), pero el motor ignora su orden: ni dispara ni emite.
   */
  const aliveAt = (vehicleId: string, tick: number): boolean => {
    let alive = true;
    for (const t of lifeline.get(vehicleId) ?? []) {
      if (t.tick >= tick) break;
      alive = t.alive;
    }
    return alive;
  };

  // ---- 2 · Comandos grabados: acciones que el motor llegó a aplicar.
  const fireAttempts = new Map<string, Map<string, number>>(); // vehicleId → slot → intentos
  const moveCommands = new Map<string, number>(); // vehicleId → decisiones con movimiento
  const radioAttempts = new Map<string, Map<string, number>>(); // vehicleId → slot → mensajes
  for (const c of replay.commands) {
    const bs = byVehicle.get(c.vehicleId);
    if (bs) bs.decisions += 1;
    // 4v4-STATS · con respawn un bot muerto sigue decidiendo: lo que ordena
    // estando muerto no es un disparo ni un mensaje (antes inflaba `shotsFired`).
    if (!aliveAt(c.vehicleId, c.tick)) continue;
    const mv = c.command?.move;
    if (mv && ((Number(mv.throttle) || 0) !== 0 || (Number(mv.steer) || 0) !== 0)) {
      moveCommands.set(c.vehicleId, (moveCommands.get(c.vehicleId) ?? 0) + 1);
    }
    if (Array.isArray(c.command?.radio)) {
      const r = radioAttempts.get(c.vehicleId) ?? new Map<string, number>();
      for (const msg of c.command.radio) {
        const slot = String(msg?.slot);
        r.set(slot, (r.get(slot) ?? 0) + 1);
      }
      radioAttempts.set(c.vehicleId, r);
    }
    const v = fireAttempts.get(c.vehicleId) ?? new Map<string, number>();
    for (const slot of c.command?.fire ?? []) v.set(slot, (v.get(slot) ?? 0) + 1);
    if (c.command?.deployMine?.slot) v.set(c.command.deployMine.slot, (v.get(c.command.deployMine.slot) ?? 0) + 1);
    fireAttempts.set(c.vehicleId, v);
  }

  // ---- 3 · Minas detonadas (evento público, con atribución por posición).
  for (const e of replay.events) {
    if (e.kind === "mine_triggered" && e.position) {
      // El dueño no viaja en el evento público; se resuelve por la posición de
      // despliegue (las minas no se mueven).
      const owner = mineOwnerByPos.get(`${e.position.x},${e.position.y}`);
      const os = owner ? byVehicle.get(owner) : undefined;
      if (os) os.minesTriggered += 1;
    }
  }

  // ---- 4 · Cierre por bot: vida, precisión, uso de módulos.
  const duration = replay.result.ticks;
  const lastSnapshot = replay.snapshots.at(-1);
  // R-RULES · el límite sale de la cabecera (la COPIA con que se jugó), nunca de reglas actuales.
  const respawnRule = header.ruleset?.respawn ?? {};
  const maxRespawns =
    respawnRule.enabled === true && Number.isInteger(respawnRule.maxRespawns) && respawnRule.maxRespawns >= 0
      ? (respawnRule.maxRespawns as number)
      : null;
  for (const [vehicleId, s] of byVehicle) {
    s.died = s.deaths > 0;
    if (maxRespawns !== null) {
      s.lives = 1 + maxRespawns;
      s.respawnsRemaining = Math.max(0, maxRespawns - s.respawns);
    }
    // Ticks vivo: suma de tramos [aparición, muerte) hasta el final.
    let alive = true;
    let since = 0;
    let lived = 0;
    for (const t of lifeline.get(vehicleId) ?? []) {
      if (alive && !t.alive) lived += t.tick - since;
      if (!alive && t.alive) since = t.tick;
      alive = t.alive;
    }
    if (alive) lived += duration - since;
    s.survivedTicks = lived;
    s.aliveAtEnd = alive && !s.disqualified;
    if (maxRespawns !== null) s.eliminated = !s.aliveAtEnd && s.respawnsRemaining === 0;
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
    // Radio: aceptados = mensajes aplicados estando vivo − descartados por el motor.
    // En total (radio.sent) y por slot (perModule). Un mensaje a un slot que no es
    // radio lo descarta el motor (`no_radio`): cuenta en el intento y en el descarte.
    const radioBySlot = radioAttempts.get(vehicleId) ?? new Map<string, number>();
    const droppedBySlot = radioDroppedBySlot.get(vehicleId) ?? new Map<string, number>();
    const droppedTotal = [...droppedBySlot.values()].reduce((a, n) => a + n, 0);
    const attemptedTotal = [...radioBySlot.values()].reduce((a, n) => a + n, 0);
    s.radio.sent = Math.max(0, attemptedTotal - droppedTotal);
    // Módulos que no disparan: qué hicieron (antes `uses: 0` siempre, engañoso).
    for (const [slot, pm] of Object.entries(s.perModule)) {
      if (pm.usesKind === "move_commands") pm.uses = moveCommands.get(vehicleId) ?? 0;
      else if (pm.usesKind === "radio_messages") {
        pm.uses = Math.max(0, (radioBySlot.get(slot) ?? 0) - (droppedBySlot.get(slot) ?? 0));
      }
    }
    // Estado final de cada módulo: del último snapshot público.
    const snapVehicle = lastSnapshot?.vehicles?.find((v: any) => v.id === vehicleId);
    for (const m of snapVehicle?.modules ?? []) {
      if (s.perModule[m.slot]) s.perModule[m.slot].finalState = m.state;
    }
  }

  // ---- 4b · Distancia recorrida: suma de tramos entre snapshots públicos
  // consecutivos (cota inferior de la trayectoria real; un respawn no cuenta).
  const lastPos = new Map<string, { x: number; y: number }>();
  for (const snap of replay.snapshots) {
    for (const v of snap?.vehicles ?? []) {
      const s = byVehicle.get(v.id);
      if (!s) continue;
      const pos = v.alive && v.position ? v.position : null;
      const prev = lastPos.get(v.id);
      if (pos && prev) {
        const d = Math.hypot(pos.x - prev.x, pos.y - prev.y);
        // Un salto mayor de 20 m entre snapshots es un respawn, no un recorrido.
        if (Number.isFinite(d) && d < 20) s.distanceM += d;
      }
      if (pos) lastPos.set(v.id, pos);
      else lastPos.delete(v.id);
    }
  }
  for (const s of byVehicle.values()) s.distanceM = Math.round(s.distanceM * 100) / 100;

  // ---- 5 · Por equipo y por mapa.
  // B8 · `emptyDict()`, NO `{}`: `s.team` viene del CONTENIDO DEL REPLAY.
  const perTeam: Record<string, TeamBattleStats> = emptyDict<TeamBattleStats>();
  for (const s of byVehicle.values()) {
    const t = (perTeam[s.team] ??= emptyTeamStats(s.team, Number(safeLookup(replay.result.score ?? {}, s.team) ?? 0)));
    addBotToTeam(t, s);
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

/**
 * B10 (issue #9) · Medidas de CPU persistidas para una batalla
 * (`participants.cpu_ms`, escritas por quien ejecutó los contenedores).
 * Se construye con `Object.fromEntries` sobre un `Map` porque `bot_id` es un
 * dato de BD que acaba siendo clave de un objeto: `acc[botId] = v` con
 * "__proto__" no crearía entrada, cambiaría el prototipo del acumulador.
 */
async function readMeasuredCpuMs(db: Db, dbBattleId: string): Promise<Record<string, unknown>> {
  const rows = (await db("participants").where({ battle_id: dbBattleId }).select("bot_id", "cpu_ms")) as Array<{
    bot_id: string;
    cpu_ms: number | string | null;
  }>;
  const measured = new Map<string, unknown>();
  for (const r of rows) {
    if (r.cpu_ms === null || r.cpu_ms === undefined) continue;
    // `double precision` puede llegar como string según el driver: se convierte
    // aquí y `sanitizeCpuMs` descarta lo que no sea un número finito.
    const value = typeof r.cpu_ms === "string" ? Number(r.cpu_ms) : r.cpu_ms;
    measured.set(String(r.bot_id), value);
  }
  return Object.fromEntries(measured);
}

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
 *
 * B10 (issue #9) · La CPU por bot NO se recalcula (no está en el replay): se lee
 * de `participants.cpu_ms`, donde la dejó quien SÍ la midió (el lanzador de
 * batallas en contenedor). Por eso reprocesar es estable — el job sigue siendo
 * idempotente y una recomputación NO borra la medida ni la sustituye por un
 * valor inventado; sin medida en BD, `cpuMs` queda `null`.
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
  const stats = await computeBattleStats(loaded.replay, {
    cpuMsByBot: await readMeasuredCpuMs(db, dbBattleId),
  });

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
