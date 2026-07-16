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
        this.push(e, `Marcador: ${Object.entries(e.score).map(([t, n]) => `${t} ${n}`).join(" · ")}`);
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
      default:
        this.push(e, e.kind);
    }
  }

  private push(e: any, text: string): void {
    this.feed.push({ tick: e.tick ?? this.lastTick, kind: e.kind, text });
    if (this.feed.length > FEED_LIMIT) this.feed.splice(0, this.feed.length - FEED_LIMIT);
  }
}
