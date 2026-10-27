/**
 * Cliente HTTP del panel. La API vive tras el gateway bajo /api/v1 (cap. 6.2).
 *
 * R3.7 (ERR-VIS-03) · Sesión persistente + interceptor ÚNICO de 401:
 *  - el access token vive SOLO en memoria; la persistencia real es la cookie
 *    httpOnly `s9_refresh` que emite la API en el login (el JS no puede leerla);
 *    en localStorage sólo hay una MARCA booleana de «puede haber sesión»
 *    (UX-E, C-G13), nunca el token;
 *  - tras un F5, bootstrapSession() hace POST /auth/refresh (el navegador
 *    adjunta la cookie) y recupera al usuario sin tocar localStorage;
 *  - cualquier 401 de la API pasa por UN solo camino: intento de refresh
 *    (single-flight) + reintento de la petición; si el refresh falla, se limpia
 *    la sesión y se avisa al App para redirigir al login con mensaje.
 *
 * FC-D (TD-022) · Toda petición tiene PLAZO (`API_TIMEOUT_MS`) y todo fallo se
 * clasifica en un único sitio (`describeApiError`): validación, permisos,
 * inexistente, servidor, servicio caído, plazo y red. Ninguna pantalla debe
 * convertir un fallo en «lista vacía».
 */
import { ApiRequestError, describeApiError } from "./errors.js";
export { ApiRequestError, describeApiError } from "./errors.js";
export type { ApiErrorKind, ApiErrorClass, DescribedError } from "./errors.js";

export interface Me {
  id: string;
  displayName: string;
  email: string;
  roles: string[];
  twoFactorEnabled: boolean;
}

const BASE = "/api/v1";

/**
 * Plazo por defecto de TODA petición del panel. Antes `fetch` no tenía timeout:
 * una API que no responde dejaba «Cargando…» para siempre. Al vencer se aborta
 * la petición y se lanza `ApiRequestError` con `kind:"timeout"`.
 */
export const API_TIMEOUT_MS = 15_000;

let accessToken: string | null = null;
export function setToken(t: string | null): void {
  accessToken = t;
  // Un token nuevo = hay sesión (login): se marca para el próximo F5.
  if (t) writeSessionHint(true);
}

/**
 * UX-E (C-G13) · MARCA de «puede haber sesión». Antes cada carga ANÓNIMA hacía
 * POST /auth/refresh sin cookie y el servidor respondía 400: un error rojo en
 * la consola y en la red de todo visitante nuevo, para nada. El JS no puede leer
 * la cookie httpOnly, así que se guarda sólo un booleano (NUNCA el token) que se
 * pone al iniciar sesión o renovar y se quita al salir o cuando el servidor dice
 * que no hay sesión. Si el almacenamiento no está disponible (modo privado
 * estricto) se vuelve al comportamiento anterior: intentar el refresh.
 */
export const SESSION_HINT_KEY = "s9_session_hint";
/** `true`/`false` = marca leída; `null` = almacenamiento no disponible. */
function readSessionHint(): boolean | null {
  try {
    return window.localStorage.getItem(SESSION_HINT_KEY) === "1";
  } catch {
    return null;
  }
}
function writeSessionHint(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(SESSION_HINT_KEY, "1");
    else window.localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // sin almacenamiento: el arranque intentará el refresh igual que antes
  }
}
export function getToken(): string | null {
  return accessToken;
}

/** El App registra aquí QUÉ hacer cuando la sesión muere (limpieza + redirección). */
let sessionExpiredHandler: ((reason: string) => void) | null = null;
export function onSessionExpired(handler: ((reason: string) => void) | null): void {
  sessionExpiredHandler = handler;
}

/**
 * `fetch` con plazo. Traduce el aborto por plazo y el fallo de red a
 * `ApiRequestError` (status 0) para que TODAS las pantallas los clasifiquen igual.
 * Un aborto pedido por el llamante (señal externa) se propaga tal cual.
 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const outer = init.signal ?? undefined;
  const onOuterAbort = () => ctrl.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (timedOut) {
      throw new ApiRequestError(
        0,
        { message: `el servidor no respondió en ${Math.round(timeoutMs / 1000)} s` },
        "timeout",
      );
    }
    if (outer?.aborted) throw e;
    throw new ApiRequestError(
      0,
      { message: `sin conexión con el servidor (${(e as Error)?.message ?? e})` },
      "network",
    );
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

export interface ApiOptions {
  formData?: FormData;
  /** Plazo de la petición en ms (por defecto API_TIMEOUT_MS). */
  timeoutMs?: number;
}

async function rawFetch(method: string, path: string, body?: unknown, opts: ApiOptions = {}) {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let payload: BodyInit | undefined;
  if (opts.formData) {
    payload = opts.formData;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  // credentials: la cookie httpOnly de sesión debe viajar también si el panel
  // se sirve desde otro origen que el gateway (en dev el proxy lo hace mismo-origen).
  return fetchWithTimeout(
    `${BASE}${path}`,
    { method, headers, body: payload, credentials: "include" },
    opts.timeoutMs ?? API_TIMEOUT_MS,
  );
}

/** UX-E · `Retry-After` en segundos (o fecha HTTP); `undefined` si no viene o no se entiende. */
function retryAfterOf(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return n;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : undefined;
}

async function parseResponse<T>(res: Response, opts: { lenient?: boolean } = {}): Promise<T> {
  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  let data: unknown;
  if (isJson) {
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
  } else if (opts.lenient && !contentType.includes("text/html")) {
    // Servicios fuera de la API (replay-service) o proxies que no ponen el
    // content-type: se intenta JSON; si no lo es, `data` queda indefinido.
    try {
      data = JSON.parse(await res.text());
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const body = { ...((data as Record<string, unknown>) ?? {}) };
    // Un 502/504 del gateway llega como HTML: sin cuerpo JSON el mensaje sería
    // sólo «HTTP 502». Se nombra el estado para que el usuario sepa qué pasó.
    if (body.message === undefined) body.message = `el servidor respondió ${res.status}`;
    throw new ApiRequestError(res.status, body, "http", retryAfterOf(res));
  }
  if (!isJson && contentType.includes("text/html")) {
    // 200 con HTML donde se esperaba JSON = una ruta que no llega a su servicio
    // (el gateway sirve el SPA). Es un fallo, no "datos vacíos".
    throw new ApiRequestError(res.status, { message: "respuesta inesperada (HTML en lugar de JSON)" });
  }
  return data as T;
}

/**
 * GET JSON fuera de /api/v1 (replay-service tras el gateway) con el MISMO plazo y
 * la MISMA clasificación de errores que `api()`. Rutas públicas: sin token.
 */
export async function fetchJson<T>(url: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetchWithTimeout(url, { method: "GET", signal: opts.signal }, opts.timeoutMs ?? API_TIMEOUT_MS);
  return parseResponse<T>(res, { lenient: true });
}

/** Refresh single-flight: N peticiones con 401 simultáneas ⇒ UN solo refresh. */
let refreshInFlight: Promise<boolean> | null = null;
/**
 * Motivo del último refresh fallido por SERVIDOR o RED. `null` = el servidor
 * contestó "no hay sesión" (400/401/403), que no es lo mismo que "API caída".
 */
let lastRefreshFailure: ApiRequestError | null = null;
function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    lastRefreshFailure = null;
    refreshInFlight = (async () => {
      try {
        const res = await fetchWithTimeout(
          `${BASE}/auth/refresh`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", credentials: "include" },
          API_TIMEOUT_MS,
        );
        if (!res.ok) {
          if (res.status >= 500 || res.status === 429) {
            lastRefreshFailure = new ApiRequestError(
              res.status,
              { message: `el servidor respondió ${res.status}` },
              "http",
              retryAfterOf(res),
            );
          } else {
            // 400/401/403: el servidor dice que NO hay sesión (o caducó).
            writeSessionHint(false);
          }
          return false;
        }
        const data = (await res.json()) as { accessToken?: string };
        if (!data.accessToken) return false;
        accessToken = data.accessToken;
        writeSessionHint(true);
        return true;
      } catch (e) {
        lastRefreshFailure =
          e instanceof ApiRequestError ? e : new ApiRequestError(0, { message: String(e) }, "network");
        return false;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

function expireSession(reason: string): void {
  accessToken = null;
  writeSessionHint(false);
  sessionExpiredHandler?.(reason);
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: ApiOptions = {},
): Promise<T> {
  const res = await rawFetch(method, path, body, opts);
  // Interceptor único de 401 (los endpoints de auth quedan fuera: un 401 de
  // /auth/login son credenciales malas, no una sesión caducada).
  if (res.status === 401 && !path.startsWith("/auth/")) {
    if (await refreshSession()) {
      return parseResponse<T>(await rawFetch(method, path, body, opts));
    }
    // UX-E · si el refresh no llegó a contestar «no hay sesión» (red, plazo,
    // 5xx, 429) la sesión NO ha caducado: echar al usuario al login desmontaba
    // el panel y perdía lo no guardado (p. ej. el código del editor). Se lanza
    // el fallo transitorio y la pantalla ofrece «Reintentar».
    if (lastRefreshFailure) throw lastRefreshFailure;
    expireSession("Tu sesión ha caducado. Vuelve a iniciar sesión.");
  }
  return parseResponse<T>(res);
}

/**
 * Arranque del panel (y F5): intenta recuperar la sesión desde la cookie.
 * Devuelve `null` si NO hay sesión. FC-D (TD-022): si la API está caída (red,
 * plazo, 5xx) LANZA `ApiRequestError`, para que el App diga «API no disponible»
 * y ofrezca reintentar en vez de mandar al login a quien tiene sesión válida.
 */
export async function bootstrapSession(): Promise<Me | null> {
  // UX-E (C-G13) · sin marca de sesión no se pregunta: un visitante anónimo no
  // genera un 400 en cada carga. `null` (sin almacenamiento) sí lo intenta.
  if (readSessionHint() === false) return null;
  if (!(await refreshSession())) {
    if (lastRefreshFailure) throw lastRefreshFailure;
    return null;
  }
  try {
    return await api<Me>("GET", "/users/me");
  } catch (e) {
    const d = describeApiError(e);
    if (d.kind === "timeout" || d.kind === "network" || d.kind === "server" || d.kind === "unavailable") throw e;
    return null;
  }
}

/** Cierre de sesión: revoca en servidor (borra la cookie) y limpia memoria. */
export async function logout(): Promise<void> {
  try {
    await fetchWithTimeout(`${BASE}/auth/logout`, { method: "POST", credentials: "include" }, API_TIMEOUT_MS);
  } catch {
    // sin red igualmente limpiamos el estado local
  }
  accessToken = null;
  writeSessionHint(false);
}
