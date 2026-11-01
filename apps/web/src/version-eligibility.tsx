/**
 * ELIG · Elegibilidad para batallas nuevas en la UI. La calcula la API
 * (`battleEligibility` en GET /bots/{id}/versions, sólo versiones published/frozen)
 * y es también quien la impone al crear: la UI sólo la explica.
 *
 * Publicada ≠ elegible: una versión no elegible se conserva en el histórico (y sus
 * replays), por eso se muestra —deshabilitada y con el motivo—, nunca se oculta.
 */
import type { ReactNode } from "react";

export interface BattleEligibilityInfo {
  eligible: boolean;
  reason?: string;
  category?: string;
  message?: string;
  suggestedAction?: string;
}

/** Una versión es seleccionable si la API no dice explícitamente que no es elegible. */
export function isBattleEligible(v: { battleEligibility?: BattleEligibilityInfo }): boolean {
  return v.battleEligibility?.eligible !== false;
}

/** Motivo corto y legible a partir de la categoría (el detalle técnico va en `message`). */
export function eligibilityReason(be: BattleEligibilityInfo | undefined): string {
  switch (be?.category) {
    case "INVALID_AMMO":
      return "Munición incompatible con el arma principal.";
    case "MISSING_AMMO":
      return "El arma no lleva ninguna munición compatible.";
    case "ORPHAN_AMMO":
      return "Lleva munición que ningún arma del vehículo usa.";
    case "UNKNOWN":
      return "No se puede verificar su loadout con el catálogo actual.";
    default:
      return "Su loadout no cumple la validación actual.";
  }
}

export const NOT_ELIGIBLE_LABEL = "Publicada · No elegible";

/** Opciones deshabilitadas de un selector de versión: visibles, con su motivo. */
export function blockedVersionOptions(blocked: { version: number; reason: string }[]): ReactNode {
  return blocked.map((b) => (
    <option key={`blocked-${b.version}`} value={`blocked-${b.version}`} disabled>
      v{b.version} · {NOT_ELIGIBLE_LABEL} — {b.reason}
    </option>
  ));
}

/** Bloque de la ficha del bot para una versión publicada no elegible. */
export function VersionEligibilityNote(props: {
  version: number;
  be?: BattleEligibilityInfo;
  suggestVersion?: number;
}) {
  const { be } = props;
  if (!be || be.eligible) return null;
  return (
    <div className="warn" data-testid={`version-not-eligible-${props.version}`}>
      <strong>{NOT_ELIGIBLE_LABEL}</strong>
      <br />
      Motivo: {eligibilityReason(be)}
      {be.message ? <small title={be.message}> ({be.message})</small> : null}
      <br />
      Acción sugerida:{" "}
      {props.suggestVersion != null
        ? `usa v${props.suggestVersion} o crea una nueva versión.`
        : "crea una nueva versión con un loadout corregido."}
      <br />
      <small>Se conserva para el histórico y sus replays; sólo no puede entrar en batallas nuevas.</small>
    </div>
  );
}
