/**
 * FC-D (D7) · Lectura TOLERANTE del contrato BATTLE_RESULT para la UI.
 *
 * Fuente: `battles.result` (jsonb) que escribe el tournament-worker
 * (apps/tournament-worker/src/battle-runner.ts: `{ winner, ticks, score,
 * disqualified }`), `participants[].outcome` (win|loss|draw|disqualified),
 * `failureKind` (none|bot_timeout|bot_crash|infrastructure) y, si la API los
 * expone, `startedAt`/`finishedAt` y `replayRef`/`replayHash`. DEV-B fija el
 * shape exacto en docs/technical/battles.md; aquí sólo se LEE lo que haya y se
 * omite lo que falte: la UI nunca inventa un ganador.
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
}

const TICK_HZ = 30;

const FAILURE_TEXT: Record<string, string> = {
  bot_timeout: "un bot no respondió a tiempo",
  bot_crash: "un bot se cayó",
  infrastructure: "fallo de infraestructura",
};

function fmtSeconds(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function summarizeBattle(b: BattleLike): BattleSummaryView {
  const r = (b.result && typeof b.result === "object" ? b.result : {}) as Record<string, unknown>;
  const winner = (r.winner ?? r.winnerTeam ?? null) as string | null;
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
  const ticks = Number(r.ticks ?? r.durationTicks);
  if (Number.isFinite(ticks) && ticks > 0) duration = fmtSeconds(ticks / TICK_HZ);
  else if (b.startedAt && b.finishedAt) {
    const ms = Date.parse(b.finishedAt) - Date.parse(b.startedAt);
    if (Number.isFinite(ms) && ms >= 0) duration = fmtSeconds(ms / 1000);
  }
  const fk = b.failureKind ?? null;
  const failure = fk && fk !== "none" ? (FAILURE_TEXT[fk] ?? fk) : null;
  const disqualified = Array.isArray(r.disqualified) ? (r.disqualified as unknown[]).map(String) : [];
  // `replayRef` ausente (la API aún no lo expone) ⇒ se ofrece el enlace y el
  // reproductor dirá si no existe; `null` explícito ⇒ no hay replay.
  const hasReplay = b.status === "finished" && b.replayRef !== null;
  return { outcome, score, duration, failure, disqualified, hasReplay };
}
