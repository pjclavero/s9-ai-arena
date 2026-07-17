/**
 * T7.1 · Conexión a PostgreSQL vía DATABASE_URL (cap. 6.2).
 *
 * La API SIEMPRE habla PostgreSQL real: en producción el del servidor (DATABASE_URL),
 * en tests un PostgreSQL embebido a nivel de usuario (src/testing/test-db.ts).
 * Ver docs/decisiones/ADR-E7-001 (Knex) y ADR-E7-002 (embedded-postgres en tests).
 *
 * Sin DATABASE_URL, el DSN se construye con PGHOST/PGUSER/PGDATABASE y la
 * contraseña LEÍDA DE PGPASSWORD_FILE (secreto por archivo del Compose): así la
 * contraseña nunca viaja en una variable de entorno. Sin ninguna de las dos
 * fuentes se falla cerrado: un servicio sin BD no arranca.
 */
import { readFileSync } from "node:fs";
import knex, { type Knex } from "knex";

export type Db = Knex;

function dsnFromEnv(): string {
  const host = process.env.PGHOST;
  if (!host) return "";
  const user = process.env.PGUSER ?? "arena";
  const database = process.env.PGDATABASE ?? "arena";
  const port = process.env.PGPORT ?? "5432";
  const file = process.env.PGPASSWORD_FILE;
  const password = file ? readFileSync(file, "utf8").trim() : (process.env.PGPASSWORD ?? "");
  if (!password) return "";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

export function createDb(databaseUrl: string = process.env.DATABASE_URL ?? ""): Db {
  const url = databaseUrl || dsnFromEnv();
  if (!url) {
    throw new Error(
      "Sin conexión a PostgreSQL: define DATABASE_URL, o PGHOST + PGPASSWORD_FILE (cap. 6.2)",
    );
  }
  return knex({
    client: "pg",
    connection: url,
    pool: { min: 0, max: 8 },
  });
}
