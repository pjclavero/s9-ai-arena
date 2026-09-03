/**
 * R17 · El asistente de primer arranque.
 *
 * Toma tres entradas y no adquiere ninguna por su cuenta:
 *
 *   1. la CONFIGURACIÓN resuelta (capa `configuration`),
 *   2. el informe de READINESS con los efectos observados (capas `evidence` y
 *      `readiness`),
 *   3. el modelo de dominios y confusiones.
 *
 * y produce un recorrido ordenado donde cada dominio dice en qué estado está y
 * POR QUÉ. Lo que no se ha comprobado se declara `unknown`; `unknown` no es
 * aprobado, y un dominio cuyos requisitos no están satisfechos queda `blocked`
 * aunque su propia evidencia esté verde: no se declara terminado un piso sobre
 * cimientos sin demostrar.
 *
 * El asistente NUNCA activa nada. La cuarta capa (`activation`) vive en
 * `activation.ts` y exige un acto explícito y separado.
 */
import type { ConfigResolution } from "../readiness/config.ts";
import type { ReadinessReport } from "../readiness/engine.ts";
import { CONFUSIONS, CONFUSION_BY_ID, type ConfusionId } from "./confusions.ts";
import { CHECK_COVERAGE, DOMAINS, type Domain, type DomainId } from "./domains.ts";

export type StageState =
  /** Ejercido y demostrado, con requisitos también satisfechos. */
  | "satisfied"
  /** Ejercido y salió mal. */
  | "failed"
  /** No comprobado, o comprobado sin efecto. NO es aprobado. */
  | "unknown"
  /** Su propia evidencia no basta porque un requisito previo no está satisfecho. */
  | "blocked"
  /** Puerta que debe permanecer apagada: satisfecha justo por estar APAGADA. */
  | "off_by_design";

export interface WizardStage {
  domain: Domain;
  state: StageState;
  /** Qué se observó, en frases cortas y sin secretos. */
  evidence: string[];
  /** Lo que NO está demostrado. Se rellena siempre que el estado no sea satisfecho. */
  gaps: string[];
  /** Acción concreta para la persona que instala. */
  action: string;
  /** Confusiones de este dominio todavía sin cubrir por evidencia verificada. */
  unresolvedConfusions: ConfusionId[];
}

export interface WizardPlan {
  stages: WizardStage[];
  verdict: "READY" | "NOT_READY";
  /** Motivos concretos por los que no está listo. */
  blockers: string[];
  /** Confusiones que NINGUNA comprobación verificada cubre en toda la instalación. */
  unresolvedConfusions: ConfusionId[];
  /** Comprobaciones declaradas por los dominios y ausentes del informe. */
  missingChecks: string[];
  /** Puertas que el operador mantiene bloqueadas: el asistente no puede encenderlas. */
  blockedGates: string[];
}

export interface WizardInput {
  resolution: ConfigResolution;
  report: ReadinessReport;
  domains?: readonly Domain[];
  /** Puertas bloqueadas por el operador en ESTE despliegue. */
  blockedGates?: readonly string[];
}

export const OPERATOR_BLOCKED_GATES: readonly string[] = ["S9_ENABLE_REAL_BATTLE_RUNS", "S9_PUBLIC_SPECTATE_ENABLED"];

/** Confusiones cubiertas por las comprobaciones que quedaron `verified`. */
export function coveredConfusions(report: ReadinessReport): Set<ConfusionId> {
  const covered = new Set<ConfusionId>();
  for (const { check, outcome } of report.results) {
    if (outcome.status !== "verified") continue;
    for (const id of CHECK_COVERAGE[check.id] ?? []) covered.add(id);
  }
  return covered;
}

function topoOrder(domains: readonly Domain[]): Domain[] {
  const byId = new Map(domains.map((d) => [d.id, d]));
  const done = new Set<DomainId>();
  const out: Domain[] = [];
  const pending = [...domains].sort((a, b) => a.order - b.order);
  let guard = pending.length * pending.length + 1;
  while (pending.length > 0 && guard-- > 0) {
    const idx = pending.findIndex((d) => d.requires.every((r) => done.has(r) || !byId.has(r)));
    // Ciclo o requisito ausente: se emite en orden declarado, sin colgarse.
    const next = pending.splice(idx === -1 ? 0 : idx, 1)[0];
    done.add(next.id);
    out.push(next);
  }
  return out.concat(pending);
}

export function planWizard(input: WizardInput): WizardPlan {
  const domains = input.domains ?? DOMAINS;
  const blockedGates = input.blockedGates ?? OPERATOR_BLOCKED_GATES;
  const outcomes = new Map(input.report.results.map((r) => [r.check.id, r]));
  const covered = coveredConfusions(input.report);

  const stages: WizardStage[] = [];
  const stateById = new Map<DomainId, StageState>();
  const missingChecks: string[] = [];

  for (const domain of topoOrder(domains)) {
    const evidence: string[] = [];
    const gaps: string[] = [];
    let state: StageState = "satisfied";

    // ── Preflight: la configuración declarada es condición PREVIA. ──────────
    if (domain.id === "preflight") {
      const errors = input.resolution.problems.filter((p) => p.severity === "error");
      if (errors.length > 0) {
        state = "failed";
        for (const e of errors) gaps.push(e.message);
      } else {
        evidence.push("configuración declarada sin errores");
        for (const w of input.resolution.problems.filter((p) => p.severity === "warning")) {
          evidence.push(`aviso: ${w.message}`);
        }
      }
    }

    // ── Evidencia declarada por el dominio. ─────────────────────────────────
    for (const checkId of domain.evidence) {
      const found = outcomes.get(checkId);
      if (!found) {
        missingChecks.push(checkId);
        gaps.push(`${checkId}: no figura en el informe, así que NO está comprobado`);
        if (state === "satisfied") state = "unknown";
        continue;
      }
      const line = `${checkId} [${found.outcome.status}]: ${found.outcome.evidence}`;
      if (found.outcome.status === "verified") {
        evidence.push(line);
      } else {
        gaps.push(line);
        if (found.outcome.status === "failed") state = "failed";
        else if (state !== "failed") state = "unknown";
      }
    }

    // ── Confusiones que este dominio tiene obligación de resolver. ──────────
    const unresolved = domain.mustResolve.filter((c) => !covered.has(c));
    for (const c of unresolved) {
      gaps.push(`sin resolver ${CONFUSION_BY_ID.get(c)?.statement ?? c}: ${CONFUSION_BY_ID.get(c)?.question ?? ""}`);
      if (state === "satisfied") state = "unknown";
    }

    // ── Requisitos: cimientos sin demostrar bloquean el piso de arriba. ─────
    const unmet = domain.requires.filter(
      (r) => stateById.get(r) !== "satisfied" && stateById.get(r) !== "off_by_design",
    );
    if (unmet.length > 0) {
      gaps.push(`requisitos no satisfechos: ${unmet.join(", ")}`);
      if (state === "satisfied") state = "blocked";
    }

    // ── Puertas: satisfacer el dominio es demostrar que están APAGADAS. ─────
    if (domain.gateKey && state === "satisfied") {
      state = "off_by_design";
      evidence.push(`${domain.gateKey} apagada y así debe seguir; encenderla exige un acto explícito y autorizado`);
    }

    stateById.set(domain.id, state);
    stages.push({
      domain,
      state,
      evidence,
      gaps,
      action: actionFor(domain, state, gaps),
      unresolvedConfusions: unresolved,
    });
  }

  const globallyUnresolved = CONFUSIONS.map((c) => c.id).filter((id) => !covered.has(id));
  const blockers: string[] = [];
  for (const s of stages) {
    if (s.state === "satisfied" || s.state === "off_by_design") continue;
    blockers.push(`${s.domain.id} (${s.state}): ${s.gaps[0] ?? "sin evidencia"}`);
  }
  for (const id of globallyUnresolved) {
    blockers.push(`confusión sin cubrir por ninguna comprobación verificada: ${CONFUSION_BY_ID.get(id)?.statement}`);
  }

  return {
    stages: stages.sort((a, b) => a.domain.order - b.domain.order),
    verdict: blockers.length === 0 ? "READY" : "NOT_READY",
    blockers,
    unresolvedConfusions: globallyUnresolved,
    missingChecks,
    blockedGates: [...blockedGates],
  };
}

function actionFor(domain: Domain, state: StageState, gaps: string[]): string {
  switch (state) {
    case "satisfied":
      return `Nada pendiente en ${domain.title}. Recuerda: ${domain.purpose}`;
    case "off_by_design":
      return `${domain.title}: la puerta queda APAGADA. Encenderla no es parte del primer arranque.`;
    case "blocked":
      return `${domain.title}: resuelve antes sus requisitos; su evidencia propia no basta.`;
    case "failed":
      return `${domain.title}: corrige — ${gaps[0] ?? "fallo sin detalle"}`;
    default:
      return `${domain.title}: NO comprobado. ${gaps[0] ?? "falta evidencia"}. No lo des por bueno.`;
  }
}

/** Render en texto plano, apto para consola y para pegar en un parte. */
export function renderWizard(plan: WizardPlan): string {
  const lines: string[] = [];
  lines.push(`ASISTENTE DE PRIMER ARRANQUE · VEREDICTO: ${plan.verdict}`);
  lines.push("(unknown NO es aprobado; blocked NO es aprobado)");
  lines.push("");
  for (const s of plan.stages) {
    lines.push(`${String(s.domain.order).padStart(2, "0")}. [${s.state.toUpperCase()}] ${s.domain.title}`);
    for (const e of s.evidence) lines.push(`      efecto: ${e}`);
    for (const g of s.gaps) lines.push(`      laguna: ${g}`);
    lines.push(`      acción: ${s.action}`);
  }
  if (plan.unresolvedConfusions.length > 0) {
    lines.push("");
    lines.push("── Confusiones sin cubrir ──");
    for (const id of plan.unresolvedConfusions) {
      const c = CONFUSION_BY_ID.get(id)!;
      lines.push(`  ${c.statement} — ${c.question}`);
    }
  }
  lines.push("");
  lines.push(`Puertas bloqueadas por el operador: ${plan.blockedGates.join(", ") || "(ninguna)"}`);
  lines.push("El asistente no puede encenderlas: la activación es un acto aparte.");
  return lines.join("\n");
}
