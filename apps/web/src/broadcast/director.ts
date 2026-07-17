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
  participants: { botId: string; version: number; team: string; outcome?: string }[];
  result?: { score?: Record<string, number>; ticks?: number };
}

/** Progreso del torneo para la cabecera ("Batalla 3/7"). */
export interface TournamentProgress {
  played: number;
  total: number;
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
 * Sondea el estado por la API PÚBLICA (visitor: listBattles/getBattle, cap. 16)
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
    // Modo torneo: listBattles es público y pagina desc por creación; se filtra
    // por torneo en cliente y se re-ordena ascendente (orden de juego).
    const page = (await this.opts.fetchJson(`/battles?limit=100`)) as { items: BattleSummary[] };
    const tid = this.opts.target.tournamentId;
    const battles = page.items.filter((b) => b.tournamentId === tid).reverse();
    return decideScreen(battles, this.currentBattleId);
  }
}
