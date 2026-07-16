/**
 * T7.2 · Rate limiting en memoria por IP y por usuario (E7.M).
 *
 * Ventana deslizante simple. El bloqueo de fuerza bruta de login (DoD: 20 intentos
 * fallidos ⇒ bloqueo temporal y registro) usa además un contador de FALLOS con
 * bloqueo explícito y entrada en audit_log.
 */
import type { NextFunction, Request, Response } from "express";
import { tooMany } from "../errors.js";

interface Bucket {
  hits: number[];
}

export class SlidingWindowLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  /** true si la petición está permitida. */
  hit(key: string, now = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = { hits: [] };
      this.buckets.set(key, b);
    }
    b.hits = b.hits.filter((t) => now - t < this.windowMs);
    if (b.hits.length >= this.max) return false;
    b.hits.push(now);
    return true;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}

export function rateLimit(limiter: SlidingWindowLimiter, scope: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = `${scope}:${req.auth?.userId ?? req.ip}`;
    if (!limiter.hit(key)) return next(tooMany());
    next();
  };
}

/** Contador de fallos de login con bloqueo temporal. */
export class FailedLoginGuard {
  private failures = new Map<string, { count: number; blockedUntil: number }>();
  constructor(
    public maxFailures = 20,
    public blockMs = 15 * 60 * 1000,
  ) {}

  isBlocked(key: string, now = Date.now()): boolean {
    const e = this.failures.get(key);
    return !!e && e.blockedUntil > now;
  }

  /** Registra un fallo; devuelve true si ESTE fallo dispara el bloqueo. */
  recordFailure(key: string, now = Date.now()): boolean {
    const e = this.failures.get(key) ?? { count: 0, blockedUntil: 0 };
    e.count += 1;
    if (e.count >= this.maxFailures) {
      e.blockedUntil = now + this.blockMs;
      e.count = 0;
      this.failures.set(key, e);
      return true;
    }
    this.failures.set(key, e);
    return false;
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }
}
