/**
 * R16 · Primitivas visuales aisladas (docs/R16_DESIGN_SYSTEM.md §8).
 *
 * Envuelven EXACTAMENTE las clases y patrones ya presentes en apps/web/index.html
 * y en apps/web/src/resource.tsx — no introducen estilo nuevo ni tokens
 * nuevos. ADOPTADAS en AuditPage, MapsPage, TeamsPage y RankingPage — las
 * cuatro páginas autorizadas de este carril. NO se ha tocado ninguna página de
 * R11/R12, ni BotsPage, ni index.html, ni App.tsx.
 *
 * Regla de docs/R16_DESIGN_SYSTEM.md §1: el color nunca es el único canal de
 * estado. Por eso StatusBadge y EmptyState siempre exigen texto.
 */
import type { ReactNode } from "react";
import { describeApiError, type DescribedError } from "../errors.js";

/** Envuelve `.card` (index.html:70-76): el panel/tarjeta ya usado por ErrorBoundary. */
export function Panel(props: { children: ReactNode; "data-testid"?: string }) {
  return (
    <div className="card" data-testid={props["data-testid"]}>
      {props.children}
    </div>
  );
}

export type StatusVariant = "ok" | "warn" | "error" | "neutral";

const STATUS_CLASS: Record<StatusVariant, string | undefined> = {
  ok: "ok",
  warn: "warn",
  error: "error",
  neutral: undefined,
};

/**
 * Envuelve el patrón `<span className="ok|warn|error">` ya usado 40 veces en
 * apps/web/src/pages (p. ej. MapsPage.tsx:242,264). El texto (children) es
 * SIEMPRE la fuente de verdad; el color es solo refuerzo visual.
 */
export function StatusBadge(props: { variant: StatusVariant; children: ReactNode; "data-testid"?: string }) {
  const cls = STATUS_CLASS[props.variant];
  return (
    <span className={cls} data-testid={props["data-testid"]}>
      {props.children}
    </span>
  );
}

/** Envuelve el `role="status" aria-live="polite"` ya usado en resource.tsx:101-107. */
export function LoadingState(props: { label: string }) {
  return (
    <p role="status" aria-live="polite">
      Cargando {props.label}…
    </p>
  );
}

/**
 * Estado de ERROR común (FC-D, D1/D2). Envuelve el `role="alert"` + «Reintentar»
 * de resource.tsx y, si recibe el fallo original (`error`), lo CLASIFICA con
 * `describeApiError`: el usuario ve qué pasó (permiso, inexistente, servidor,
 * servicio caído, plazo, red), el detalle real y la acción posible. Mantiene la
 * frase «No se pudo cargar <label>: <detalle>» y el data-testid históricos.
 */
export function ErrorState(props: { label: string; message?: string; error?: unknown; onRetry?: () => void }) {
  const d: DescribedError | null = props.error !== undefined ? describeApiError(props.error) : null;
  const detail = d?.detail ?? props.message ?? "error desconocido";
  return (
    <div
      role="alert"
      data-testid={`resource-error-${props.label.replace(/\s+/g, "-")}`}
      data-error-kind={d?.kind ?? "unknown"}
    >
      {d && <strong data-testid="error-title">{d.title}</strong>}
      <p className="error">
        No se pudo cargar {props.label}: {detail}
      </p>
      {d?.kind === "unauthorized" && <a href="#/bots">Inicia sesión de nuevo</a>}
      {d?.kind === "notFound" && <a href="#/bots">Volver al inicio</a>}
      {props.onRetry && (
        <button type="button" onClick={() => props.onRetry?.()}>
          Reintentar
        </button>
      )}
    </div>
  );
}

/**
 * Error de FORMULARIO común (FC-D). Para acciones (crear, publicar, enviar):
 * muestra el título según el tipo (validación/permiso/conflicto/servidor/plazo)
 * y el mensaje real del servidor, con `details`/`fieldErrors` si los trae. Nunca
 * silencio: si `error` es null/undefined no pinta nada.
 */
export function FormError(props: { error: unknown; "data-testid"?: string }) {
  if (props.error === null || props.error === undefined) return null;
  const d = describeApiError(props.error);
  const body = (props.error as { body?: Record<string, unknown> })?.body ?? {};
  const extra: string[] = [];
  const details = body.details ?? body.fieldErrors ?? body.errors;
  if (Array.isArray(details)) {
    for (const x of details.slice(0, 10)) extra.push(typeof x === "string" ? x : JSON.stringify(x));
  } else if (details && typeof details === "object") {
    for (const [k, v] of Object.entries(details as Record<string, unknown>).slice(0, 10))
      extra.push(`${k}: ${String(v)}`);
  }
  return (
    <div role="alert" className="error" data-testid={props["data-testid"] ?? "form-error"} data-error-kind={d.kind}>
      <strong>{d.title}</strong>: {d.detail}
      {extra.length > 0 && (
        <ul>
          {extra.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Formaliza el patrón de "no hay nada" que hoy cada página reescribe suelto
 * (AuditPage.tsx:50, BattlesPage.tsx:56, LivePage.tsx:39, MapsPage.tsx:224).
 * `action` opcional para el caso con botón/enlace de siguiente paso.
 */
export function EmptyState(props: { message: string; action?: ReactNode; "data-testid"?: string }) {
  return (
    <div data-testid={props["data-testid"]}>
      <p>{props.message}</p>
      {props.action}
    </div>
  );
}

/**
 * Envuelve el `<button>` estilado globalmente por index.html:30-41 (mismo
 * aspecto, sin estilo nuevo). `variant="link"` usa la clase `.link`
 * (index.html:83-91) ya usada para botones con apariencia de enlace.
 */
export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "link";
  type?: "button" | "submit";
  "data-testid"?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      type={props.type ?? "button"}
      className={props.variant === "link" ? "link" : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
      data-testid={props["data-testid"]}
      aria-label={props["aria-label"]}
    >
      {props.children}
    </button>
  );
}
