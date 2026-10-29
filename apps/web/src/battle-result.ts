/**
 * FC-D (D7) · Lectura TOLERANTE del contrato BATTLE_RESULT para la UI.
 *
 * Fuente (contrato de DEV-B, COORD 2026-10-16): `battles.result` =
 * `{ schema:"battle-result/v1", winner:<team>|"draw", ticks, score:{<team>:n},
 * disqualified:[botId], endReason:"completed"|"walkover"|"sporting_failure",
 * agents:"container"|"in_process_stub"|"scripted" }`; `participants[].outcome`
 * (win|loss|draw|disqualified) y `cpuMs`; `failureKind`
 * (none|bot_timeout|bot_crash|infrastructure); `startedAt`, `finishedAt`,
 * `replayAvailable`, `replayHash`. La base 0b8c12b aún escribe la forma previa
 * `{ winner, ticks, score, disqualified }` sin esos campos: se LEE lo que haya y
 * se omite lo que falte. La UI nunca inventa un ganador.
 */

export interface BattleLike {
  id: string;
  status: string;
  participants?: { botId: string; version: number; team?: string; outcome?: string }[];
  result?: unknown;
  failureKind?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  replayRef?: string | null;
  replayHash?: string | null;
  /** B: true/false cuando la API lo expone. */
  replayAvailable?: boolean;
}

export interface BattleSummaryView {
  /** Texto del resultado: «gana rojo», «empate», o null si aún no hay resultado. */
  outcome: string | null;
  /** Marcador `equipo: puntos` si viene. */
  score: string | null;
  /** Duración: por ticks del motor (30/s) o por timestamps. */
  duration: string | null;
  /** Fallo REAL (failureKind distinto de none). `none` no es un error. */
  failure: string | null;
  /** Participantes descalificados. */
  disqualified: string[];
  /** Hay replay que abrir. */
  hasReplay: boolean;
  /** Motivo de fin distinto de una partida normal (walkover, fallo deportivo). */
  endReason: string | null;
  /** Aviso cuando los bots NO fueron contenedores reales (stub/scripted). */
  agentsNote: string | null;
}

const TICK_HZ = 30;

const FAILURE_TEXT: Record<string, string> = {
  bot_timeout: "un bot no respondió a tiempo",
  bot_crash: "un bot se cayó",
  infrastructure: "fallo de infraestructura",
};

const END_REASON_TEXT: Record<string, string> = {
  walkover: "por incomparecencia",
  sporting_failure: "por fallo deportivo",
};

const AGENTS_TEXT: Record<string, string> = {
  in_process_stub: "bots simulados (stub)",
  scripted: "bots guionizados",
};

function fmtSeconds(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * UX-F (DEF-R6) · el bando en palabras, como en el selector de «Nueva batalla»
 * (rojo/azul). Los equipos de torneo (A, B…) se dejan tal cual.
 */
const TEAM_TEXT: Record<string, string> = { red: "rojo", blue: "azul" };
export function teamText(team: string | null | undefined): string {
  if (!team) return "—";
  return Object.hasOwn(TEAM_TEXT, team) ? TEAM_TEXT[team] : team;
}

export function summarizeBattle(b: BattleLike): BattleSummaryView {
  const r = (b.result && typeof b.result === "object" ? b.result : {}) as Record<string, unknown>;
  const winner = (r.winner ?? null) as string | null;
  let outcome: string | null = null;
  if (b.status === "finished") {
    if (winner && winner !== "draw") outcome = `gana ${teamText(winner)}`;
    else if (winner === "draw" || (b.participants ?? []).some((p) => p.outcome === "draw")) outcome = "empate";
    else {
      const wins = (b.participants ?? []).filter((p) => p.outcome === "win");
      outcome =
        wins.length > 0
          ? `gana ${wins.map((p) => (p.team ? teamText(p.team) : p.botId.slice(0, 8))).join(", ")}`
          : "sin ganador";
    }
  }
  let score: string | null = null;
  if (r.score && typeof r.score === "object") {
    const entries = Object.entries(r.score as Record<string, unknown>);
    if (entries.length > 0) score = entries.map(([t, n]) => `${teamText(t)}: ${String(n)}`).join(" · ");
  }
  let duration: string | null = null;
  const ticks = Number(r.ticks);
  if (Number.isFinite(ticks) && ticks > 0) duration = fmtSeconds(ticks / TICK_HZ);
  else if (b.startedAt && b.finishedAt) {
    const ms = Date.parse(b.finishedAt) - Date.parse(b.startedAt);
    if (Number.isFinite(ms) && ms >= 0) duration = fmtSeconds(ms / 1000);
  }
  const fk = b.failureKind ?? null;
  const failure = fk && fk !== "none" ? (FAILURE_TEXT[fk] ?? fk) : null;
  const disqualified = Array.isArray(r.disqualified) ? (r.disqualified as unknown[]).map(String) : [];
  // `replayAvailable` (B) manda; si la API no lo expone, `replayRef` null ⇒ no
  // hay replay; ausente ⇒ se ofrece el enlace y el reproductor dirá si no existe.
  const hasReplay =
    b.status === "finished" && (typeof b.replayAvailable === "boolean" ? b.replayAvailable : b.replayRef !== null);
  const er = typeof r.endReason === "string" ? r.endReason : null;
  const endReason = er && er !== "completed" ? (END_REASON_TEXT[er] ?? er) : null;
  const ag = typeof r.agents === "string" ? r.agents : null;
  const agentsNote = ag && ag !== "container" ? (AGENTS_TEXT[ag] ?? ag) : null;
  return { outcome, score, duration, failure, disqualified, hasReplay, endReason, agentsNote };
}

// ---------------------------------------------------------------- UX-D · D1/D3
// Textos para que el usuario no vea UUIDs, `veh_1` ni códigos del motor.

/** Participante tal como lo devuelve la API (UX-D: con nombre de bot). */
export interface ParticipantLike {
  botId: string;
  botName?: string;
  version: number;
  team?: string;
  outcome?: string;
}

/** Nombre del bot; si la API no lo trae (batalla antigua), el prefijo del id. */
export function botLabel(p: { botId: string; botName?: string }): string {
  return p.botName && p.botName.trim() ? p.botName : `bot ${p.botId.slice(0, 8)}`;
}

/** «nombre v3»: la versión EXACTA que jugó, no la última del bot. */
export function botVersionLabel(p: ParticipantLike): string {
  return `${botLabel(p)} v${p.version}`;
}

export const MODE_TEXT: Record<string, string> = {
  deathmatch: "todos contra todos",
  team_deathmatch: "por equipos",
  capture_the_flag: "captura la bandera",
  zone_control: "control de zona",
};

/**
 * UX-R · Nombre del modo en los SELECTORES (crear batalla, torneos, ranking):
 * el mismo en todas las pantallas, nunca el identificador crudo
 * (`team_deathmatch`). Un modo desconocido se muestra tal cual.
 */
export const MODE_NAME: Record<string, string> = {
  deathmatch: "Deathmatch",
  team_deathmatch: "Deathmatch por equipos",
  capture_the_flag: "Captura la bandera",
  zone_control: "Control de zona",
};

export function modeName(mode: string): string {
  return labelOf(MODE_NAME, mode);
}

/** UX-R · Formato, estado de torneo y estado de partido del cuadro, en palabras. */
export const TOURNAMENT_FORMAT_NAME: Record<string, string> = {
  league: "Liga",
  round_robin: "Todos contra todos (liguilla)",
  single_elimination: "Eliminación directa",
  double_elimination: "Doble eliminación",
  swiss: "Sistema suizo",
  teams: "Por equipos",
};
export const TOURNAMENT_STATE_NAME: Record<string, string> = {
  draft: "borrador",
  open: "inscripciones abiertas",
  closed: "inscripciones cerradas",
  running: "en juego",
  finished: "terminado",
  cancelled: "cancelado",
};
export const MATCH_STATE_NAME: Record<string, string> = {
  scheduled: "pendiente",
  running: "en juego",
  finished: "terminado",
  failed: "falló",
};

/** Busca `key` en una tabla de etiquetas; si no está, devuelve el valor tal cual. */
export function labelOf(table: Record<string, string>, key: string): string {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
}

export const OUTCOME_TEXT: Record<string, string> = {
  win: "gana",
  loss: "pierde",
  draw: "empate",
  disqualified: "descalificado",
};

/**
 * Ganador con NOMBRES: «gana rojo (Tanque A v2)». Sin resultado, null. Con un solo
 * bot por equipo, el nombre del bot es lo que el usuario reconoce, no el color.
 */
export function winnerText(b: BattleLike & { participants?: ParticipantLike[] }): string | null {
  const v = summarizeBattle(b);
  if (!v.outcome) return null;
  const r = (b.result && typeof b.result === "object" ? b.result : {}) as Record<string, unknown>;
  const winner = typeof r.winner === "string" ? r.winner : null;
  if (!winner || winner === "draw") return v.outcome;
  const bots = (b.participants ?? []).filter((p) => p.team === winner).map(botVersionLabel);
  return bots.length > 0 ? `gana ${teamText(winner)} (${bots.join(", ")})` : v.outcome;
}

/** Qué mide `perModule.uses` (contrato de replay-service/src/stats.ts, UX-D). */
export const USES_KIND_TEXT: Record<string, string> = {
  shots: "disparos",
  mines: "minas desplegadas",
  move_commands: "órdenes de movimiento",
  radio_messages: "mensajes de radio",
  passive: "pasivo (actúa solo)",
};

/** Motivos de rechazo del motor (event.schema.json · reason). */
const REJECTION_TEXT: Record<string, string> = {
  cooldown: "arma en enfriamiento (cadencia)",
  no_ammo: "sin munición",
  no_energy: "sin energía",
  out_of_arc: "fuera del arco de la torreta",
  module_destroyed: "módulo destruido",
  invalid_position: "posición no válida",
  rate_limited: "demasiados mensajes de radio",
  too_large: "mensaje de radio demasiado grande",
  queue_full: "cola de radio llena",
  no_radio: "sin módulo de radio",
  out_of_range: "fuera de alcance",
  extra_command_discarded: "más de un COMMAND en el mismo ciclo",
  unknown: "motivo no informado",
};

export function rejectionText(reason: string): string {
  return Object.hasOwn(REJECTION_TEXT, reason) ? REJECTION_TEXT[reason] : reason.replace(/_/g, " ");
}

/** Por qué se descalificó a un bot (API: diagnostics[].disqualifiedReason). */
const DQ_REASON_TEXT: Record<string, string> = {
  consecutive_timeouts: "demasiados turnos seguidos sin responder a tiempo",
  bot_execution_timeout: "no llegó a conectarse (HELLO) dentro del plazo de arranque",
  bot_crash: "el proceso del bot falló al arrancar",
  // UX-F (DEF-R4) · antes esto llegaba como bot_crash («el proceso falló»).
  hook_missing:
    "tu clase no implementa on_observation (Python) / onObservation (JavaScript): sin él el bot no decide nada",
  startup_failed: "no arrancó",
  administrative: "versión no jugable, suspendida o artefacto no verificado (antes de empezar)",
  unknown: "motivo no registrado",
};

export function dqReasonText(reason: string | null | undefined): string {
  if (!reason) return DQ_REASON_TEXT.unknown;
  return Object.hasOwn(DQ_REASON_TEXT, reason) ? DQ_REASON_TEXT[reason] : reason.replace(/_/g, " ");
}

/** Ticks del motor (30/s) a «m:ss». */
export function ticksToClock(ticks: number): string {
  return fmtSeconds(ticks / TICK_HZ);
}

// ---------------------------------------------------------------- 4v4 · por bando

/** Orden estable de bandos: rojo, azul y el resto por nombre (mismo criterio que el visor). */
function sideRank(t: string): number {
  return t === "red" ? 0 : t === "blue" ? 1 : 2;
}

/**
 * 4v4 · Orden estable de nombres DENTRO de un bando (numérico: «A-2» antes que
 * «A-10»). La API no garantiza el orden de los participantes (se leen sin ORDER BY):
 * sin esto el mismo 4v4 se titulaba distinto en cada recarga.
 */
export function byName(a: string, b: string): number {
  return a.localeCompare(b, "es", { numeric: true });
}

/** Participantes agrupados por BANDO (`team`), en orden estable; sin bando, al final. */
export function groupBySide<T extends { team?: string }>(ps: T[]): { team: string | null; items: T[] }[] {
  const map = new Map<string, T[]>();
  for (const p of ps) {
    const k = p.team ?? "";
    const list = map.get(k) ?? [];
    list.push(p);
    map.set(k, list);
  }
  const keys = [...map.keys()].filter((k) => k !== "");
  keys.sort((a, b) => sideRank(a) - sideRank(b) || a.localeCompare(b));
  const out: { team: string | null; items: T[] }[] = keys.map((k) => ({ team: k, items: map.get(k)! }));
  if (map.has("")) out.push({ team: null, items: map.get("")! });
  return out;
}

/**
 * 4v4-FIX · Participantes en el MISMO orden que «Resultado por bando»: bandos en
 * orden estable (rojo, azul, resto) y, dentro, por nombre y versión. Lo usan las
 * tablas del detalle (participantes, estadísticas, radio) para no listar los bots
 * en el orden arbitrario de la API mientras el resumen va por bandos.
 */
export function participantsBySide<T extends ParticipantLike>(ps: T[]): T[] {
  return groupBySide(ps).flatMap((g) => [...g.items].sort((a, b) => byName(botVersionLabel(a), botVersionLabel(b))));
}

/**
 * 4v4 · Título de una batalla. Con un bot por bando se mantiene «Alfa vs Beta»
 * (`withSide` añade « (rojo)»). Si algún bando lleva varios bots se agrupa por
 * bando: «A-ATK-1, A-ATK-2, A-ATK-3, A-ATK-4 (rojo) vs B-DEF-1, … (azul)».
 */
export function sidesTitle<T extends { team?: string }>(
  ps: T[],
  label: (p: NoInfer<T>) => string,
  opts: { withSide?: boolean } = {},
): string {
  const groups = groupBySide(ps);
  if (groups.every((g) => g.items.length <= 1)) {
    return ps.map((p) => `${label(p)}${opts.withSide && p.team ? ` (${teamText(p.team)})` : ""}`).join(" vs ");
  }
  return groups
    .map((g) => `${g.items.map(label).sort(byName).join(", ")}${g.team ? ` (${teamText(g.team)})` : ""}`)
    .join(" vs ");
}

export interface SideResult {
  team: string;
  /** «rojo», «azul»… */
  label: string;
  bots: string[];
  /** Puntos del marcador del bando, si el resultado los trae. */
  score: number | null;
  /** gana / pierde / empate; null si la batalla aún no tiene resultado. */
  outcome: "gana" | "pierde" | "empate" | null;
}

/**
 * 4v4 · Resultado POR BANDO a partir de lo que ya da GET /battles/{id} (participantes
 * y `result`): no pide ni expone nada nuevo. Ganador por `result.winner`; si no lo
 * hay, por el `outcome` de los participantes del bando.
 */
export function sideResults(b: BattleLike & { participants?: ParticipantLike[] }): SideResult[] {
  const r = (b.result && typeof b.result === "object" ? b.result : {}) as Record<string, unknown>;
  const winner = typeof r.winner === "string" ? r.winner : null;
  const score = r.score && typeof r.score === "object" ? (r.score as Record<string, unknown>) : {};
  const out: SideResult[] = [];
  for (const g of groupBySide(b.participants ?? [])) {
    if (g.team === null) continue;
    const team = g.team;
    let outcome: SideResult["outcome"] = null;
    if (b.status === "finished") {
      if (winner === "draw") outcome = "empate";
      else if (winner) outcome = winner === team ? "gana" : "pierde";
      else if (g.items.some((p) => p.outcome === "win")) outcome = "gana";
      else if (g.items.some((p) => p.outcome === "draw")) outcome = "empate";
      else if (g.items.some((p) => p.outcome === "loss" || p.outcome === "disqualified")) outcome = "pierde";
    }
    const pts = Number(score[team]);
    out.push({
      team,
      label: teamText(team),
      bots: g.items.map(botVersionLabel).sort(byName),
      score: Object.hasOwn(score, team) && Number.isFinite(pts) ? pts : null,
      outcome,
    });
  }
  return out;
}
