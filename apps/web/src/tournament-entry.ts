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
