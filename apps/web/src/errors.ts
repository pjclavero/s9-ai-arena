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
    /** UX-E · segundos de `Retry-After` (429/503), si el servidor los dio. */
    public retryAfterSeconds?: number,
  ) {
    super(messageOf(body?.message) ?? (kind === "http" ? `HTTP ${status}` : kind));
    this.name = "ApiRequestError";
  }
}

/**
 * UX-E · El `message` de un cuerpo de error no siempre es texto: algunos
 * validadores devuelven un objeto o una lista. `String(obj)` pintaba
 * «[object Object]» en la pantalla; aquí se aplana a frases legibles.
 */
function messageOf(m: unknown): string | undefined {
  if (m === undefined || m === null || m === "") return undefined;
  if (typeof m === "string") return m;
  if (typeof m === "number" || typeof m === "boolean") return String(m);
  if (Array.isArray(m)) {
    const parts = m.map((x) => messageOf(x)).filter((x): x is string => !!x);
    return parts.length ? parts.join("; ") : undefined;
  }
  if (typeof m === "object") {
    const o = m as Record<string, unknown>;
    const inner = messageOf(o.message) ?? messageOf(o.error) ?? messageOf(o.detail);
    if (inner) return inner;
  }
  return undefined;
}

/**
 * UX-E · Convierte un elemento de `details`/`fieldErrors` en una frase sin
 * JSON ni «[object Object]»: `{path:"name", message:"obligatorio"}` ⇒
 * «name: obligatorio».
 */
export function formatDetail(x: unknown, key?: string): string {
  const prefix = key ? `${key}: ` : "";
  if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return `${prefix}${String(x)}`;
  if (Array.isArray(x)) return `${prefix}${x.map((y) => formatDetail(y)).join("; ")}`;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    const field = o.field ?? o.path ?? o.instancePath ?? o.param;
    const fieldText = Array.isArray(field)
      ? field.join(".")
      : typeof field === "string"
        ? field.replace(/^\//, "")
        : "";
    const msg = messageOf(o.message) ?? messageOf(o.msg) ?? messageOf(o.error);
    if (msg) return `${prefix}${fieldText ? `${fieldText}: ` : ""}${msg}`;
    return `${prefix}${Object.entries(o)
      .map(([k, v]) => formatDetail(v, k))
      .join(", ")}`;
  }
  return `${prefix}valor no válido`;
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
  // UX-E · nunca «[object Object]» ni «undefined»: un fallo sin mensaje legible
  // se dice como tal.
  const detail =
    err && typeof err.message === "string" && err.message
      ? err.message
      : typeof e === "string" && e
        ? e
        : "error desconocido";
  if (err && err.kind === "timeout")
    return { kind: "timeout", title: "El servidor tarda demasiado", detail, retryable: true };
  if (err && err.kind === "network")
    return { kind: "network", title: "Sin conexión con el servidor", detail, retryable: true };
  if (err && typeof err.status === "number" && err.status > 0) {
    const s = err.status;
    const base = { status: s, detail };
    if (s === 400 || s === 422) return { ...base, kind: "validation", title: "Datos no válidos", retryable: false };
    if (s === 401) return { ...base, kind: "unauthorized", title: "Necesitas iniciar sesión", retryable: false };
    if (s === 403) return { ...base, kind: "forbidden", title: "No tienes permiso para esto", retryable: false };
    if (s === 404) return { ...base, kind: "notFound", title: "No existe o no está disponible", retryable: false };
    if (s === 409) return { ...base, kind: "conflict", title: "Conflicto con el estado actual", retryable: false };
    if (s === 429) {
      const ra = (e as { retryAfterSeconds?: unknown }).retryAfterSeconds;
      const wait =
        typeof ra === "number" && Number.isFinite(ra) && ra > 0 ? `espera ${Math.ceil(ra)} s` : "espera un momento";
      return { ...base, kind: "unavailable", title: `Demasiadas peticiones; ${wait} y reintenta`, retryable: true };
    }
    if (s === 502 || s === 503 || s === 504)
      return { ...base, kind: "unavailable", title: `Servicio no disponible (${s})`, retryable: true };
    if (s >= 500) return { ...base, kind: "server", title: `Error del servidor (${s})`, retryable: true };
    return { ...base, kind: "unknown", title: `Error ${s}`, retryable: true };
  }
  return { kind: "unknown", title: "Error inesperado", detail, retryable: true };
}
