/**
 * ACC-2FA (REV-1) · Límite de intentos con RESERVA ATÓMICA, persistente en `api_usage`.
 *
 * El guard clásico (isBlocked → comprobar → recordFailure) es TOCTOU: N peticiones simultáneas pasan todas
 * el `isBlocked` antes de que se registre ningún fallo, y las N se evalúan. Aquí el intento se RESERVA antes
 * de comprobar nada, con una sola sentencia `INSERT … ON CONFLICT … DO UPDATE … RETURNING`: PostgreSQL
 * serializa las actualizaciones de la fila, cada petición recibe un número de intento distinto y sólo las
 * `max` primeras se evalúan. La que excede el máximo fija `blocked_until`.
 *
 *  - éxito  ⇒ `release()` borra el contador (el usuario legítimo vuelve a empezar);
 *  - fallo  ⇒ el intento ya quedó contado;
 *  - `refund()` ⇒ devuelve el intento (p. ej. repetir el código recién usado no es fuerza bruta, REV-5).
 */
import type { Db } from "../db/connection.js";

export const TWO_FACTOR_ATTEMPTS_ROUTE = "auth.2fa.attempts";
const EPOCH = new Date(0);

export interface AttemptReservation {
  /** true si el intento puede evaluarse; false ⇒ responder 429. */
  allowed: boolean;
  /** true sólo en la petición que acaba de disparar el bloqueo (para auditarlo una vez). */
  justBlocked: boolean;
}

export class AtomicAttemptGuard {
  constructor(
    private db: Db,
    public maxAttempts = 5,
    public blockMs = 15 * 60 * 1000,
    /** Sin intentos nuevos durante este tiempo, el contador caduca. */
    public ttlMs = 60 * 60 * 1000,
  ) {}

  async reserve(key: string, now: number = Date.now()): Promise<AttemptReservation> {
    const nowD = new Date(now);
    const expiresAt = new Date(now + this.ttlMs);
    const rows = (await this.db.raw(
      `INSERT INTO api_usage (actor_key, route, window_start, count, expires_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (actor_key, route, window_start) DO UPDATE SET
         count = CASE
           WHEN api_usage.blocked_until IS NOT NULL AND api_usage.blocked_until > ? THEN api_usage.count
           WHEN api_usage.blocked_until IS NOT NULL OR api_usage.expires_at < ? THEN 1
           ELSE api_usage.count + 1 END,
         blocked_until = CASE
           WHEN api_usage.blocked_until IS NOT NULL AND api_usage.blocked_until > ? THEN api_usage.blocked_until
           ELSE NULL END,
         expires_at = EXCLUDED.expires_at
       RETURNING count, blocked_until`,
      [key, TWO_FACTOR_ATTEMPTS_ROUTE, EPOCH, expiresAt, nowD, nowD, nowD],
    )) as { rows: { count: number; blocked_until: Date | null }[] };
    const row = rows.rows[0];
    if (row.blocked_until && new Date(row.blocked_until).getTime() > now) {
      return { allowed: false, justBlocked: false };
    }
    if (Number(row.count) <= this.maxAttempts) return { allowed: true, justBlocked: false };
    // Excede: fija el bloqueo una sola vez (la primera que llega con blocked_until NULL).
    const blockedUntil = new Date(now + this.blockMs);
    const set = await this.db("api_usage")
      .where({ actor_key: key, route: TWO_FACTOR_ATTEMPTS_ROUTE, window_start: EPOCH })
      .whereNull("blocked_until")
      .update({ blocked_until: blockedUntil, expires_at: new Date(blockedUntil.getTime() + this.ttlMs) });
    return { allowed: false, justBlocked: set === 1 };
  }

  async release(key: string): Promise<void> {
    await this.db("api_usage")
      .where({ actor_key: key, route: TWO_FACTOR_ATTEMPTS_ROUTE, window_start: EPOCH })
      .whereNull("blocked_until")
      .del();
  }

  async refund(key: string): Promise<void> {
    await this.db("api_usage")
      .where({ actor_key: key, route: TWO_FACTOR_ATTEMPTS_ROUTE, window_start: EPOCH })
      .whereNull("blocked_until")
      .where("count", ">", 0)
      .update({ count: this.db.raw("count - 1") });
  }
}
