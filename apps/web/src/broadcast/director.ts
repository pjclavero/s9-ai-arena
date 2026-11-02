/**
 * T11.1 · Director de emisión: decide QUÉ pantalla muestra /broadcast a partir
 * del estado PÚBLICO del torneo (E9 escribe batallas; aquí solo se leen por la
 * API pública de visitante). Regla de oro del cap. 21: el streaming no toca el
 * motor ni el tick — este módulo solo hace GET anónimos y consume el canal de
 * espectador como un cliente más.
 *
 * La decisión (`decideScreen`) es una función PURA y probada; el `BroadcastDirector`
 * solo añade el sondeo con reloj/fetch inyectables.
 */

export interface BattleSummary {
  id: string;
  tournamentId?: string;
  status: "scheduled" | "running" | "finished" | "failed";
  mode: string;
  participants: { botId: string; botName?: string; version: number; team: string; outcome?: string }[];
  result?: { score?: Record<string, number>; ticks?: number };
}

/**
 * Progreso del torneo para la cabecera ("Batalla 3/7"). `total` es null cuando
 * NO es conocible: un visitante no ve las batallas programadas (ver
 * `applyTournamentState`), así que mientras el torneo sigue no se inventa.
 */
export interface TournamentProgress {
  played: number;
  total: number | null;
}

export type BroadcastScreen = (
  | { kind: "waiting"; nextBattle: BattleSummary | null }
  | { kind: "live"; battle: BattleSummary }
  | { kind: "intermission"; lastBattle: BattleSummary; nextBattle: BattleSummary | null }
  | { kind: "finished"; lastBattle: BattleSummary | null }
) & { progress?: TournamentProgress };

/**
 * Decide la pantalla a partir de la lista de batallas del torneo en orden de
 * creación (la más antigua primero):
 *  - hay batalla `running` → EN DIRECTO (si la actual sigue viva, no se cambia);
 *  - no hay running pero quedan `scheduled` → espera: `waiting` si aún no se ha
 *    jugado nada, `intermission` (marcador de la última) entre batallas;
 *  - todo terminado → pantalla final con la última batalla.
 * Las `failed` no se emiten: son fallo de infraestructura (19.2), no espectáculo.
 */
export function decideScreen(battles: BattleSummary[], currentBattleId: string | null): BroadcastScreen {
  const running = battles.filter((b) => b.status === "running");
  const finished = battles.filter((b) => b.status === "finished");
  const progress: TournamentProgress = { played: finished.length, total: battles.length };

  const current = currentBattleId ? running.find((b) => b.id === currentBattleId) : undefined;
  if (current) return { kind: "live", battle: current, progress };
  if (running.length > 0) return { kind: "live", battle: running[0], progress };

  const scheduled = battles.filter((b) => b.status === "scheduled");
  const lastBattle = finished.length > 0 ? finished[finished.length - 1] : null;
  const nextBattle = scheduled.length > 0 ? scheduled[0] : null;

  if (nextBattle) {
    return lastBattle
      ? { kind: "intermission", lastBattle, nextBattle, progress }
      : { kind: "waiting", nextBattle, progress };
  }
  if (battles.length === 0) return { kind: "waiting", nextBattle: null, progress };
  return { kind: "finished", lastBattle, progress };
}

/** Estados de torneo que cierran la emisión (tournaments.state, migración E7/E9). */
const CLOSED_TOURNAMENT_STATES = new Set(["finished", "cancelled"]);

/**
 * EQ5 (2026-11-02) · Ajusta la pantalla al ESTADO del torneo. La vista es anónima
 * y la política de lectura (battle-access.ts) sólo enseña a un visitante las
 * batallas `running` (directo público) y `finished` (replay público): las
 * `scheduled` nunca. Por eso la lista visible NO permite saber si queda torneo:
 * con B1 terminada y B2 programada, decideScreen veía [B1] y anunciaba «Torneo
 * terminado» en mitad del torneo (reproducido en Chromium). Regla:
 *  - sólo hay pantalla final si el torneo está `finished`/`cancelled`;
 *  - si no (o si el estado no se pudo leer: `null`), lo que decideScreen llamaría
 *    final es un intermedio (con la última batalla) o una espera;
 *  - el total de batallas sólo se rotula con el torneo cerrado.
 */
export function applyTournamentState(screen: BroadcastScreen, state: string | null): BroadcastScreen {
  const closed = state !== null && CLOSED_TOURNAMENT_STATES.has(state);
  const progress: TournamentProgress | undefined = screen.progress
    ? { played: screen.progress.played, total: closed ? screen.progress.total : null }
    : undefined;
  if (screen.kind === "finished" && !closed) {
    return screen.lastBattle
      ? { kind: "intermission", lastBattle: screen.lastBattle, nextBattle: null, progress }
      : { kind: "waiting", nextBattle: null, progress };
  }
  return { ...screen, progress };
}

/** GET anónimo de JSON. Inyectable en tests; en producción, fetch del navegador. */
export type PublicFetch = (path: string) => Promise<any>;

/**
 * Cliente API ANÓNIMO de la vista broadcast: a diferencia de `api()` del panel
 * (que adjunta el token de sesión si existe), aquí NUNCA viaja Authorization.
 * La vista solo puede ver lo que ve un visitante (DoD T11.1: cero datos
 * privados; el canal de espectador ya lo garantiza E8 por construcción).
 */
export function createPublicApi(base = "/api/v1", fetchImpl: typeof fetch = fetch) {
  const call = async (method: "GET" | "POST", path: string): Promise<any> => {
    const res = await fetchImpl(`${base}${path}`, { method });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${method} ${path}`);
    return res.json();
  };
  return {
    get: (path: string) => call("GET", path),
    post: (path: string) => call("POST", path),
  };
}

export interface DirectorOptions {
  target: { kind: "battle"; battleId: string } | { kind: "tournament"; tournamentId: string };
  fetchJson: PublicFetch;
  onScreen: (screen: BroadcastScreen) => void;
  pollIntervalMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}

/**
 * Sondea el estado por la API PÚBLICA (visitor: listTournamentBattles/getBattle, cap. 16)
 * y emite pantallas solo cuando cambian (`kind` o batalla). El avance automático
 * a la siguiente batalla del torneo (DoD T11.1) sale solo de aquí: cuando la
 * batalla en directo pasa a `finished`, la siguiente `running` toma el relevo
 * tras la pantalla de intermedio.
 */
export class BroadcastDirector {
  private readonly opts: DirectorOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKey = "";
  /** Batalla actualmente en pantalla (para no saltar entre dos running). */
  private currentBattleId: string | null = null;

  constructor(opts: DirectorOptions) {
    this.opts = opts;
  }

  start(): void {
    const every = this.opts.pollIntervalMs ?? 4000;
    const setI = this.opts.setIntervalImpl ?? setInterval;
    void this.tick();
    this.timer = setI(() => void this.tick(), every);
  }

  stop(): void {
    if (this.timer !== null) (this.opts.clearIntervalImpl ?? clearInterval)(this.timer);
    this.timer = null;
  }

  /** Un ciclo de sondeo. Público para poder probarlo sin relojes. */
  async tick(): Promise<void> {
    try {
      const screen = await this.computeScreen();
      this.currentBattleId = screen.kind === "live" ? screen.battle.id : null;
      const key = `${screen.kind}:${screen.kind === "live" ? screen.battle.id : ((screen as any).nextBattle?.id ?? "")}`;
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.opts.onScreen(screen);
      }
    } catch {
      // Fallo de red del sondeo: se conserva la última pantalla y se reintenta
      // al siguiente ciclo. La emisión no se cae por un GET perdido.
    }
  }

  private async computeScreen(): Promise<BroadcastScreen> {
    if (this.opts.target.kind === "battle") {
      const b = (await this.opts.fetchJson(`/battles/${this.opts.target.battleId}`)) as BattleSummary;
      if (b.status === "running") return { kind: "live", battle: b };
      if (b.status === "scheduled") return { kind: "waiting", nextBattle: b };
      return { kind: "finished", lastBattle: b.status === "finished" ? b : null };
    }
    // Modo torneo: `GET /tournaments/{id}/battles` (listTournamentBattles,
    // visitor) devuelve el calendario COMPLETO del torneo, ya en orden de juego
    // (ASC por creación) y con la misma política de visibilidad que /battles.
    // EQ5 (2026-11-02): antes se pedía `/battles?limit=100` —las 100 batallas
    // más recientes de TODA la plataforma— y se filtraba aquí; con más de 100
    // batallas ajenas posteriores la emisión se quedaba en «esperando» con el
    // torneo en directo.
    const tid = encodeURIComponent(this.opts.target.tournamentId);
    const [page, state] = await Promise.all([
      this.opts.fetchJson(`/tournaments/${tid}/battles`) as Promise<{ items: BattleSummary[] }>,
      this.tournamentState(),
    ]);
    return applyTournamentState(decideScreen(page.items, this.currentBattleId), state);
  }

  /**
   * Estado del torneo por `listTournaments` (visitor; no hay GET por id). Se
   * pagina con el cursor hasta encontrarlo (los torneos son pocos; tope de 5
   * páginas). Cualquier fallo ⇒ null ⇒ «no cerrado»: mejor un intermedio de más
   * que anunciar el final de un torneo que sigue.
   */
  private async tournamentState(): Promise<string | null> {
    if (this.opts.target.kind !== "tournament") return null;
    const tid = this.opts.target.tournamentId;
    try {
      let cursor: string | undefined;
      for (let i = 0; i < 5; i++) {
        const q = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const page = (await this.opts.fetchJson(`/tournaments?limit=100${q}`)) as {
          items?: { id: string; state?: string }[];
          nextCursor?: string;
        };
        const t = page.items?.find((x) => x.id === tid);
        if (t) return typeof t.state === "string" ? t.state : null;
        if (!page.nextCursor) return null;
        cursor = page.nextCursor;
      }
    } catch {
      /* sin estado: se trata como torneo abierto */
    }
    return null;
  }
}
