/**
 * R2.5 (ERR-SEC-12/14) — rate-limit y bloqueo sobre ALMACÉN COMPARTIDO.
 *
 * ERR-SEC-14 (auditoría de R1.8): los limitadores en memoria (SlidingWindowLimiter,
 * FailedLoginGuard) pierden todo su estado en cada reinicio del proceso y no se
 * comparten entre réplicas. Aquí el estado vive en la tabla `api_usage` de
 * PostgreSQL (T7.5), que ya es la fuente de verdad de las cuotas anónimas:
 *  - ventana FIJA por (actor_key, route, window_start) con contador atómico
 *    (INSERT … ON CONFLICT … count+1), como anon-quota.ts;
 *  - EXPIRACIÓN: cada fila lleva expires_at; cada hit poda las filas caducadas
 *    (barato: índice api_usage_expiry_idx);
 *  - COTA DE CLAVES: un atacante que fabrique actor_keys (IPs falsificadas) no
 *    puede hacer crecer la tabla sin límite: superado maxKeys por ruta se
 *    eliminan las ventanas más antiguas.
 *
 * Redis sería una alternativa válida (mismo contrato RateLimiterLike); en este
 * entorno no hay Redis disponible, así que la única implementación VERIFICADA
 * es la de PostgreSQL. No se incluye una variante Redis sin verificar.
 */
import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db/connection.js";
import { tooMany } from "../errors.js";

/** Contrato mínimo de un limitador (la variante en memoria de T7.2 también lo cumple). */
export interface RateLimiterLike {
  hit(key: string, now?: number): boolean | Promise<boolean>;
}

export interface SharedLimiterOptions {
  max: number;
  windowMs: number;
  /** Cuánto sobrevive una ventana pasada su fin antes de podarse (por defecto 1 ventana más). */
  retentionMs?: number;
  /** Máximo de filas vivas por ruta (cota de claves). */
  maxKeys?: number;
}

export class SharedRateLimiter implements RateLimiterLike {
  private max: number;
  private windowMs: number;
  private retentionMs: number;
  private maxKeys: number;

  constructor(
    private db: Db,
    private route: string,
    opts: SharedLimiterOptions,
  ) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.retentionMs = opts.retentionMs ?? opts.windowMs;
    this.maxKeys = opts.maxKeys ?? 100_000;
  }

  /** true si la petición está permitida. Estado 100 % en BD: sobrevive a reinicios. */
  async hit(key: string, now: number = Date.now()): Promise<boolean> {
    const windowStart = new Date(Math.floor(now / this.windowMs) * this.windowMs);
    const expiresAt = new Date(windowStart.getTime() + this.windowMs + this.retentionMs);

    // Expiración: poda de ventanas caducadas de esta ruta (indexado por expires_at).
    await this.db("api_usage").where({ route: this.route }).where("expires_at", "<", new Date(now)).del();

    const [row] = await this.db("api_usage")
      .insert({ actor_key: key, route: this.route, window_start: windowStart, count: 1, expires_at: expiresAt })
      .onConflict(["actor_key", "route", "window_start"])
      .merge({ count: this.db.raw("api_usage.count + 1") })
      .returning("count");

    // Cota de claves: si la ruta supera maxKeys filas vivas, caen las más antiguas.
    const [{ c }] = (await this.db("api_usage").where({ route: this.route }).count("* as c")) as { c: string }[];
    const excess = Number(c) - this.maxKeys;
    if (excess > 0) {
      await this.db("api_usage")
        .whereIn(
          "id",
          this.db("api_usage").select("id").where({ route: this.route }).orderBy("window_start", "asc").limit(excess),
        )
        .del();
    }

    return Number(row.count) <= this.max;
  }
}

/** Middleware: limita por usuario autenticado (o IP para visitantes). */
export function sharedRateLimit(limiter: RateLimiterLike) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = req.auth?.userId ? `user:${req.auth.userId}` : `ip:${req.ip}`;
      if (!(await limiter.hit(key))) return next(tooMany());
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Contrato del guard de fuerza bruta de login (el FailedLoginGuard en memoria lo cumple). */
export interface LoginGuardLike {
  isBlocked(key: string, now?: number): boolean | Promise<boolean>;
  /** Registra un fallo; devuelve true si ESTE fallo dispara el bloqueo. */
  recordFailure(key: string, now?: number): boolean | Promise<boolean>;
  recordSuccess(key: string): void | Promise<void>;
}

const LOGIN_FAILURES_ROUTE = "auth.login.failures";
/** Ventana fija ancla: el contador de fallos no es por ventana temporal sino por clave. */
const EPOCH = new Date(0);

/**
 * ERR-SEC-14 · bloqueo de fuerza bruta de login PERSISTENTE: contador de fallos y
 * blocked_until en api_usage. Reiniciar el proceso NO resetea ni el contador ni el
 * bloqueo. Los contadores expiran (expires_at) si no hay fallos nuevos.
 */
export class SharedFailedLoginGuard implements LoginGuardLike {
  constructor(
    private db: Db,
    public maxFailures = 20,
    public blockMs = 15 * 60 * 1000,
    /** Sin fallos nuevos durante este tiempo, el contador caduca. */
    public failureTtlMs = 60 * 60 * 1000,
  ) {}

  async isBlocked(key: string, now: number = Date.now()): Promise<boolean> {
    const row = await this.db("api_usage")
      .where({ actor_key: key, route: LOGIN_FAILURES_ROUTE, window_start: EPOCH })
      .first();
    if (!row) return false;
    if (row.expires_at && new Date(row.expires_at).getTime() < now && !row.blocked_until) return false;
    return !!row.blocked_until && new Date(row.blocked_until).getTime() > now;
  }

  async recordFailure(key: string, now: number = Date.now()): Promise<boolean> {
    const expiresAt = new Date(now + this.failureTtlMs);
    const [row] = await this.db("api_usage")
      .insert({ actor_key: key, route: LOGIN_FAILURES_ROUTE, window_start: EPOCH, count: 1, expires_at: expiresAt })
      .onConflict(["actor_key", "route", "window_start"])
      .merge({
        // Contador con caducidad: si el anterior expiró, se reinicia en 1.
        count: this.db.raw("CASE WHEN api_usage.expires_at < now() THEN 1 ELSE api_usage.count + 1 END"),
        expires_at: expiresAt,
      })
      .returning(["count", "blocked_until"]);
    if (Number(row.count) >= this.maxFailures) {
      const blockedUntil = new Date(now + this.blockMs);
      await this.db("api_usage")
        .where({ actor_key: key, route: LOGIN_FAILURES_ROUTE, window_start: EPOCH })
        .update({ blocked_until: blockedUntil, count: 0, expires_at: new Date(blockedUntil.getTime() + this.failureTtlMs) });
      return true;
    }
    return false;
  }

  async recordSuccess(key: string): Promise<void> {
    await this.db("api_usage").where({ actor_key: key, route: LOGIN_FAILURES_ROUTE, window_start: EPOCH }).del();
  }
}
