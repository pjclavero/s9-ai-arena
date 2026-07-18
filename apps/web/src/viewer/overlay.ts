/**
 * T8.2 · Estado del overlay del visor: salud, módulos dañados, estado de bandera,
 * marcador y feed de eventos. Es un REDUCTOR puro sobre snapshots y eventos
 * públicos del motor de E2 — se prueba con una batalla CTF real guionizada
 * (DoD: "la máquina de estados de bandera se refleja correctamente").
 */

export type FlagState = "at_base" | "carried" | "dropped";

export interface VehicleOverlay {
  id: string;
  team: string;
  alive: boolean;
  hullHp: number;
  hullHpMax: number;
  carryingFlag: string | null;
  /** slot → estado del módulo (operational/damaged/critical/destroyed/offline). */
  modules: Record<string, string>;
}

export interface FeedItem {
  tick: number;
  kind: string;
  text: string;
}

/**
 * R3.6 · Resultado de fin de partida, normalizado desde el `result` del canal de
 * espectador (o de un evento `match_ended`). Es la fuente para ANUNCIAR el fin
 * sobre el canvas, no sólo en el feed HTML.
 */
export interface MatchResult {
  /** Equipo ganador, o null en empate. */
  winner: string | null;
  /** Marcador final por equipo. */
  score: Record<string, number>;
  /** Motivo publicado (p.ej. "score", "timeout", "elimination"), si viene. */
  reason: string | null;
  /** Tick en que terminó, si se conoce. */
  endedTick: number | null;
}

const FEED_LIMIT = 50;

export class OverlayState {
  score: Record<string, number> = {};
  objectives: any = null;
  vehicles = new Map<string, VehicleOverlay>();
  /** team de la bandera → estado. Refleja la FSM del modo CTF de E2 (T2.5). */
  flags = new Map<string, FlagState>();
  /** team de la bandera → vehicleId que la lleva (para resolver flag_captured). */
  carriers = new Map<string, string>();
  feed: FeedItem[] = [];
  lastTick = 0;
  /** R3.6 · Resultado de fin de partida (null mientras la batalla sigue viva). */
  result: MatchResult | null = null;

  applySnapshot(s: any): void {
    if (!s) return;
    this.lastTick = s.tick;
    this.score = { ...s.score };
    this.objectives = s.objectives ?? this.objectives;
    for (const v of s.vehicles ?? []) {
      this.vehicles.set(v.id, {
        id: v.id,
        team: v.team,
        alive: v.alive,
        hullHp: v.hullHp,
        hullHpMax: v.hullHpMax,
        carryingFlag: v.carryingFlag ?? null,
        modules: Object.fromEntries((v.modules ?? []).map((m: any) => [m.slot, m.state])),
      });
      // El snapshot es la verdad más fresca también para la bandera: si alguien
      // la lleva, está "carried" aunque el evento aún no haya llegado.
      if (v.carryingFlag) this.flags.set(v.carryingFlag, "carried");
    }
  }

  applyEvent(e: any): void {
    if (!e || typeof e.kind !== "string") return;
    switch (e.kind) {
      case "flag_taken":
        this.flags.set(e.team, "carried");
        if (e.sourceId) this.carriers.set(e.team, e.sourceId);
        this.push(e, `Bandera ${e.team} tomada por ${e.sourceId}`);
        break;
      case "flag_dropped":
        this.flags.set(e.team, "dropped");
        this.carriers.delete(e.team);
        this.push(e, `Bandera ${e.team} al suelo`);
        break;
      case "flag_returned":
        this.flags.set(e.team, "at_base");
        this.carriers.delete(e.team);
        this.push(e, `Bandera ${e.team} devuelta a base`);
        break;
      case "flag_captured": {
        // OJO con el vocabulario del motor: en flag_captured `e.team` es el equipo
        // QUE CAPTURA (y puntúa), no el dueño de la bandera. La bandera que vuelve
        // a base es la que llevaba un portador de ese equipo (rastreada en flag_taken).
        for (const [flagTeam, carrierId] of this.carriers) {
          if (this.vehicles.get(carrierId)?.team === e.team && this.flags.get(flagTeam) === "carried") {
            this.flags.set(flagTeam, "at_base");
            this.carriers.delete(flagTeam);
          }
        }
        if (e.score) this.score = { ...e.score };
        this.push(e, `¡Captura de ${e.team}!`);
        break;
      }
      case "score_changed":
        this.score = { ...e.score };
        this.push(
          e,
          `Marcador: ${Object.entries(e.score)
            .map(([t, n]) => `${t} ${n}`)
            .join(" · ")}`,
        );
        break;
      case "vehicle_destroyed":
        this.push(e, `${e.targetId} destruido`);
        break;
      case "mine_triggered":
        this.push(e, `Mina detonada`);
        break;
      case "zone_captured":
        this.push(e, `Zona capturada por ${e.team}`);
        break;
      // R3.6 · algunos motores/modos anuncian el fin como EVENTO en el propio
      // stream (no sólo como mensaje `result` del canal). Se normaliza igual.
      case "match_ended":
      case "battle_finished":
        this.applyResult({ winner: e.winner ?? null, score: e.score ?? this.score, reason: e.reason, tick: e.tick });
        break;
      default:
        this.push(e, e.kind);
    }
  }

  /**
   * R3.6 · Registra el fin de partida desde el `result` del canal de espectador o
   * un evento `match_ended`. Idempotente: el primer resultado manda (los reenvíos
   * de reconexión no lo pisan) y el marcador final queda fijado. Deja constancia
   * en el feed para que el fin también viaje por el ticker HTML.
   */
  applyResult(result: any): void {
    if (!result || this.result) return;
    const score = result.score && typeof result.score === "object" ? { ...result.score } : { ...this.score };
    const winner = typeof result.winner === "string" ? result.winner : null;
    const normalized: MatchResult = {
      winner,
      score,
      reason: typeof result.reason === "string" ? result.reason : null,
      endedTick: Number.isFinite(result.tick) ? result.tick : this.lastTick,
    };
    this.result = normalized;
    this.score = score;
    this.push(
      { kind: "match_ended", tick: normalized.endedTick },
      winner ? `Fin de la partida · gana ${winner}` : "Fin de la partida · empate",
    );
  }

  private push(e: any, text: string): void {
    this.feed.push({ tick: e.tick ?? this.lastTick, kind: e.kind, text });
    if (this.feed.length > FEED_LIMIT) this.feed.splice(0, this.feed.length - FEED_LIMIT);
  }
}
