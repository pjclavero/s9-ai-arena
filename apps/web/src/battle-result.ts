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
  /** Texto del resultado: «gana red», «empate», o null si aún no hay resultado. */
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

export function summarizeBattle(b: BattleLike): BattleSummaryView {
  const r = (b.result && typeof b.result === "object" ? b.result : {}) as Record<string, unknown>;
  const winner = (r.winner ?? null) as string | null;
  let outcome: string | null = null;
  if (b.status === "finished") {
    if (winner && winner !== "draw") outcome = `gana ${winner}`;
    else if (winner === "draw" || (b.participants ?? []).some((p) => p.outcome === "draw")) outcome = "empate";
    else {
      const wins = (b.participants ?? []).filter((p) => p.outcome === "win");
      outcome = wins.length > 0 ? `gana ${wins.map((p) => p.team ?? p.botId.slice(0, 8)).join(", ")}` : "sin ganador";
    }
  }
  let score: string | null = null;
  if (r.score && typeof r.score === "object") {
    const entries = Object.entries(r.score as Record<string, unknown>);
    if (entries.length > 0) score = entries.map(([t, n]) => `${t}: ${String(n)}`).join(" · ");
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
