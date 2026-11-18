/**
 * Cliente HTTP mínimo de la API de S9 AI Arena para export/import portable.
 *
 * - Credenciales SIEMPRE de fichero (0600) o stdin; nunca por argv ni por entorno visible.
 * - Un 401 renueva la sesión una vez por petición (el token de acceso dura 15 min): primero con el
 *   refresh token (POST /auth/refresh, rotatorio: se guarda el nuevo; NO necesita TOTP, así que
 *   sirve a cuentas con 2FA) y, si no hay o falla, con usuario/contraseña SIN TOTP (un código TOTP
 *   ya consumido no se puede reutilizar). Un token suelto (--token-file/--token-stdin) no se puede
 *   renovar: el error lo dice.
 * - 429 (límite de creación de versiones: 60/h por usuario) y 5xx transitorios se reintentan
 *   con espera; agotada la espera máxima el error dice cómo reanudar (el import es idempotente).
 * - Los mensajes de error llevan método, ruta, estado y el código/mensaje de la API; jamás el
 *   token, la contraseña ni el cuerpo de la petición.
 */
import { readFileSync, statSync } from "node:fs";
import { PortableError } from "./format.mjs";

export function readSecretFile(file) {
  const mode = statSync(file).mode & 0o077;
  if (mode !== 0)
    throw new PortableError("bad_permissions", `${file}: debe tener permisos 0600 (sin acceso para grupo/otros).`);
  return readFileSync(file, "utf8");
}

/** Resuelve las credenciales desde fichero de credenciales JSON, fichero de token o stdin (token). */
export function loadAuth({ credentialsFile, tokenFile, tokenStdin, readStdin = () => readFileSync(0, "utf8") }) {
  if (credentialsFile) {
    const c = JSON.parse(readSecretFile(credentialsFile));
    if (typeof c.email !== "string" || typeof c.password !== "string") {
      throw new PortableError(
        "bad_credentials",
        `${credentialsFile}: debe ser JSON con "email" y "password" (y opcional "totp").`,
      );
    }
    return { email: c.email, password: c.password, ...(typeof c.totp === "string" ? { totp: c.totp } : {}) };
  }
  if (tokenFile) return { token: readSecretFile(tokenFile).trim() };
  if (tokenStdin) return { token: readStdin().trim() };
  throw new PortableError(
    "no_credentials",
    "Faltan credenciales: --credentials-file <0600>, --token-file <0600> o --token-stdin (nunca por argv).",
  );
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export class ApiClient {
  /**
   * @param {{baseUrl:string, auth:{token?:string,email?:string,password?:string,totp?:string},
   *   fetchImpl?:typeof fetch, sleep?:(ms:number)=>Promise<void>, rateLimitWaitMs?:number,
   *   rateLimitMaxWaitMs?:number, log?:(m:string)=>void}} o
   */
  constructor(o) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.auth = o.auth;
    this.fetch = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? sleepReal;
    this.rateLimitWaitMs = o.rateLimitWaitMs ?? 60_000;
    this.rateLimitMaxWaitMs = o.rateLimitMaxWaitMs ?? 65 * 60_000;
    this.log = o.log ?? (() => {});
    this.token = o.auth.token ?? null;
    this.refreshToken = null;
    this.reauths = 0;
    this.requests = 0;
    this.writes = 0;
  }

  /** Login con usuario/contraseña. `withTotp=false` en una reautenticación: el código ya está consumido. */
  async login(withTotp = true) {
    if (!this.auth.email)
      throw new PortableError(
        "auth_failed",
        "El token ha caducado o es inválido y no hay credenciales para reautenticar: un token suelto dura 15 min. Usa --credentials-file (usuario y contraseña).",
      );
    const res = await this.#raw("POST", "/auth/login", {
      json: {
        email: this.auth.email,
        password: this.auth.password,
        ...(withTotp && this.auth.totp ? { totp: this.auth.totp } : {}),
      },
      noAuth: true,
    });
    if (res.status !== 200 || typeof res.body?.accessToken !== "string") {
      throw new PortableError(
        "auth_failed",
        `Login rechazado (HTTP ${res.status}${res.body?.error ? ` ${res.body.error}` : ""}).` +
          (res.status === 401
            ? ' Si la cuenta tiene 2FA, el fichero de credenciales necesita "totp" con un código VIGENTE (un código ya usado no sirve).'
            : ""),
      );
    }
    this.token = res.body.accessToken;
    this.refreshToken = typeof res.body.refreshToken === "string" ? res.body.refreshToken : null;
  }

  /** Renueva el token de acceso con el refresh token (rotatorio). Devuelve false si no se pudo. */
  async refresh() {
    if (!this.refreshToken) return false;
    const res = await this.#raw("POST", "/auth/refresh", { json: { refreshToken: this.refreshToken }, noAuth: true });
    if (res.status !== 200 || typeof res.body?.accessToken !== "string") {
      this.refreshToken = null;
      return false;
    }
    this.token = res.body.accessToken;
    this.refreshToken = typeof res.body.refreshToken === "string" ? res.body.refreshToken : null;
    return true;
  }

  /** Renovación tras un 401: refresh → login sin TOTP. Lanza auth_failed si no hay forma. */
  async reauthenticate() {
    this.reauths++;
    if (await this.refresh()) return;
    if (this.auth.email && !this.auth.totp) return this.login(false);
    if (this.auth.email && this.auth.totp)
      throw new PortableError(
        "auth_failed",
        "La sesión caducó y no se pudo renovar con el refresh token; el código TOTP del fichero ya está consumido. Repite el comando con un TOTP nuevo en el fichero de credenciales (el import es reanudable).",
      );
    throw new PortableError(
      "auth_failed",
      "El token ha caducado (dura 15 min) y no hay credenciales para renovarlo. Usa --credentials-file (usuario y contraseña) en lugar de --token-file/--token-stdin.",
    );
  }

  async ensureAuth() {
    if (!this.token) await this.login();
  }

  async #raw(method, path, { json, form, noAuth } = {}) {
    const headers = { Accept: "application/json, application/octet-stream" };
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form) body = form;
    if (!noAuth && this.token) headers.Authorization = `Bearer ${this.token}`;
    this.requests++;
    if (method !== "GET") this.writes++;
    const res = await this.fetch(`${this.baseUrl}${path}`, { method, headers, body });
    const ct = res.headers.get("content-type") ?? "";
    let parsed = null;
    let bytes = null;
    if (ct.includes("application/json")) parsed = await res.json().catch(() => null);
    else bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: parsed, bytes, headers: res.headers };
  }

  /** Petición con reautenticación (1) y reintentos de 429/5xx. Devuelve la respuesta si 2xx; si no, lanza. */
  async request(method, path, opts = {}) {
    await this.ensureAuth();
    let waited = 0;
    let reauthed = false;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.#raw(method, path, opts);
      } catch (e) {
        if (attempt < 3) {
          await this.sleep(1000 * (attempt + 1));
          continue;
        }
        throw new PortableError("network", `${method} ${path}: ${e.message}`);
      }
      if (res.status >= 200 && res.status < 300) return res;
      if (res.status === 401 && !reauthed) {
        reauthed = true;
        await this.reauthenticate();
        continue;
      }
      if (res.status === 429) {
        if (waited >= this.rateLimitMaxWaitMs) {
          throw new PortableError(
            "rate_limited",
            `${method} ${path}: HTTP 429 persistente tras esperar ${Math.round(waited / 1000)} s. Repite el mismo comando más tarde: el import es idempotente y continúa donde se quedó.`,
          );
        }
        this.log(`límite de peticiones (429): espero ${Math.round(this.rateLimitWaitMs / 1000)} s…`);
        await this.sleep(this.rateLimitWaitMs);
        waited += this.rateLimitWaitMs;
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await this.sleep(1000 * (attempt + 1));
        continue;
      }
      const err = new PortableError(
        "http",
        `${method} ${path}: HTTP ${res.status}${res.body?.error ? ` ${res.body.error}` : ""}${res.body?.message ? ` — ${String(res.body.message).slice(0, 300)}` : ""}`,
        { status: res.status, apiError: res.body?.error, violations: res.body?.violations },
      );
      err.status = res.status;
      throw err;
    }
  }

  async json(method, path, opts) {
    return (await this.request(method, path, opts)).body;
  }

  /** Recorre un listado paginado `{items,nextCursor}` y devuelve todos los elementos. */
  async listAll(path, params = {}) {
    const out = [];
    let cursor;
    for (let guard = 0; guard < 10_000; guard++) {
      const q = new URLSearchParams({ ...params, limit: "100", ...(cursor ? { cursor } : {}) });
      const page = await this.json("GET", `${path}?${q}`);
      out.push(...(page.items ?? []));
      if (!page.nextCursor) return out;
      cursor = page.nextCursor;
    }
    throw new PortableError("pagination", `${path}: paginación sin fin.`);
  }
}

/** `filename` de Content-Disposition (RFC 6266/5987); undefined si no hay. */
export function filenameFromDisposition(h) {
  if (!h) return undefined;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(h);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* cae al filename simple */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(h) ?? /filename\s*=\s*([^;]+)/i.exec(h);
  return plain ? plain[1].trim() : undefined;
}
