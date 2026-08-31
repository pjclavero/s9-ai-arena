/**
 * R17 · Asistente de primer arranque.
 *
 * No es un instalador mágico: es una lista de pasos DERIVADA del modelo de
 * configuración y del motor de readiness, para que quien instala sepa qué le
 * falta y en qué orden. Nunca marca un paso como hecho por omisión; si algo no
 * se pudo comprobar, el paso queda pendiente (`unknown`), que es lo contrario
 * de "aprobado".
 */
import { CONFIG_MODEL, resolveConfig, type ConfigEntry } from "./config.ts";
import type { ReadinessReport } from "./engine.ts";

export interface FirstRunStep {
  id: string;
  title: string;
  /** Acción concreta que debe hacer la persona. */
  action: string;
  state: "done" | "pending" | "unknown";
  /** Un paso obligatorio pendiente impide declarar la instalación lista. */
  mandatory: boolean;
}

export interface FirstRunPlan {
  steps: FirstRunStep[];
  /** Se puede continuar hacia readiness. */
  canProceed: boolean;
}

function keyStep(entry: ConfigEntry, provided: boolean): FirstRunStep {
  return {
    id: `config.${entry.key}`,
    title: entry.key,
    action: entry.secret
      ? `Monta el secreto y apunta ${entry.key}_FILE a /run/secrets/<secret-name> (nunca por argv ni en claro). ${entry.purpose}`
      : `Define ${entry.key}. ${entry.purpose}`,
    state: provided ? "done" : "pending",
    mandatory: entry.kind === "required",
  };
}

export function planFirstRun(env: Record<string, string | undefined>, report?: ReadinessReport): FirstRunPlan {
  const resolution = resolveConfig(env);
  const steps: FirstRunStep[] = [];

  for (const entry of CONFIG_MODEL) {
    if (entry.kind === "gate") continue;
    const provided =
      (env[entry.key] ?? "").trim() !== "" ||
      (Boolean(entry.fileVariant) && (env[`${entry.key}_FILE`] ?? "").trim() !== "") ||
      entry.kind === "safeDefault";
    steps.push(keyStep(entry, provided));
  }

  for (const problem of resolution.problems.filter((p) => p.severity === "error")) {
    steps.push({
      id: `fix.${problem.code}.${problem.key}`,
      title: `Corregir ${problem.key}`,
      action: problem.message,
      state: "pending",
      mandatory: true,
    });
  }

  // Las puertas se declaran siempre, aunque estén bien: instalar sabiendo qué
  // está apagado forma parte del producto.
  for (const gate of CONFIG_MODEL.filter((e) => e.kind === "gate")) {
    const on = resolution.gatesOn.includes(gate.key);
    steps.push({
      id: `gate.${gate.key}`,
      title: `Puerta ${gate.key}`,
      action: gate.blockedByOperator
        ? `Debe quedar APAGADA: bloqueada por decisión del operador en este despliegue. ${gate.purpose}`
        : `Apagada por defecto; encenderla es un acto explícito. ${gate.purpose}`,
      state: on ? "pending" : "done",
      mandatory: true,
    });
  }

  if (report) {
    for (const { check, outcome } of report.results) {
      steps.push({
        id: `readiness.${check.id}`,
        title: check.title,
        action:
          outcome.status === "verified"
            ? `Verificado: ${outcome.evidence}. NO demuestra: ${check.doesNotProve}`
            : `${outcome.evidence}. ${outcome.remedy ?? ""}`.trim(),
        state: outcome.status === "verified" ? "done" : outcome.status === "not_exercised" ? "unknown" : "pending",
        mandatory: check.required,
      });
    }
  }

  const canProceed = !steps.some((s) => s.mandatory && s.state !== "done");
  return { steps, canProceed };
}
