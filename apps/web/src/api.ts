/**
 * Cliente HTTP del panel. La API vive tras el gateway bajo /api/v1 (cap. 6.2).
 *
 * R3.7 (ERR-VIS-03) · Sesión persistente + interceptor ÚNICO de 401:
 *  - el access token vive SOLO en memoria; la persistencia real es la cookie
 *    httpOnly `s9_refresh` que emite la API en el login (el JS no puede leerla);
 *  - tras un F5, bootstrapSession() hace POST /auth/refresh (el navegador
 *    adjunta la cookie) y recupera al usuario sin tocar localStorage;
 *  - cualquier 401 de la API pasa por UN solo camino: intento de refresh
 *    (single-flight) + reintento de la petición; si el refresh falla, se limpia
 *    la sesión y se avisa al App para redirigir al login con mensaje.
 */

export interface Me {
  id: string;
  displayName: string;
  email: string;
  roles: string[];
  twoFactorEnabled: boolean;
}

const BASE = "/api/v1";

let accessToken: string | null = null;
export function setToken(t: string | null): void {
  accessToken = t;
}
export function getToken(): string | null {
  return accessToken;
}

/** El App registra aquí QUÉ hacer cuando la sesión muere (limpieza + redirección). */
let sessionExpiredHandler: ((reason: string) => void) | null = null;
export function onSessionExpired(handler: ((reason: string) => void) | null): void {
  sessionExpiredHandler = handler;
}

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(String(body?.message ?? `HTTP ${status}`));
  }
}

async function rawFetch(method: string, path: string, body?: unknown, opts: { formData?: FormData } = {}) {
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
  return fetch(`${BASE}${path}`, { method, headers, body: payload, credentials: "include" });
}

async function parseResponse<T>(res: Response): Promise<T> {
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiRequestError(res.status, (data as Record<string, unknown>) ?? {});
  return data as T;
}

/** Refresh single-flight: N peticiones con 401 simultáneas ⇒ UN solo refresh. */
let refreshInFlight: Promise<boolean> | null = null;
function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${BASE}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          credentials: "include",
        });
        if (!res.ok) return false;
        const data = (await res.json()) as { accessToken?: string };
        if (!data.accessToken) return false;
        accessToken = data.accessToken;
        return true;
      } catch {
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
  sessionExpiredHandler?.(reason);
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: { formData?: FormData } = {},
): Promise<T> {
  const res = await rawFetch(method, path, body, opts);
  // Interceptor único de 401 (los endpoints de auth quedan fuera: un 401 de
  // /auth/login son credenciales malas, no una sesión caducada).
  if (res.status === 401 && !path.startsWith("/auth/")) {
    if (await refreshSession()) {
      return parseResponse<T>(await rawFetch(method, path, body, opts));
    }
    expireSession("Tu sesión ha caducado. Vuelve a iniciar sesión.");
  }
  return parseResponse<T>(res);
}

/** Arranque del panel (y F5): intenta recuperar la sesión desde la cookie. */
export async function bootstrapSession(): Promise<Me | null> {
  if (!(await refreshSession())) return null;
  try {
    return await api<Me>("GET", "/users/me");
  } catch {
    return null;
  }
}

/** Cierre de sesión: revoca en servidor (borra la cookie) y limpia memoria. */
export async function logout(): Promise<void> {
  try {
    await fetch(`${BASE}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    // sin red igualmente limpiamos el estado local
  }
  accessToken = null;
}
