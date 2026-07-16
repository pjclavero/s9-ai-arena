/** Errores de la API con la forma del esquema Error del contrato de E1. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const unauthorized = (msg = "Credenciales ausentes o inválidas") =>
  new ApiError(401, "unauthorized", msg);
export const forbidden = (msg = "Rol insuficiente o recurso ajeno") =>
  new ApiError(403, "forbidden", msg);
export const notFound = (msg = "No existe o no es visible para el solicitante") =>
  new ApiError(404, "not_found", msg);
export const conflict = (code: string, msg: string, extra: Record<string, unknown> = {}) =>
  new ApiError(409, code, msg, extra);
export const badRequest = (msg: string) => new ApiError(400, "bad_request", msg);
export const tooMany = (msg = "Límite de peticiones superado") =>
  new ApiError(429, "too_many_requests", msg);
