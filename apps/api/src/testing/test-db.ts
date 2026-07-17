/**
 * PostgreSQL embebido para tests (ADR-E7-002).
 *
 * El entorno de desarrollo no tiene Postgres local ni Docker; `embedded-postgres`
 * descarga binarios oficiales (PostgreSQL 18.x) y arranca un clúster a nivel de
 * usuario, sin root. Los tests corren así contra PostgreSQL REAL, con el mismo SQL
 * de migraciones que producción (DATABASE_URL, cap. 6.2).
 */
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

/** Arranca un clúster embebido, crea una BD, aplica migraciones y devuelve knex. */
export async function startTestDb(opts: { migrate?: boolean } = {}): Promise<TestDbHandle> {
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
