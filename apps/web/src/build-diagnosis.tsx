/**
 * UX-B · UX-02 — diagnóstico LEGIBLE de un build rechazado.
 *
 * El pipeline ya guarda la fase y el motivo de cada etapa; lo que faltaba es
 * contárselo al usuario: en qué fase falló, en qué FICHERO y LÍNEA de su código,
 * que la versión NO está publicada (y cuál sí sigue en juego) y qué hacer.
 *
 * Y, sobre todo, DE QUIÉN es el fallo. Nunca se culpa al código de un fallo de la
 * plataforma: un sandbox que no arranca, reintentos agotados («build no
 * verificable»), un sandbox sin Docker («sandbox no verificado») o una excepción
 * interna de una etapa son INFRAESTRUCTURA — reenviar sin tocar nada es lo
 * correcto. Los fallos de PLATAFORMA del sandbox no llegan como etapa fallida: el
 * pipeline los propaga y el worker cierra el build con «build no verificable»
 * (apps/bot-manager/src/build-worker.ts), así que una etapa de ejecución
 * `failed` es, por construcción, del bot.
 */

export type BuildFault = "user" | "infrastructure" | "unknown";

export interface StageLike {
  name: string;
  status: string;
  message?: string;
}

export interface BuildDiagnosis {
  fault: BuildFault;
  /** Etapa que falló (nombre técnico) y su rótulo legible. */
  stage?: string;
  stageLabel?: string;
  /** Fichero y línea del código del usuario, si el motivo los señala. */
  location?: { file: string; line: number };
  /** Motivo tal cual lo dio la plataforma (sin trazas). */
  detail: string;
  title: string;
  advice: string;
}

/** Rótulos de las etapas (contrato OpenAPI Build.stages[].name). */
export const STAGE_LABEL: Record<string, string> = {
  structure: "estructura del paquete",
  static_analysis: "análisis estático del código",
  dependencies: "dependencias",
  build: "empaquetado",
  protocol_test: "prueba de protocolo (arranque, HELLO y primeras órdenes)",
  smoke_battle: "partida de humo",
  resource_limits: "límites de recursos",
  secret_scan: "búsqueda de secretos",
  sign: "firma del artefacto",
  publish: "registro del artefacto",
};

const CODE_FILE = String.raw`([\w./-]+\.(?:py|m?js|cjs|ts))`;
const LOCATION_PATTERNS: RegExp[] = [
  // describeUserError del sandbox: «src/bot.py, línea 7: NameError…»
  new RegExp(`${CODE_FILE}, l[ií]nea (\\d+)`),
  // AST de Python: «src/bot.py (SyntaxError: expected ':' (linea 2))»
  new RegExp(`${CODE_FILE} \\([^()]*?\\(l[ií]nea (\\d+)\\)\\)`),
  // acorn: «src/bot.js (Unexpected token (3:14))»
  new RegExp(`${CODE_FILE} \\(.*?\\((\\d+):\\d+\\)`),
  // hallazgos dinámicos: «src/bot.py: linea 4: referencia a eval»
  new RegExp(`${CODE_FILE}: l[ií]nea (\\d+)`),
];

export function locateInMessage(message: string): { file: string; line: number } | undefined {
  for (const re of LOCATION_PATTERNS) {
    const m = re.exec(message);
    if (m) return { file: m[1], line: Number(m[2]) };
  }
  return undefined;
}

/** Las etapas en las que un fallo `failed` es del código o del paquete del usuario. */
const USER_STAGES = new Set([
  "structure",
  "static_analysis",
  "dependencies",
  "build",
  "protocol_test",
  "smoke_battle",
  "resource_limits",
  "secret_scan",
]);

const INFRA_REASON = /^(build no verificable|sandbox no verificado)/;
const INFRA_STAGE_MESSAGE = /^error interno en etapa/;

const ADVICE_BY_STAGE: Record<string, string> = {
  structure: "Revisa la estructura del paquete (manifiesto en la raíz, ficheros permitidos).",
  static_analysis:
    "Corrige el error señalado. Recuerda: Python 3.11 o JavaScript ESM (TypeScript no se acepta) y sólo imports permitidos.",
  dependencies: "Usa sólo dependencias de la lista permitida e incluye el lockfile.",
  build: "Reduce el tamaño del paquete.",
  protocol_test:
    "Tu bot debe arrancar, conectarse y responder órdenes válidas: revisa el hook (on_observation / onObservation) y la forma de la orden que devuelve.",
  smoke_battle:
    "Tu bot dejó de responder durante la partida de humo: revisa que on_observation no lance excepciones ni tarde demasiado.",
  resource_limits: "Tu bot tarda demasiado en decidir o usa demasiada memoria: simplifica el cálculo de cada ciclo.",
  secret_scan: "Quita del código las credenciales o tokens detectados.",
};

export function diagnoseBuild(input: {
  state: string;
  rejectionReason?: string;
  stages?: StageLike[];
}): BuildDiagnosis | null {
  if (input.state !== "rejected") return null;
  const reason = input.rejectionReason ?? "";
  const failed = (input.stages ?? []).find((s) => s.status === "failed");
  const message = failed?.message ?? reason.replace(/^[a-z_]+: /, "");
  const stage = failed?.name ?? /^([a-z_]+):/.exec(reason)?.[1];
  const stageLabel = stage ? (STAGE_LABEL[stage] ?? stage) : undefined;
  const detail = (message || reason || "sin motivo registrado").replace(/\s*\[timeout_reason=[a-z_]+\]/, "");

  const infra =
    INFRA_REASON.test(reason) ||
    (!!failed && INFRA_STAGE_MESSAGE.test(failed.message ?? "")) ||
    (!!stage && (stage === "sign" || stage === "publish"));
  if (infra) {
    return {
      fault: "infrastructure",
      ...(stage ? { stage, stageLabel } : {}),
      detail,
      title: "La plataforma no pudo verificar tu bot: es un fallo de infraestructura, no de tu código",
      advice: "No hace falta cambiar nada: vuelve a enviar la misma versión a validación dentro de un rato.",
    };
  }
  if (stage && USER_STAGES.has(stage)) {
    const location = locateInMessage(detail);
    return {
      fault: "user",
      stage,
      stageLabel,
      ...(location ? { location } : {}),
      detail,
      title: "Tu bot no ha superado la validación",
      advice: ADVICE_BY_STAGE[stage] ?? "Corrige el código y crea una versión nueva.",
    };
  }
  return {
    fault: "unknown",
    ...(stage ? { stage, stageLabel } : {}),
    detail,
    title: "La validación terminó en rechazo sin una causa clasificada",
    advice: "Reenvía la versión; si se repite, revisa el detalle del build.",
  };
}

/** Bloque visual del diagnóstico (lo usan «Mis bots» y la vista de versiones). */
export function BuildDiagnosisView(props: {
  diagnosis: BuildDiagnosis;
  version: number;
  /** Versión publicada más reciente del bot, si la hay (sigue en juego). */
  publishedVersion?: number;
  onFix?: () => void;
  onRetry?: () => void;
}) {
  const d = props.diagnosis;
  return (
    <div role="alert" className="card" data-testid="build-diagnosis" data-fault={d.fault}>
      <h3 className="error">
        v{props.version}: {d.title}
      </h3>
      <p data-testid="build-diagnosis-fault">
        {d.fault === "user"
          ? "Origen: tu código o tu paquete."
          : d.fault === "infrastructure"
            ? "Origen: la plataforma (tu código no tiene la culpa)."
            : "Origen: no determinado."}
      </p>
      {d.stageLabel && (
        <p>
          Fase: <strong data-testid="build-diagnosis-stage">{d.stageLabel}</strong>
        </p>
      )}
      {d.location && (
        <p data-testid="build-diagnosis-location">
          Dónde:{" "}
          <mark>
            <code>{d.location.file}</code>, línea <strong>{d.location.line}</strong>
          </mark>
        </p>
      )}
      <p>
        Motivo: <code data-testid="build-diagnosis-detail">{d.detail}</code>
      </p>
      <p data-testid="build-diagnosis-not-published">
        <strong>v{props.version} NO está publicada</strong> y no puede usarse en batallas.{" "}
        {props.publishedVersion
          ? `Sigue en juego la v${props.publishedVersion} publicada.`
          : "Este bot aún no tiene ninguna versión publicada."}
      </p>
      <p>{d.advice}</p>
      {d.fault === "user" && props.onFix && (
        <button type="button" data-testid="build-diagnosis-fix" onClick={props.onFix}>
          Corregir el código de v{props.version} (se guardará como versión nueva)
        </button>
      )}
      {d.fault !== "user" && props.onRetry && (
        <button type="button" data-testid="build-diagnosis-retry" onClick={props.onRetry}>
          Reenviar v{props.version} a validación sin cambios
        </button>
      )}
    </div>
  );
}
