/**
 * FC-D (D1/D2, TD-022) · Errores de la web: tipo `ApiRequestError` y su
 * clasificación ÚNICA (`describeApiError`). Vive aparte de api.ts a propósito:
 * los componentes comunes (ErrorState, FormError) la usan aunque un test
 * sustituya el cliente HTTP (`vi.mock("../src/api.js")`), y la clasificación es
 * por FORMA (status/kind), no por `instanceof`, para que un error que cruce
 * módulos o mocks se siga clasificando bien.
 */

/** Origen del fallo: respuesta HTTP no-ok, plazo vencido o red caída. */
export type ApiErrorKind = "http" | "timeout" | "network";

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
    public kind: ApiErrorKind = "http",
  ) {
    super(String(body?.message ?? (kind === "http" ? `HTTP ${status}` : kind)));
    this.name = "ApiRequestError";
  }
}

export type ApiErrorClass =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "conflict"
  | "server"
  | "unavailable"
  | "timeout"
  | "network"
  | "unknown";

export interface DescribedError {
  kind: ApiErrorClass;
  /** Qué pasó, en una frase para el usuario. */
  title: string;
  /** El detalle real (mensaje del servidor o del navegador). */
  detail: string;
  status?: number;
  /** ¿Tiene sentido ofrecer «Reintentar»? */
  retryable: boolean;
}

/**
 * Clasificación ÚNICA de errores para toda la web: cada pantalla distingue
 * validación, permisos, inexistente, servidor, servicio caído, plazo y red, y
 * ofrece la acción que tiene sentido.
 */
export function describeApiError(e: unknown): DescribedError {
  const err = e as { status?: unknown; kind?: unknown; message?: unknown } | null | undefined;
  const detail = err && typeof err.message === "string" && err.message ? err.message : String(e ?? "error desconocido");
  if (err && err.kind === "timeout") return { kind: "timeout", title: "El servidor tarda demasiado", detail, retryable: true };
  if (err && err.kind === "network") return { kind: "network", title: "Sin conexión con el servidor", detail, retryable: true };
  if (err && typeof err.status === "number" && err.status > 0) {
    const s = err.status;
    const base = { status: s, detail };
    if (s === 400 || s === 422) return { ...base, kind: "validation", title: "Datos no válidos", retryable: false };
    if (s === 401) return { ...base, kind: "unauthorized", title: "Necesitas iniciar sesión", retryable: false };
    if (s === 403) return { ...base, kind: "forbidden", title: "No tienes permiso para esto", retryable: false };
    if (s === 404) return { ...base, kind: "notFound", title: "No existe o no está disponible", retryable: false };
    if (s === 409) return { ...base, kind: "conflict", title: "Conflicto con el estado actual", retryable: false };
    if (s === 429) return { ...base, kind: "unavailable", title: "Demasiadas peticiones; espera un momento", retryable: true };
    if (s === 502 || s === 503 || s === 504)
      return { ...base, kind: "unavailable", title: `Servicio no disponible (${s})`, retryable: true };
    if (s >= 500) return { ...base, kind: "server", title: `Error del servidor (${s})`, retryable: true };
    return { ...base, kind: "unknown", title: `Error ${s}`, retryable: true };
  }
  return { kind: "unknown", title: "Error inesperado", detail, retryable: true };
}
