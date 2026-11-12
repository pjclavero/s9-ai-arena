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

/**
 * FIX-BROADCAST · motivo ESTABLE de un fallo de la fuente (`SOURCE_ERROR`):
 *  - target_not_found: la API pública responde 404 (destino inexistente o no legible);
 *  - invalid_json: la respuesta no es JSON (p. ej. el index.html de la web);
 *  - invalid_payload: JSON con otra forma;
 *  - http_<código>: otro rechazo permanente (4xx);
 *  - unreachable: N fallos transitorios seguidos (red, 5xx, 429).
 */
export type SourceErrorReason =
  "target_not_found" | "invalid_json" | "invalid_payload" | "unreachable" | `http_${number}`;

export type BroadcastScreen = (
  | { kind: "waiting"; nextBattle: BattleSummary | null }
  | { kind: "live"; battle: BattleSummary }
  | { kind: "intermission"; lastBattle: BattleSummary; nextBattle: BattleSummary | null }
  | { kind: "finished"; lastBattle: BattleSummary | null }
  /** FIX-BROADCAST · torneo cancelado: estado terminal propio (no «terminado»). */
  | { kind: "cancelled"; lastBattle: BattleSummary | null }
  /** FIX-BROADCAST · la fuente no da datos utilizables: error VISIBLE, no una espera falsa. */
  | { kind: "error"; reason: SourceErrorReason; detail: string }
) & { progress?: TournamentProgress };

/**
 * FIX-BROADCAST · estado del director, distinguible y reportable (atributo
 * `data-director-state` de la página):
 *  - WAITING_VALID: espera legítima (torneo abierto o en curso sin batalla en directo
 *    visible, o batalla programada);
 *  - TARGET_FINISHED / TARGET_CANCELLED: el destino terminó; no se espera nada más;
 *  - SOURCE_ERROR: la fuente falla de forma permanente o repetida.
 */
export type DirectorState =
  "LIVE" | "INTERMISSION" | "WAITING_VALID" | "TARGET_FINISHED" | "TARGET_CANCELLED" | "SOURCE_ERROR";

export function directorStateOf(screen: BroadcastScreen | null): DirectorState {
  switch (screen?.kind) {
    case "live":
      return "LIVE";
    case "intermission":
      return "INTERMISSION";
    case "finished":
      return "TARGET_FINISHED";
    case "cancelled":
      return "TARGET_CANCELLED";
    case "error":
      return "SOURCE_ERROR";
    default:
      return "WAITING_VALID";
  }
}

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
  if (screen.kind === "error") return screen;
  if (closed && screen.kind !== "live") {
    // FIX-BROADCAST · torneo CERRADO sin batalla en directo ⇒ estado terminal, aunque la
    // lista visible esté vacía (p. ej. replays públicos apagados): antes `waiting` ganaba
    // y la emisión decía «Esperando el inicio del torneo…» para siempre.
    const lastBattle =
      screen.kind === "finished" || screen.kind === "intermission" || screen.kind === "cancelled"
        ? screen.lastBattle
        : null;
    return state === "cancelled"
      ? { kind: "cancelled", lastBattle, progress }
      : { kind: "finished", lastBattle, progress };
  }
  if (screen.kind === "finished" && !closed) {
    return screen.lastBattle
      ? { kind: "intermission", lastBattle: screen.lastBattle, nextBattle: null, progress }
      : { kind: "waiting", nextBattle: null, progress };
  }
  return { ...screen, progress };
}

/** FIX-BROADCAST · error de la API pública con su clase (para decidir si reintentar). */
export class PublicApiError extends Error {
  constructor(
    message: string,
    /** Código HTTP (0 si no hubo respuesta). */
    public readonly status: number,
    public readonly kind: "http" | "invalid_json" | "invalid_payload" | "network",
  ) {
    super(message);
    this.name = "PublicApiError";
  }
}

/**
 * FIX-BROADCAST · ¿el fallo es PERMANENTE (⇒ SOURCE_ERROR en el acto) o transitorio
 * (⇒ reintento; SOURCE_ERROR sólo tras N seguidos)? Permanentes: 404 y demás 4xx salvo
 * 408/429, JSON inválido y forma inválida. Transitorios: red, 5xx, 408, 429 y cualquier
 * otro error desconocido.
 */
export function classifySourceError(e: unknown): { permanent: boolean; reason: SourceErrorReason; detail: string } {
  const detail = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
  if (e instanceof SyntaxError) return { permanent: true, reason: "invalid_json", detail };
  if (e instanceof PublicApiError) {
    if (e.kind === "invalid_json") return { permanent: true, reason: "invalid_json", detail };
    if (e.kind === "invalid_payload") return { permanent: true, reason: "invalid_payload", detail };
    if (e.kind === "http") {
      if (e.status === 404) return { permanent: true, reason: "target_not_found", detail };
      if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429)
        return { permanent: true, reason: `http_${e.status}`, detail };
    }
  }
  return { permanent: false, reason: "unreachable", detail };
}

const BATTLE_STATUSES = new Set(["scheduled", "running", "finished", "failed"]);

function validBattle(b: unknown): b is BattleSummary {
  const o = b as BattleSummary | null;
  return (
    !!o &&
    typeof o === "object" &&
    typeof o.id === "string" &&
    BATTLE_STATUSES.has(o.status) &&
    Array.isArray(o.participants)
  );
}

function invalidPayload(what: string): PublicApiError {
  return new PublicApiError(`respuesta con forma inválida en ${what}`, 200, "invalid_payload");
}

function defaultSourceErrorReport(err: { reason: SourceErrorReason; detail: string; consecutive: number }): void {
  // Reportable desde el Chromium del streamer (consola capturada) sin ensuciar la imagen.
  console.warn(`[broadcast] fuente: ${err.reason} (${err.consecutive} seguido/s): ${err.detail}`);
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
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, { method });
    } catch (e) {
      throw new PublicApiError(`red: ${(e as Error)?.message ?? String(e)} en ${method} ${path}`, 0, "network");
    }
    if (!res.ok) throw new PublicApiError(`HTTP ${res.status} en ${method} ${path}`, res.status, "http");
    try {
      return await res.json();
    } catch {
      // FIX-BROADCAST · p. ej. la web devolviendo su index.html en lugar de la API.
      throw new PublicApiError(`respuesta no JSON en ${method} ${path}`, res.status, "invalid_json");
    }
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
  /**
   * FIX-BROADCAST · fallos TRANSITORIOS seguidos tolerados antes de declarar
   * `SOURCE_ERROR` (por defecto 3: ~12 s con el sondeo de 4 s).
   */
  maxTransientFailures?: number;
  /**
   * FIX-BROADCAST (R2) · batalla programada validada por la API (`wait=scheduled`): mientras
   * NUNCA se haya visto, un 404 es «programada todavía no visible» ⇒ WAITING_VALID, hasta
   * `maxScheduledWaitMs` (por defecto 30 min); pasado el tope, 404 vuelve a ser
   * `target_not_found` (SOURCE_ERROR). Una vez vista, el 404 significa «terminó».
   */
  waitScheduled?: boolean;
  maxScheduledWaitMs?: number;
  /** Reloj inyectable (tests). */
  now?: () => number;
  /** FIX-BROADCAST · aviso reportable de cada error de la fuente (por defecto, console.warn). */
  onSourceError?: (err: { reason: SourceErrorReason; detail: string; consecutive: number }) => void;
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
  /** FIX-BROADCAST · fallos seguidos de la fuente. */
  private failures = 0;
  /** FIX-BROADCAST · última batalla vista (modo batalla): si deja de ser legible, terminó. */
  private lastSeenBattle: BattleSummary | null = null;
  /** FIX-BROADCAST (R2) · inicio de la espera de una programada (para el tope). */
  private readonly createdAt: number;

  constructor(opts: DirectorOptions) {
    this.opts = opts;
    this.createdAt = (opts.now ?? Date.now)();
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
    let screen: BroadcastScreen;
    try {
      screen = await this.computeScreen();
      this.failures = 0;
    } catch (e) {
      // FIX-BROADCAST · antes un `catch` vacío: un fallo PERMANENTE (la web devolviendo
      // index.html, un 404) dejaba «La batalla empieza en breve» para siempre. Ahora:
      //  - permanente ⇒ SOURCE_ERROR en el acto;
      //  - transitorio ⇒ se conserva la pantalla y se reintenta; con N seguidos, SOURCE_ERROR.
      // Se sigue sondeando siempre: si la fuente vuelve, la emisión se recupera sola.
      const c = classifySourceError(e);
      this.failures++;
      (this.opts.onSourceError ?? defaultSourceErrorReport)({
        reason: c.reason,
        detail: c.detail,
        consecutive: this.failures,
      });
      if (!c.permanent && this.failures < (this.opts.maxTransientFailures ?? 3)) return;
      screen = { kind: "error", reason: c.reason, detail: c.detail };
    }
    this.currentBattleId = screen.kind === "live" ? screen.battle.id : null;
    const sub =
      screen.kind === "live"
        ? screen.battle.id
        : screen.kind === "error"
          ? screen.reason
          : ((screen as { nextBattle?: BattleSummary | null }).nextBattle?.id ?? "");
    const key = `${screen.kind}:${sub}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.opts.onScreen(screen);
    }
  }

  private async computeScreen(): Promise<BroadcastScreen> {
    if (this.opts.target.kind === "battle") {
      let b: unknown;
      try {
        b = await this.opts.fetchJson(`/battles/${this.opts.target.battleId}`);
      } catch (e) {
        // FIX-BROADCAST · una batalla que SE VIO y deja de ser legible (404) terminó sin
        // replay público: es el final del destino, no un error de la fuente.
        if (this.lastSeenBattle && e instanceof PublicApiError && e.kind === "http" && e.status === 404) {
          return { kind: "finished", lastBattle: this.lastSeenBattle.status === "failed" ? null : this.lastSeenBattle };
        }
        // FIX-BROADCAST (R2) · 404 de una programada AÚN no visible (la API validó la espera al
        // iniciar): espera legítima, se reintenta hasta que empiece o venza el tope.
        if (
          !this.lastSeenBattle &&
          this.opts.waitScheduled &&
          e instanceof PublicApiError &&
          e.kind === "http" &&
          e.status === 404 &&
          (this.opts.now ?? Date.now)() - this.createdAt < (this.opts.maxScheduledWaitMs ?? 30 * 60_000)
        ) {
          return { kind: "waiting", nextBattle: null };
        }
        throw e;
      }
      if (!validBattle(b)) throw invalidPayload("/battles/{id}");
      this.lastSeenBattle = b;
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
    if (!page || typeof page !== "object" || !Array.isArray(page.items) || !page.items.every(validBattle)) {
      throw invalidPayload("/tournaments/{id}/battles");
    }
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
