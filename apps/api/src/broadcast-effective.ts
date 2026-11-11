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
import { publicShowabilityOf } from "./replay-access.js";

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
    .first("id", "status")
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
    // La política anónima NUNCA deja leer una programada (no hay vía para ello): no
    // está disponible AHORA. Se dice por qué no lo estará tampoco al empezar, si es el caso.
    if (!vis.publicSpectate) return out(false, "public_spectate_disabled");
    return out(false, (await showReason()) ?? "battle_not_started");
  }
  return out(false, "battle_not_available");
}

/**
 * Estado efectivo de un torneo: el director lee sus batallas con la misma política;
 * las que están en directo exigen el espectador público y, con el torneo terminado,
 * la pantalla final exige los replays públicos. null = no existe.
 */
export async function tournamentBroadcastState(
  db: Db,
  tournamentId: string,
  vis: BattleVisibility,
): Promise<BroadcastEffectiveState | null> {
  const t = await db("tournaments")
    .where({ id: tournamentId })
    .first("id", "state")
    .catch(() => null);
  if (!t) return null;
  const out = (available: boolean, reason: BroadcastUnavailableReason | null): BroadcastEffectiveState => ({
    publicSpectateEffective: vis.publicSpectate,
    publicReplaysEffective: vis.publicReplays,
    broadcastAvailable: available,
    reason: available ? null : reason,
    effective: { ...vis },
  });
  if (t.state === "cancelled") return out(false, "target_not_available");
  if (t.state === "finished") return vis.publicReplays ? out(true, null) : out(false, "public_replays_disabled");
  return vis.publicSpectate ? out(true, null) : out(false, "public_spectate_disabled");
}
