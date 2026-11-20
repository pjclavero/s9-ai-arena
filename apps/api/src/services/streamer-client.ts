/**
 * EQ5b · Cliente de la API INTERNA de control del streamer (apps/streamer/src/control.ts),
 * red `platform`, nunca publicada. Autenticado con el secreto compartido
 * `x-streamer-auth` (STREAMER_CONTROL_SECRET_FILE, patrón Docker secrets).
 *
 * La API nunca manda la clave en claro: sólo el SOBRE sellado
 * (packages/stream-secrets), que el streamer abre con su privada.
 */
import { readFileSync } from "node:fs";

export interface StreamerCallResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  body: T;
}

export interface StreamerClient {
  readonly configured: boolean;
  call<T = Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<StreamerCallResult<T>>;
}

export class StreamerUnavailable extends Error {
  constructor(message: string) {
    super(message);
  }
}

function readSecret(path: string | undefined): string | null {
  if (!path) return null;
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export class HttpStreamerClient implements StreamerClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly secretFile: string | undefined,
    private readonly timeoutMs = 10_000,
  ) {}

  get configured(): boolean {
    return !!this.baseUrl;
  }

  async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<StreamerCallResult<T>> {
    if (!this.baseUrl) throw new StreamerUnavailable("streamer no configurado (STREAMER_CONTROL_URL)");
    const headers: Record<string, string> = { "content-type": "application/json" };
    const secret = readSecret(this.secretFile); // en cada llamada: rotar no exige reiniciar la API
    if (secret) headers["x-streamer-auth"] = secret;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new StreamerUnavailable("el streamer no responde");
    }
    let parsed: unknown = {};
    try {
      parsed = await res.json();
    } catch {
      parsed = {};
    }
    if (res.status === 401) throw new StreamerUnavailable("el streamer rechazó la autenticación interna");
    return { ok: res.ok, status: res.status, body: parsed as T };
  }
}

export function streamerClientFromEnv(env: NodeJS.ProcessEnv = process.env): StreamerClient {
  return new HttpStreamerClient(env.STREAMER_CONTROL_URL || null, env.STREAMER_CONTROL_SECRET_FILE);
}
