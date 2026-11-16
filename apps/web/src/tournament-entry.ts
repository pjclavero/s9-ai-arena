/**
 * FROZEN-REUSE (B8) · Qué versiones de un bot se pueden inscribir en un torneo, en la UI.
 *
 * Misma regla que la API (`assertTournamentEligible`, apps/api/src/services/version-eligibility.ts):
 * estado `published` o `frozen` Y elegible con el validador actual (`battleEligibility`).
 * `frozen` = INMUTABLE (congelada al cerrar un torneo anterior), NO «usada una vez»: se
 * muestra como «Frozen / Inmutable» y se puede elegir si es elegible. La API es la
 * autoridad: esto sólo decide qué se ofrece y cómo se explica.
 */
import { eligibilityReason, isBattleEligible, type BattleEligibilityInfo } from "./version-eligibility.js";

/** Estados con los que una versión puede competir (espejo de COMPETITION_STATES de la API). */
export const TOURNAMENT_ENTRY_STATES: readonly string[] = ["published", "frozen"];

export const FROZEN_LABEL = "Frozen / Inmutable";

export interface EntryVersion {
  version: number;
  state: string;
  battleEligibility?: BattleEligibilityInfo;
}

/** ¿Se puede inscribir esta versión? Estado de competición y no marcada como no elegible. */
export function isTournamentEligible(v: EntryVersion): boolean {
  return TOURNAMENT_ENTRY_STATES.includes(v.state) && isBattleEligible(v);
}

/** Texto de la opción: «v2 · Frozen / Inmutable» o «v3 · publicada». */
export function entryVersionLabel(v: EntryVersion): string {
  return `v${v.version} · ${v.state === "frozen" ? FROZEN_LABEL : "publicada"}`;
}

export interface EntryChoices {
  /** Inscribibles, de la más reciente a la más antigua. */
  selectable: EntryVersion[];
  /** Publicadas/congeladas pero NO elegibles: visibles, deshabilitadas y con el motivo. */
  blocked: { version: EntryVersion; reason: string }[];
  /** La que se propone si el usuario no elige otra: la inscribible más reciente. */
  defaultVersion?: number;
}

export function tournamentEntryChoices(versions: EntryVersion[]): EntryChoices {
  const competing = [...versions]
    .filter((v) => TOURNAMENT_ENTRY_STATES.includes(v.state))
    .sort((a, b) => b.version - a.version);
  const selectable = competing.filter(isTournamentEligible);
  const blocked = competing
    .filter((v) => !isTournamentEligible(v))
    .map((v) => ({ version: v, reason: eligibilityReason(v.battleEligibility) }));
  return { selectable, blocked, defaultVersion: selectable[0]?.version };
}

// ------------------------------------------------------------------ #287 · por equipo

/** Bot de un equipo tal como lo ve un miembro (GET /teams: `bots[]` con `mine`). */
export interface TeamRosterBot {
  id: string;
  name: string;
  mine?: boolean;
}

/** Versiones de un bot del roster: cargando, error o la lista de la API. */
export type RosterVersions = "loading" | "error" | EntryVersion[];

export interface TeamRosterRow {
  botId: string;
  name: string;
  included: boolean;
  /** Versión que se inscribiría (sólo si es inscribible). */
  version?: number;
  frozen?: boolean;
  /** Por qué este miembro no se puede inscribir (sólo para los incluidos). */
  problem?: string;
}

export interface TeamRosterPlan {
  rows: TeamRosterRow[];
  /** El botón «Inscribir equipo» sólo se habilita con el roster COMPLETO y válido. */
  canSubmit: boolean;
  /** Motivo de que no se pueda inscribir todavía. */
  reason?: string;
  /** Lo que se envía: exactamente N `{ botId, version }`. */
  members: { botId: string; version: number }[];
}

/**
 * #287 · Plan de inscripción de un equipo completo, PURO. Misma regla que la API
 * (`enterTournamentTeam`): exactamente `teamSize` bots, todos del usuario y cada uno con una
 * versión inscribible (`tournamentEntryChoices`: published|frozen y elegible). Si falta o
 * sobra un bot, o alguno no se puede inscribir, se dice por qué y no se envía nada: la
 * inscripción es todo o nada. La API sigue siendo la autoridad.
 */
export function teamRosterPlan(input: {
  teamSize: number;
  bots: TeamRosterBot[];
  included: ReadonlySet<string>;
  versions: ReadonlyMap<string, RosterVersions>;
  chosen: ReadonlyMap<string, number>;
}): TeamRosterPlan {
  const rows: TeamRosterRow[] = input.bots.map((b) => {
    const row: TeamRosterRow = { botId: b.id, name: b.name, included: input.included.has(b.id) };
    if (!row.included) return row;
    if (!b.mine) return { ...row, problem: "Es de otro miembro: sólo su dueño puede inscribirlo" };
    const vs = input.versions.get(b.id);
    if (vs === undefined || vs === "loading") return { ...row, problem: "Cargando sus versiones…" };
    if (vs === "error") return { ...row, problem: "No se pudieron cargar sus versiones" };
    const choices = tournamentEntryChoices(vs);
    const want = input.chosen.get(b.id) ?? choices.defaultVersion;
    const pick = choices.selectable.find((v) => v.version === want);
    if (!pick) {
      const why = choices.blocked[0]?.reason;
      return { ...row, problem: `Sin versión publicada o congelada elegible${why ? ` — ${why}` : ""}` };
    }
    return { ...row, version: pick.version, frozen: pick.state === "frozen" };
  });
  const included = rows.filter((r) => r.included);
  let reason: string | undefined;
  if (included.length !== input.teamSize) {
    reason = `Hacen falta exactamente ${input.teamSize} bots del equipo (elegidos: ${included.length})`;
  } else if (included.some((r) => r.problem)) {
    reason = "Algún miembro no se puede inscribir: corrígelo o elige otro bot";
  }
  return {
    rows,
    canSubmit: reason === undefined,
    ...(reason ? { reason } : {}),
    members: reason ? [] : included.map((r) => ({ botId: r.botId, version: r.version! })),
  };
}
