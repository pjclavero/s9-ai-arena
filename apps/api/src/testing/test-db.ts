/**
 * PostgreSQL embebido para tests (ADR-E7-002) con fallback externo (R2.3, ERR-GES-04).
 *
 * El entorno de desarrollo no tiene Postgres local ni Docker; `embedded-postgres`
 * descarga binarios oficiales (PostgreSQL 18.x) y arranca un clúster a nivel de
 * usuario, sin root. Los tests corren así contra PostgreSQL REAL, con el mismo SQL
 * de migraciones que producción (DATABASE_URL, cap. 6.2).
 *
 * En Windows el clúster embebido no arranca (pg_ctl falla, ERR-GES-04). Fallback:
 * si `DATABASE_URL` está definida, los tests usan ese servidor en vez del embebido,
 * creando una base de datos EFÍMERA con nombre único por test (aislamiento entre
 * ficheros en paralelo) y borrándola al terminar. Ver docs/getting-started.md.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { createDb, type Db } from "../db/connection.js";
import { migrateToLatest } from "../db/migrations.js";

// R1.4 (ERR-SEC-01): los tests firman y verifican tokens en el MISMO proceso.
// En vez de reintroducir un literal de secreto, activamos el modo de desarrollo
// EXPLÍCITO, que usa un secreto efímero aleatorio por proceso. Nunca en producción.
process.env.ARENA_DEV_INSECURE_SECRETS ??= "1";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export interface TestDbHandle {
  db: Db;
  url: string;
  stop(): Promise<void>;
}

/**
 * Fallback R2.3: usa un PostgreSQL externo (DATABASE_URL) en vez del embebido.
 * Crea una base de datos efímera de nombre único en ese servidor y la borra en stop().
 * El usuario de la URL necesita permiso CREATEDB.
 */
async function startExternalTestDb(
  serverUrl: string,
  opts: { migrate?: boolean },
): Promise<TestDbHandle> {
  const dbName = `arena_test_${randomBytes(8).toString("hex")}`;
  const admin = createDb(serverUrl);
  try {
    // Nombre generado aquí mismo ([a-z0-9_]), sin entrada externa: interpolable con seguridad.
    await admin.raw(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    await admin.destroy();
    throw new Error(
      `No se pudo crear la BD efímera "${dbName}" en DATABASE_URL (${serverUrl}). ` +
        `¿Servidor accesible y usuario con CREATEDB? Causa: ${(err as Error).message}`,
    );
  }

  const url = new URL(serverUrl);
  url.pathname = `/${dbName}`;
  const db = createDb(url.toString());
  if (opts.migrate !== false) await migrateToLatest(db);

  return {
    db,
    url: url.toString(),
    async stop() {
      await db.destroy();
      // FORCE (PostgreSQL ≥ 13) corta conexiones rezagadas del pool antes de borrar.
      await admin.raw(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    },
  };
}

/**
 * Arranca un PostgreSQL para el test y devuelve knex.
 * Con DATABASE_URL definida usa ese servidor (BD efímera por test); si no,
 * arranca un clúster embebido (embedded-postgres), crea la BD y migra.
 */
export async function startTestDb(opts: { migrate?: boolean } = {}): Promise<TestDbHandle> {
  const external = process.env.DATABASE_URL;
  if (external) return startExternalTestDb(external, opts);

  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "e7-pg-"));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("arena_test");

  const url = `postgres://postgres:postgres@127.0.0.1:${port}/arena_test`;
  const db = createDb(url);
  if (opts.migrate !== false) await migrateToLatest(db);

  return {
    db,
    url,
    async stop() {
      await db.destroy();
      await pg.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
