/** Cliente HTTP del panel. La API vive tras el gateway bajo /api/v1 (cap. 6.2). */

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

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(String(body?.message ?? `HTTP ${status}`));
  }
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: { formData?: FormData } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let payload: BodyInit | undefined;
  if (opts.formData) {
    payload = opts.formData;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiRequestError(res.status, data ?? {});
  return data as T;
}
