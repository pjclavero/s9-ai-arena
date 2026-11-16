/**
 * T11.1 · Director de emisión: decide QUÉ pantalla muestra /broadcast a partir
 * del estado PÚBLICO del torneo (E9 escribe batallas; aquí solo se leen por la
 * API pública de visitante). Regla de oro del cap. 21: el streaming no toca el
 * motor ni el tick — este módulo solo hace GET anónimos y consume el canal de
 * espectador como un cliente más.
 *
 * La decisión (`decideScreen`) es una función PURA y probada; el `BroadcastDirector`
 * solo añade el sondeo con reloj/fetch inyectables.
 *
 * FIX-DIRECTOR-DELAY · Con línea temporal (`timeline`, siempre en la página), la API REAL
 * sólo sirve para DESCUBRIR qué batallas existen; cada transición visible (inicio, fin,
 * cambio de batalla, fin del torneo, marcador, cabecera) sale de la proyección retrasada
 * (`projectDelayedTimeline`) que manda el feed retrasado del gateway:
 *   COMPETICIÓN REAL → LÍNEA TEMPORAL PÚBLICA RETRASADA → DIRECTOR → RENDER.
 */
import type { FeedStatus, PublicTimeline } from "./delayed-timeline.js";

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
  | {
      kind: "waiting";
      nextBattle: BattleSummary | null;
      /**
       * FIX-DIRECTOR-DELAY · aviso «directo con retardo de N s» (ms): sólo en la espera INICIAL
       * (nada emitido todavía) y sólo cuando un feed seguido ya anunció su retardo y aún no
       * trae contenido retrasado. Es el aviso aceptado de la secuencia WAITING → aviso → LIVE.
       */
      delayNoticeMs?: number;
    }
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

// ─────────────────────────── FIX-DIRECTOR-DELAY · proyección de la línea temporal retrasada

/** Estado REAL de una batalla para la proyección; `gone` = el sondeo ya no la lista (o 404). */
export type RealBattleStatus = BattleSummary["status"] | "gone";

/** Estado de una batalla en el mundo RETRASADO; `hidden` = un visitante aún no la vería. */
export type DelayedBattleStatus = BattleSummary["status"] | "hidden";

/** Una batalla terminada en el mundo retrasado se ve como la vería un visitante en ese momento. */
function delayedEndOf(real: RealBattleStatus): DelayedBattleStatus {
  if (real === "failed") return "failed";
  // Ausente de la lista real (p. ej. replays públicos apagados): tampoco se vería retrasada.
  if (real === "gone") return "hidden";
  return "finished";
}

/**
 * FIX-DIRECTOR-DELAY · Estado de UNA batalla en la línea temporal pública retrasada. El feed
 * retrasado del gateway manda; el estado real de la API sólo dice qué existe:
 *  - fin retrasado ya visto (`ended`, o feed `ended`) ⇒ terminada, AUNQUE la API aún diga
 *    `running` (con retardo 0 el `result` del WS puede adelantarse a la fila);
 *  - feed `playing` ⇒ en directo, AUNQUE la API ya diga `finished` o la haya retirado;
 *  - feed `connecting`/`pending`/`unavailable` (no hay contenido retrasado AHORA):
 *      · si la batalla ya salió en antena (`playedEver`: su feed llegó a `playing`), sigue en
 *        directo —ni parpadeo a «espera» ni fin—: un corte de transporte no es un evento de la
 *        competición. Cuánto puede durar eso lo acota el director (cota de fallback);
 *      · si nunca emitió, OCULTA: ni LIVE ni fin. La fila real NUNCA pone una batalla en antena
 *        ni la termina (Ronda 2, P1-1: el 4404 de la carrera ticket→attach ya no es «en curso»
 *        y un feed caído tras el fin real ya no es «terminada»);
 *  - sin seguir: en curso real ⇒ oculta (aún no se sabe dónde va su retardo); terminada real ⇒
 *    oculta salvo que ya estuviera resuelta al arrancar el director (`resolvedAtStart`).
 */
export function projectBattleStatus(
  real: RealBattleStatus,
  feed: FeedStatus | undefined,
  ended: boolean,
  resolvedAtStart: boolean,
  playedEver = false,
): DelayedBattleStatus {
  if (ended) return delayedEndOf(real);
  if (real === "scheduled") return "scheduled";
  if (feed) {
    switch (feed.phase) {
      case "playing":
        return "running";
      case "ended":
        return delayedEndOf(real);
      case "unavailable":
      case "connecting":
      case "pending":
        return playedEver ? "running" : "hidden";
    }
  }
  if (resolvedAtStart) return real === "gone" ? "hidden" : real;
  return "hidden";
}

export interface DelayedProjectionInput {
  /**
   * Batallas en orden de juego (orden de aparición: ASC por creación) con su estado REAL;
   * `gone` = ya vista y el sondeo ha dejado de listarla.
   */
  battles: { battle: BattleSummary; real: RealBattleStatus }[];
  /** Estado REAL del torneo. */
  state: string | null;
  feed: (battleId: string) => FeedStatus | undefined;
  /** Batallas cuyo fin retrasado ya se vio. */
  ended: ReadonlySet<string>;
  /** Terminadas que ya lo estaban (y no eran la última) al arrancar el director. */
  resolvedAtStart: ReadonlySet<string>;
  /** Batallas cuyo feed llegó alguna vez a `playing` (ya salieron en antena). */
  playedEver?: ReadonlySet<string>;
}

export interface DelayedProjection {
  battles: BattleSummary[];
  state: string | null;
  /** Batallas cuyo final retrasado aún no se ha emitido (bloquean el fin público del torneo). */
  unresolved: string[];
}

/**
 * FIX-DIRECTOR-DELAY · Proyección PURA de la competición real a la línea temporal pública
 * retrasada: la lista y el estado del torneo tal como los vería un visitante en
 * `ahora − retardo`. Sobre ella se aplican las MISMAS decideScreen/applyTournamentState de
 * siempre: la lógica de pantallas no cambia, cambia su entrada.
 *
 * Anti-coaching (A5): una batalla que la proyección da en curso sale SIN `result` ni
 * `outcome` (aunque la fila real ya los tenga), y el torneo sólo está cerrado cuando no queda
 * ninguna batalla pendiente de emitirse: ni marcador, ni ganador, ni total, ni pantalla final
 * antes de que el feed retrasado llegue a su final.
 */
export function projectDelayedTimeline(i: DelayedProjectionInput): DelayedProjection {
  const out: BattleSummary[] = [];
  const unresolved: string[] = [];
  for (const { battle: b, real } of i.battles) {
    const isEnded = i.ended.has(b.id);
    const atStart = i.resolvedAtStart.has(b.id);
    const p = projectBattleStatus(real, i.feed(b.id), isEnded, atStart, i.playedEver?.has(b.id) ?? false);
    const settled = isEnded || atStart || real === "scheduled";
    if (p === "hidden") {
      // Ronda 2 · un feed no disponible YA NO resuelve la batalla por sí solo (la resolvía con
      // la fila real): sólo el fin retrasado visto, o la cota de fallback del director (`ended`).
      if (!settled && i.feed(b.id)?.phase !== "ended") unresolved.push(b.id);
      continue;
    }
    if (p === "running") {
      unresolved.push(b.id);
      out.push({
        ...b,
        status: "running",
        result: undefined,
        participants: b.participants.map(({ outcome: _outcome, ...rest }) => rest),
      });
      continue;
    }
    out.push(p === b.status ? b : { ...b, status: p });
  }
  const closed = i.state !== null && CLOSED_TOURNAMENT_STATES.has(i.state);
  // Torneo cerrado en real con batallas aún por emitir ⇒ en el mundo retrasado sigue en curso.
  const state = closed && unresolved.length > 0 ? "running" : i.state;
  return { battles: out, state, unresolved };
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
  /**
   * FIX-DIRECTOR-DELAY · línea temporal pública retrasada (el feed del gateway). La página la
   * pasa SIEMPRE: con ella toda transición visible respeta `spectatorDelay`. Sin ella el
   * director decide con el estado real de la API; sólo lo usan los tests de esa lógica.
   */
  timeline?: PublicTimeline;
  /** FIX-DIRECTOR-DELAY · feeds seguidos a la vez como máximo (en antena + siguiente). Def. 2. */
  maxTrackedFeeds?: number;
  /**
   * FIX-DIRECTOR-DELAY · ms mínimos entre reintentos de un feed NO disponible (def. 15 s) y
   * reintentos máximos por batalla (def. 8). La carrera ticket→attach la reintenta antes la
   * propia línea temporal (4404 previo al init).
   */
  feedRetryMs?: number;
  maxFeedRetries?: number;
  /**
   * Ronda 2 · retardo que se supone a una batalla cuyo feed nunca anunció el suyo (p. ej. nunca
   * se pudo conectar), para la cota de fallback. Def. el máximo que admite el servidor
   * (`RULES_LIMITS.delaySeconds.max`): sobreestimarlo sólo retrasa, nunca adelanta.
   */
  fallbackDelayMs?: number;
  /**
   * Ronda 2 · margen sobre la cota de fallback para un feed que PARECE sano (conectado, sin
   * `result`) pero cuya batalla la API ya no da en curso: techo contra un feed atascado sin
   * señal. Def. 15 s. Con un feed que funciona nunca llega: su fin retrasado es anterior.
   */
  stallMarginMs?: number;
}

/**
 * Máximo `spectator.delaySeconds` que acepta el servidor (packages/game-rules
 * `RULES_LIMITS.delaySeconds.max`, en ms). Un test ata este valor al de las reglas.
 */
export const MAX_SPECTATOR_DELAY_MS = 30_000;

/** Lectura REAL de la API en un ciclo de sondeo. */
type RealView =
  | { kind: "tournament"; battles: BattleSummary[]; state: string | null }
  /** `battle` null = programada aún no visible (wait=scheduled); `gone` = se vio y ya no es legible. */
  | { kind: "battle"; battle: BattleSummary | null; gone: boolean };

/**
 * Sondea el estado por la API PÚBLICA (visitor: listTournamentBattles/getBattle, cap. 16)
 * y emite pantallas solo cuando cambian (`kind` o batalla). El avance automático
 * a la siguiente batalla del torneo (DoD T11.1) sale solo de aquí: cuando la
 * batalla en directo termina, la siguiente toma el relevo tras la pantalla de
 * intermedio. FIX-DIRECTOR-DELAY · con `timeline`, «termina» y «empieza» son los del feed
 * RETRASADO, nunca los de la fila real.
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

  // ── FIX-DIRECTOR-DELAY · memoria de la línea temporal retrasada
  /** Orden de los ciclos (sondeo + avisos del feed): un ciclo viejo nunca pisa a uno nuevo. */
  private tickSeq = 0;
  private appliedSeq = 0;
  /** Batallas cuyo fin RETRASADO ya se vio. */
  private readonly ended = new Set<string>();
  /** Terminadas ya resueltas al arrancar (todas menos la última terminada visible). */
  private resolvedAtStart: Set<string> | null = null;
  /** Toda batalla vista, en orden de aparición (las que el sondeo deja de listar siguen aquí). */
  private readonly seen = new Map<string, BattleSummary>();
  /** Reintentos hechos del feed no disponible de cada batalla. */
  private readonly feedRetries = new Map<string, number>();
  /** Batallas cuyo feed llegó alguna vez a `playing` (ya salieron en antena). */
  private readonly playedEver = new Set<string>();
  /** Retardo anunciado por el feed de cada batalla (ms). */
  private readonly delayOf = new Map<string, number>();
  /**
   * Ronda 2 · hora LOCAL del primer sondeo en que la API dejó de dar la batalla en curso
   * (terminada, fallida o retirada). Es POSTERIOR al fin real, así que `+ retardo` es una cota
   * SUPERIOR del fin retrasado: ver `fallbackExpired`.
   */
  private readonly notRunningSince = new Map<string, number>();
  /** ¿Ya se emitió alguna batalla en directo? (el aviso de retardo sólo sustituye a la espera inicial) */
  private everLive = false;
  private unsubscribeTimeline: (() => void) | null = null;

  constructor(opts: DirectorOptions) {
    this.opts = opts;
    this.createdAt = (opts.now ?? Date.now)();
    // Un cambio de fase del feed retrasado (empieza, termina) se aplica en el acto, sin
    // esperar al siguiente sondeo: es la línea temporal la que marca el paso. Se re-lee la
    // API (sólo para saber qué existe): con retardo 0 la secuencia es la de siempre.
    this.unsubscribeTimeline = opts.timeline?.onChange(() => void this.tick()) ?? null;
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
    this.unsubscribeTimeline?.();
    this.unsubscribeTimeline = null;
  }

  /** Un ciclo de sondeo. Público para poder probarlo sin relojes. */
  async tick(): Promise<void> {
    const seq = ++this.tickSeq;
    let screen: BroadcastScreen;
    try {
      const real = await this.readReal();
      if (seq < this.appliedSeq) return; // un ciclo posterior ya decidió con datos más nuevos
      this.appliedSeq = seq;
      screen = this.screenFor(real);
      this.failures = 0;
    } catch (e) {
      if (seq < this.appliedSeq) return;
      this.appliedSeq = seq;
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
    this.show(screen);
  }

  private show(screen: BroadcastScreen): void {
    this.currentBattleId = screen.kind === "live" ? screen.battle.id : null;
    if (screen.kind === "live") this.everLive = true;
    const sub =
      screen.kind === "live"
        ? screen.battle.id
        : screen.kind === "error"
          ? screen.reason
          : ((screen as { nextBattle?: BattleSummary | null }).nextBattle?.id ?? "");
    let key = `${screen.kind}:${sub}`;
    if (this.opts.timeline) {
      // Con la línea temporal también cambian la última batalla mostrada y el aviso de retardo.
      const last = (screen as { lastBattle?: BattleSummary | null }).lastBattle?.id ?? "";
      const notice = screen.kind === "waiting" ? (screen.delayNoticeMs ?? "") : "";
      key += `:${last}:${notice}`;
    }
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.opts.onScreen(screen);
    }
  }

  private screenFor(real: RealView): BroadcastScreen {
    if (this.opts.timeline) return this.delayedScreenFor(real, this.opts.timeline);
    // Sin línea temporal: decisiones con el estado real (tests de la lógica de la API).
    if (real.kind === "battle") {
      const b = real.gone ? this.lastSeenBattle : real.battle;
      if (!b) return { kind: "waiting", nextBattle: null };
      if (real.gone) return { kind: "finished", lastBattle: b.status === "failed" ? null : b };
      if (b.status === "running") return { kind: "live", battle: b };
      if (b.status === "scheduled") return { kind: "waiting", nextBattle: b };
      return { kind: "finished", lastBattle: b.status === "finished" ? b : null };
    }
    return applyTournamentState(decideScreen(real.battles, this.currentBattleId), real.state);
  }

  // ───────────────────────────── FIX-DIRECTOR-DELAY · decisiones con la línea temporal

  private delayedScreenFor(real: RealView, timeline: PublicTimeline): BroadcastScreen {
    const visible: BattleSummary[] =
      real.kind === "tournament" ? real.battles : real.battle && !real.gone ? [real.battle] : [];
    if (real.kind === "battle" && real.gone && this.lastSeenBattle) this.remember(this.lastSeenBattle);
    for (const b of visible) this.remember(b);
    if (this.resolvedAtStart === null) {
      // Al arrancar: las terminadas visibles ya están resueltas salvo la ÚLTIMA (su cola
      // retrasada puede seguir emitiéndose: se sondea por el WS). En modo batalla, ninguna.
      const done =
        real.kind === "tournament" ? visible.filter((b) => b.status !== "running" && b.status !== "scheduled") : [];
      const lastFinished = [...done].reverse().find((b) => b.status === "finished");
      this.resolvedAtStart = new Set(done.filter((b) => b !== lastFinished).map((b) => b.id));
    }
    const realStatus = new Map<string, RealBattleStatus>(visible.map((b) => [b.id, b.status]));
    const statusOf = (id: string): RealBattleStatus => realStatus.get(id) ?? "gone";

    // 0 · Memoria de la competición real (sólo para la cota de fallback, nunca para el camino
    //     nominal): desde cuándo la API dejó de dar cada batalla en curso.
    const now = (this.opts.now ?? Date.now)();
    for (const b of this.seen.values()) {
      const r = statusOf(b.id);
      if (r === "running" || r === "scheduled") this.notRunningSince.delete(b.id);
      else if (!this.notRunningSince.has(b.id)) this.notRunningSince.set(b.id, now);
    }

    // 1 · Fin retrasado: lo marca el FEED (result retrasado / init con el fin vencido). Si el
    //     feed NO está sano (no disponible, sin conectar o caído), ningún dato real lo sustituye:
    //     la batalla sólo se da por terminada al vencer la cota de fallback (fin real observado +
    //     retardo anunciado), que nunca se adelanta al fin retrasado. Con el feed en apariencia
    //     sano la cota lleva además un margen (`stallMarginMs`): sólo salta si el feed se atascó
    //     sin dar señal (latidos sin contenido ni `result`), nunca antes que un feed que funciona.
    for (const id of timeline.tracked()) {
      const st = timeline.status(id);
      if (!st) continue;
      if (st.delayMs !== null) this.delayOf.set(id, st.delayMs);
      if (st.phase === "playing") this.playedEver.add(id);
      if (st.phase === "ended") {
        this.ended.add(id);
        timeline.release(id);
        continue;
      }
      const degraded = st.phase === "unavailable" || st.phase === "connecting" || st.lost;
      if (this.fallbackExpired(id, now, degraded ? 0 : (this.opts.stallMarginMs ?? 15_000))) {
        this.ended.add(id);
        timeline.release(id);
        continue;
      }
      const tries = this.feedRetries.get(id) ?? 0;
      if (
        st.phase === "unavailable" &&
        now - st.sinceMs >= (this.opts.feedRetryMs ?? 15_000) &&
        tries < (this.opts.maxFeedRetries ?? 8)
      ) {
        this.feedRetries.set(id, tries + 1);
        timeline.release(id);
        timeline.track(id);
      }
    }

    // 2 · Qué feeds seguir: la batalla en antena y la siguiente candidata (la candidata se
    //     conecta antes, SIN pintarla, para saber cuándo empieza SU contenido retrasado).
    const max = Math.max(1, this.opts.maxTrackedFeeds ?? 2);
    const active = timeline.tracked();
    const unresolvedSeen = [...this.seen.values()].filter(
      (b) => !this.ended.has(b.id) && !this.resolvedAtStart!.has(b.id) && b.status !== "scheduled",
    );
    const want = [
      ...(this.currentBattleId ? [this.currentBattleId] : []),
      ...visible.filter((b) => b.status === "running").map((b) => b.id),
      ...unresolvedSeen.filter((b) => statusOf(b.id) !== "running").map((b) => b.id),
    ];
    for (const id of want) {
      if (active.length >= max) break;
      if (this.ended.has(id) || active.includes(id)) continue;
      timeline.track(id);
      active.push(id);
    }

    // 3 · Proyección retrasada y las MISMAS reglas de pantalla de siempre.
    const feed = (id: string) => timeline.status(id);
    // Todas las vistas, en orden de aparición: las que el sondeo ya no lista siguen en su sitio.
    const rows = [...this.seen.values()].map((b) => ({ battle: b, real: statusOf(b.id) }));
    const proj = projectDelayedTimeline({
      battles: rows,
      state: real.kind === "tournament" ? real.state : null,
      feed,
      ended: this.ended,
      resolvedAtStart: this.resolvedAtStart,
      playedEver: this.playedEver,
    });

    let screen: BroadcastScreen;
    if (real.kind === "battle") {
      const b = proj.battles[0] ?? null;
      const target = real.battle ?? this.lastSeenBattle;
      if (!target) screen = { kind: "waiting", nextBattle: null };
      else if (b?.status === "running") screen = { kind: "live", battle: b };
      else if (b?.status === "scheduled") screen = { kind: "waiting", nextBattle: b };
      else if (this.ended.has(target.id) || b?.status === "finished" || b?.status === "failed")
        screen = { kind: "finished", lastBattle: target.status === "failed" ? null : (b ?? target) };
      else screen = { kind: "waiting", nextBattle: null };
    } else {
      screen = applyTournamentState(decideScreen(proj.battles, this.currentBattleId), proj.state);
    }

    // 4 · Aviso de retardo: sólo en la espera INICIAL, con un feed que ya anunció su retardo
    //     y aún no trae contenido retrasado.
    if (screen.kind === "waiting" && !this.everLive) {
      const notice = Math.max(
        0,
        ...timeline
          .tracked()
          .map((id) => timeline.status(id))
          .filter((st): st is FeedStatus => st?.phase === "pending")
          .map((st) => st.delayMs ?? 0),
      );
      if (notice > 0) screen = { ...screen, delayNoticeMs: notice };
    }
    return screen;
  }

  /**
   * Ronda 2 · cota de FALLBACK (sólo con el feed no sano). `notRunningSince` es la hora local del
   * primer sondeo que vio la batalla fuera de `running`, POSTERIOR al fin real (el motor termina,
   * el worker escribe la fila y después la sondeamos), y el gateway emite el `result` retrasado
   * en «fin real + retardo». Así que `notRunningSince + retardo` es ≥ que el fin retrasado: la
   * cota sólo puede llegar DESPUÉS que el feed (como mucho un sondeo), nunca antes. Usa un único
   * reloj (el local) y una duración (el retardo anunciado; si no se conoce, el máximo del
   * servidor), así que no compara relojes de máquinas distintas. Y no es un segundo reloj que
   * derive del feed: con el feed sano el feed llega antes (la cota es ≥ su fin y además lleva
   * `stallMarginMs`), así que sólo decide cuando el feed no puede (o se atascó).
   */
  private fallbackExpired(id: string, now: number, marginMs: number): boolean {
    const since = this.notRunningSince.get(id);
    if (since === undefined) return false; // la API la sigue dando en curso: no hay fin que acotar
    const delay = this.delayOf.get(id) ?? this.opts.fallbackDelayMs ?? MAX_SPECTATOR_DELAY_MS;
    return now >= since + delay + marginMs;
  }

  private remember(b: BattleSummary): void {
    // El orden de aparición se conserva (Map): la primera vez fija la posición.
    this.seen.set(b.id, b);
  }

  private async readReal(): Promise<RealView> {
    if (this.opts.target.kind === "battle") {
      let b: unknown;
      try {
        b = await this.opts.fetchJson(`/battles/${this.opts.target.battleId}`);
      } catch (e) {
        // FIX-BROADCAST · una batalla que SE VIO y deja de ser legible (404) terminó sin
        // replay público: es el final del destino, no un error de la fuente.
        if (this.lastSeenBattle && e instanceof PublicApiError && e.kind === "http" && e.status === 404) {
          return { kind: "battle", battle: null, gone: true };
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
          return { kind: "battle", battle: null, gone: false };
        }
        throw e;
      }
      if (!validBattle(b)) throw invalidPayload("/battles/{id}");
      this.lastSeenBattle = b;
      return { kind: "battle", battle: b, gone: false };
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
    return { kind: "tournament", battles: page.items, state };
  }

  /**
   * Estado del torneo por `GET /tournaments/{id}` (getTournament, visitor, anónimo).
   * Entra en la MISMA contabilidad de fallos que el resto de consultas: NO se traga nada.
   * Un fallo transitorio se propaga (tick ⇒ reintento; N seguidos ⇒ SOURCE_ERROR), uno
   * permanente (404 «torneo no encontrado», forma inválida) ⇒ SOURCE_ERROR en el acto.
   * Nunca se trata «no encontrado» como torneo abierto.
   */
  private async tournamentState(): Promise<string | null> {
    if (this.opts.target.kind !== "tournament") return null;
    const t = (await this.opts.fetchJson(`/tournaments/${encodeURIComponent(this.opts.target.tournamentId)}`)) as {
      state?: unknown;
    } | null;
    if (!t || typeof t !== "object" || typeof t.state !== "string") throw invalidPayload("/tournaments/{id}");
    return t.state;
  }
}
