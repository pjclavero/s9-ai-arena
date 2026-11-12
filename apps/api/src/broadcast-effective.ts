/**
 * MG · Estado EFECTIVO de la retransmisión pública de un destino.
 *
 * `/broadcast` es ANÓNIMA: para una batalla lee `GET /battles/{id}` y, en directo,
 * pide `POST /battles/{id}/spectate-ticket` y abre el WebSocket del gateway; para un
 * torneo lee `GET /tournaments/{id}/battles`. Todas esas lecturas pasan por
 * `whereBattleReadable` (battle-access.ts) con `auth = undefined`. Aquí se evalúa
 * EXACTAMENTE esa política (no una copia) con la visibilidad pública VIGENTE
 * (RuntimeSettingsStore), así la admin nunca anuncia «retransmisible» algo que la
 * página no podrá leer.
 *
 *  - PUBLIC_SPECTATE_EFFECTIVE: un anónimo puede ver ESTA batalla en directo ahora
 *    (está `running` y la política anónima la deja leer, lo que exige el flag).
 *  - PUBLIC_REPLAYS_EFFECTIVE: un anónimo puede leer ESTA batalla terminada ahora.
 *  - PUBLIC_BROADCAST_AVAILABLE: `/broadcast` puede mostrar el destino ahora.
 */
import type { Db } from "./db/connection.js";
import { whereBattleReadable, type BattleVisibility } from "./battle-access.js";
import { publicShowabilityOf, wherePubliclyShowable } from "./replay-access.js";

export type BroadcastUnavailableReason =
  /** El espectador público está desactivado: /broadcast no puede leer batallas en directo. */
  | "public_spectate_disabled"
  /** Los replays públicos están desactivados: /broadcast no puede leer una batalla terminada. */
  | "public_replays_disabled"
  /** Batalla suelta con bots no públicos (sólo un torneo con `broadcast` autoriza mostrarlos). */
  | "battle_not_public"
  /** Batalla de un torneo sin `broadcast` con bots no públicos. */
  | "tournament_not_broadcastable"
  /** Batalla programada: /broadcast mostrará la espera y la verá cuando empiece. */
  | "battle_not_started"
  /** Batalla fallida, revertida o en un estado que nunca se muestra en público. */
  | "battle_not_available"
  /** Torneo cancelado. */
  | "target_not_available"
  /** FIX-BROADCAST · el destino no existe (start responde 409 con este motivo). */
  | "target_not_found"
  /**
   * FIX-BROADCAST · torneo terminado sin NINGUNA batalla terminada que /broadcast pueda
   * mostrar: la emisión sólo enseñaría «Torneo terminado» (o, antes, una espera eterna).
   */
  | "tournament_no_content"
  /** FIX-BROADCAST · torneo en borrador: aún no existe ni su inscripción. */
  | "tournament_not_started"
  /** No hay streamer configurado en este despliegue. */
  | "streaming_not_configured"
  /** La política anónima la deniega por otro motivo. */
  | "other";

export interface BroadcastEffectiveState {
  publicSpectateEffective: boolean;
  publicReplaysEffective: boolean;
  broadcastAvailable: boolean;
  reason: BroadcastUnavailableReason | null;
  /** Flags globales con los que se ha calculado. */
  effective: BattleVisibility;
}

/** ¿Un ANÓNIMO puede leer la batalla con la política única? (la que usa /broadcast). */
export async function anonymousCanReadBattle(db: Db, battleId: string, vis: BattleVisibility): Promise<boolean> {
  const row = await whereBattleReadable(db, db("battles").where("battles.id", battleId), undefined, vis)
    .first("battles.id")
    .catch(() => null);
  return !!row;
}

/** Estado efectivo de una batalla. null = no existe. */
export async function battleBroadcastState(
  db: Db,
  battleId: string,
  vis: BattleVisibility,
): Promise<BroadcastEffectiveState | null> {
  const b = await db("battles")
    .where({ id: battleId })
    .first("id", "status", "reverted_at")
    .catch(() => null);
  if (!b) return null;
  const readable = await anonymousCanReadBattle(db, battleId, vis);
  const status = String(b.status);
  const out = (available: boolean, reason: BroadcastUnavailableReason | null): BroadcastEffectiveState => ({
    publicSpectateEffective: status === "running" && readable,
    publicReplaysEffective: status === "finished" && readable,
    broadcastAvailable: available,
    reason: available ? null : reason,
    effective: { ...vis },
  });
  const showReason = async (): Promise<BroadcastUnavailableReason | null> => {
    const show = await publicShowabilityOf(db, battleId);
    return show && !show.showable ? show.reason : null;
  };
  // FIX-BROADCAST · una batalla REVERTIDA no se emite aunque siga legible como replay: su
  // resultado ya no cuenta y la emisión lo presentaría como válido.
  if (b.reverted_at) return out(false, "battle_not_available");
  if (status === "running") {
    if (readable) return out(true, null);
    if (!vis.publicSpectate) return out(false, "public_spectate_disabled");
    return out(false, (await showReason()) ?? "other");
  }
  if (status === "finished") {
    if (readable) return out(true, null);
    if (!vis.publicReplays) return out(false, "public_replays_disabled");
    return out(false, (await showReason()) ?? "other");
  }
  if (status === "scheduled") {
    // FIX-BROADCAST (R2) · espera LEGÍTIMA: la política anónima no deja leer una programada,
    // pero al pasar a `running` la leerá con la vía del directo público (`wherePubliclyShowable`
    // + espectador público). Si esa vía la dejará leer, se puede emitir YA (para no perder el
    // principio) y /broadcast muestra la espera; si no, se rechaza con el motivo real.
    if (!vis.publicSpectate) return out(false, "public_spectate_disabled");
    const show = await publicShowabilityOf(db, battleId);
    if (!show) return out(false, "battle_not_available");
    if (!show.showable) return out(false, show.reason ?? "other");
    return out(true, null);
  }
  return out(false, "battle_not_available");
}

/**
 * Estado efectivo de un torneo, con la política REAL (la de `GET /tournaments/{id}/battles`
 * que lee /broadcast, anónima):
 *  - el estado (cancelado ⇒ `target_not_available`);
 *  - el flag que exige el estado: en curso ⇒ espectador público; terminado ⇒ replays públicos;
 *  - la visibilidad de los bots y `tournament.broadcast`: si el torneo no autoriza la
 *    retransmisión y alguna de sus batallas tiene bots no públicos (`wherePubliclyShowable`)
 *    ⇒ `tournament_not_broadcastable`;
 *  - `whereBattleReadable` anónimo sobre las batallas del torneo que /broadcast muestra
 *    (en directo si está en curso, terminadas si ha terminado): si alguna no se puede
 *    leer ⇒ `other`.
 * null = no existe.
 */
export async function tournamentBroadcastState(
  db: Db,
  tournamentId: string,
  vis: BattleVisibility,
): Promise<BroadcastEffectiveState | null> {
  const t = await db("tournaments")
    .where({ id: tournamentId })
    .first("id", "state", "broadcast")
    .catch(() => null);
  if (!t) return null;
  const count = async (q: any): Promise<number> => {
    const r = await q.count({ n: "battles.id" }).first();
    return Number(r?.n ?? 0);
  };
  const base = () => db("battles").where("battles.tournament_id", tournamentId);
  const total = await count(base());
  const showable = await count(wherePubliclyShowable(db, base()));
  const botsBlocked = total > showable;
  const finished = t.state === "finished";
  const out = (available: boolean, reason: BroadcastUnavailableReason | null): BroadcastEffectiveState => ({
    publicSpectateEffective: vis.publicSpectate && !botsBlocked,
    publicReplaysEffective: vis.publicReplays && !botsBlocked,
    broadcastAvailable: available,
    reason: available ? null : reason,
    effective: { ...vis },
  });
  if (t.state === "cancelled") return out(false, "target_not_available");
  if (t.state === "draft") return out(false, "tournament_not_started");
  if (finished ? !vis.publicReplays : !vis.publicSpectate) {
    return out(false, finished ? "public_replays_disabled" : "public_spectate_disabled");
  }
  if (botsBlocked) return out(false, "tournament_not_broadcastable");
  const shown = base().where("battles.status", finished ? "finished" : "running");
  const shownTotal = await count(shown.clone());
  const readable = await count(whereBattleReadable(db, shown.clone(), undefined, vis));
  if (readable < shownTotal) return out(false, "other");
  // FIX-BROADCAST · terminado y sin ninguna batalla terminada legible: no hay NADA que
  // emitir (la emisión se quedaba en «Esperando el inicio del torneo…» para siempre).
  if (finished && readable === 0) return out(false, "tournament_no_content");
  return out(true, null);
}

// ── FIX-BROADCAST · fase de la emisión y resumen del destino ────────────────

/**
 * Qué mostrará /broadcast con este destino, con la MISMA lectura que el director:
 *  - LIVE: hay una batalla en directo que un anónimo puede ver;
 *  - WAITING_VALID: espera LEGÍTIMA (torneo abierto o en curso sin batalla en directo
 *    ahora: sus batallas programadas llegarán);
 *  - TARGET_FINISHED: el destino terminó y tiene contenido final que mostrar;
 *  - UNAVAILABLE: no se puede emitir (motivo en `reason`).
 */
export type BroadcastPhase = "LIVE" | "WAITING_VALID" | "TARGET_FINISHED" | "UNAVAILABLE";

export interface BattleCounts {
  scheduled: number;
  running: number;
  finished: number;
  failed: number;
}

/** Información clara del destino para la admin (evita confundir batalla suelta y torneo). */
export interface BroadcastTargetSummary {
  /** `standalone_battle` = batalla suelta (sin torneo). */
  targetType: "standalone_battle" | "tournament_battle" | "tournament";
  /** Torneo al que pertenece la batalla (null si es suelta o si el destino es un torneo). */
  tournament: { id: string; name: string; state: string } | null;
  /** Batallas del torneo por estado (sólo destino torneo). */
  battleCounts: BattleCounts | null;
  broadcastPhase: BroadcastPhase;
}

async function countsByStatus(db: Db, tournamentId: string): Promise<BattleCounts> {
  const rows: { status: string; n: string | number }[] = await db("battles")
    .where("tournament_id", tournamentId)
    .groupBy("status")
    .select("status")
    .count({ n: "id" });
  const out: BattleCounts = { scheduled: 0, running: 0, finished: 0, failed: 0 };
  for (const r of rows) if (r.status in out) out[r.status as keyof BattleCounts] = Number(r.n);
  return out;
}

/**
 * Resumen del destino y fase de la emisión a partir del estado EFECTIVO ya calculado
 * (battleBroadcastState / tournamentBroadcastState). null = no existe.
 */
export async function broadcastTargetSummary(
  db: Db,
  t: { kind: "battle" | "tournament"; id: string },
  eff: Pick<BroadcastEffectiveState, "broadcastAvailable">,
): Promise<BroadcastTargetSummary | null> {
  if (t.kind === "battle") {
    const b = await db("battles")
      .leftJoin("tournaments", "tournaments.id", "battles.tournament_id")
      .where("battles.id", t.id)
      .first("battles.status", "battles.tournament_id", "tournaments.name as t_name", "tournaments.state as t_state")
      .catch(() => null);
    if (!b) return null;
    const phase: BroadcastPhase = !eff.broadcastAvailable
      ? "UNAVAILABLE"
      : b.status === "running"
        ? "LIVE"
        : b.status === "finished"
          ? "TARGET_FINISHED"
          : b.status === "scheduled"
            ? "WAITING_VALID"
            : "UNAVAILABLE";
    return {
      targetType: b.tournament_id ? "tournament_battle" : "standalone_battle",
      tournament: b.tournament_id
        ? { id: String(b.tournament_id), name: String(b.t_name ?? "").slice(0, 120), state: String(b.t_state) }
        : null,
      battleCounts: null,
      broadcastPhase: phase,
    };
  }
  const tr = await db("tournaments")
    .where({ id: t.id })
    .first("id", "state")
    .catch(() => null);
  if (!tr) return null;
  const counts = await countsByStatus(db, t.id);
  const phase: BroadcastPhase = !eff.broadcastAvailable
    ? "UNAVAILABLE"
    : tr.state === "finished"
      ? "TARGET_FINISHED"
      : counts.running > 0
        ? "LIVE"
        : "WAITING_VALID";
  return { targetType: "tournament", tournament: null, battleCounts: counts, broadcastPhase: phase };
}
