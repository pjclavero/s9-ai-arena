/**
 * T7.1 · Conexión a PostgreSQL vía DATABASE_URL (cap. 6.2).
 *
 * La API SIEMPRE habla PostgreSQL real: en producción el del servidor (DATABASE_URL),
 * en tests un PostgreSQL embebido a nivel de usuario (src/testing/test-db.ts).
 * Ver docs/decisiones/ADR-E7-001 (Knex) y ADR-E7-002 (embedded-postgres en tests).
 */
import knex, { type Knex } from "knex";

export type Db = Knex;

export function createDb(databaseUrl: string = process.env.DATABASE_URL ?? ""): Db {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL no definida: la API no arranca sin PostgreSQL (cap. 6.2)");
  }
  return knex({
    client: "pg",
    connection: databaseUrl,
    pool: { min: 0, max: 8 },
  });
}
