/**
 * R17 · Capa de ACTIVACIÓN, separada a propósito.
 *
 * Ninguna puerta se enciende porque algo salga verde. El verde es condición
 * NECESARIA y nunca suficiente: hace falta además un acto explícito, con
 * sujeto (quién), motivo (para qué), una frase de reconocimiento que no se
 * teclea por inercia y evidencia fresca. Y por encima de todo eso, si el
 * operador mantiene la puerta BLOQUEADA, no hay combinación de verdes que la
 * conceda: esa comprobación se hace la PRIMERA, antes de mirar readiness.
 *
 * Esta función tampoco activa nada: decide y deja constancia. Quien aplica el
 * cambio es el operador, fuera de este código. Decidir y ejecutar en la misma
 * función es cómo un informe verde acaba encendiendo una puerta.
 */
import { OPERATOR_BLOCKED_GATES, type WizardPlan } from "./wizard.ts";

export type ActivationRefusal =
  "gate_blocked_by_operator" | "gate_unknown" | "no_explicit_act" | "not_ready" | "stale_evidence";

export interface ActivationRequest {
  gateKey: string;
  /** Quién lo pide. Sin sujeto no hay acto. */
  actor: string;
  /** Para qué. Queda en la traza. */
  reason: string;
  /**
   * Frase de reconocimiento exacta. Debe escribirse a mano: existe para que
   * encender no sea pulsar "siguiente" en un asistente.
   */
  acknowledgement: string;
  /** Antigüedad de la evidencia en la que se apoya la petición. */
  evidenceAgeMinutes: number;
}

export interface ActivationDecision {
  granted: boolean;
  refusal?: ActivationRefusal;
  message: string;
  /** Línea de traza, sin secretos, apta para el registro de auditoría. */
  auditLine: string;
}

/** Máxima antigüedad de la evidencia para apoyar una activación. */
export const MAX_EVIDENCE_AGE_MINUTES = 60;

export function requiredAcknowledgement(gateKey: string): string {
  return `ACTIVAR ${gateKey} CON RESPONSABILIDAD DEL OPERADOR`;
}

export function requestActivation(
  request: ActivationRequest,
  plan: WizardPlan,
  blockedGates: readonly string[] = OPERATOR_BLOCKED_GATES,
): ActivationDecision {
  const stamp = `actor=${request.actor} gate=${request.gateKey}`;

  // 1. Bloqueo del operador: se mira ANTES que nada. Ningún verde lo levanta.
  if (blockedGates.includes(request.gateKey) || plan.blockedGates.includes(request.gateKey)) {
    return refuse(
      "gate_blocked_by_operator",
      `${request.gateKey} está BLOQUEADA por decisión del operador en este despliegue: la activación no se concede aunque la instalación esté READY.`,
      stamp,
    );
  }

  // 2. La puerta tiene que existir en el modelo del asistente.
  const known = plan.stages.some((s) => s.domain.gateKey === request.gateKey);
  if (!known) {
    return refuse(
      "gate_unknown",
      `${request.gateKey} no es una puerta declarada: no se activa lo que no se modela.`,
      stamp,
    );
  }

  // 3. Acto explícito: sujeto, motivo y frase exacta.
  if (
    request.actor.trim() === "" ||
    request.reason.trim() === "" ||
    request.acknowledgement !== requiredAcknowledgement(request.gateKey)
  ) {
    return refuse(
      "no_explicit_act",
      `Falta el acto explícito: hacen falta actor, motivo y la frase exacta «${requiredAcknowledgement(request.gateKey)}».`,
      stamp,
    );
  }

  // 4. Evidencia: necesaria, nunca suficiente.
  if (plan.verdict !== "READY") {
    return refuse(
      "not_ready",
      `La instalación no está READY (${plan.blockers.length} bloqueante(s)); el primero: ${plan.blockers[0] ?? "sin detalle"}.`,
      stamp,
    );
  }
  if (!Number.isFinite(request.evidenceAgeMinutes) || request.evidenceAgeMinutes > MAX_EVIDENCE_AGE_MINUTES) {
    return refuse(
      "stale_evidence",
      `La evidencia tiene ${request.evidenceAgeMinutes} min (> ${MAX_EVIDENCE_AGE_MINUTES}): vuelve a ejecutar el asistente antes de activar.`,
      stamp,
    );
  }

  return {
    granted: true,
    message: `Activación AUTORIZADA para ${request.gateKey}. Este código NO la aplica: el cambio lo hace el operador y debe volver a verificarse después.`,
    auditLine: `activation.granted ${stamp} reason="${request.reason.replace(/"/g, "'")}"`,
  };
}

function refuse(refusal: ActivationRefusal, message: string, stamp: string): ActivationDecision {
  return { granted: false, refusal, message, auditLine: `activation.refused ${stamp} refusal=${refusal}` };
}
