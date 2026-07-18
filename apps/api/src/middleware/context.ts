/** correlationId por petición (cap. 24) + cabeceras de seguridad + CORS restrictivo. */
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
      auth?: { userId: string; sessionId: string; roles: string[]; rank: number };
    }
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.correlationId = randomUUID();
  res.setHeader("X-Correlation-Id", req.correlationId);
  next();
}

/**
 * T7.2 · Cabeceras de seguridad y CORS restrictivo (E7.M): solo el origen del
 * panel (CORS_ORIGIN); sin comodines. Los endpoints públicos son same-origin a
 * través del gateway (cap. 6.2).
 */
export function securityHeaders(allowedOrigin: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    // R2.6 (ERR-SEC-16): HSTS ya NO se emite aquí. Es responsabilidad del
    // terminador TLS (gateway Nginx, infrastructure/gateway/*.conf): la API
    // habla HTTP plano en la red interna y un HSTS emitido desde aquí miente
    // sobre quién sirve TLS.

    const origin = req.headers.origin;
    if (origin && origin === allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE");
      res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.status(origin === allowedOrigin ? 204 : 403).end();
      return;
    }
    next();
  };
}
