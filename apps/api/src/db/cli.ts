/**
 * CLI de migraciones y seeds contra DATABASE_URL (PostgreSQL real, cap. 6.2).
 *
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts migrate
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts rollback
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts seed
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts bootstrap
 *
 * `seed` incluye usuarios de desarrollo con contraseña conocida: SOLO para
 * desarrollo. `bootstrap` aplica únicamente el contenido base (ruleset,
 * catálogo y mapa) y es el comando apto para un entorno real.
 */
import { createDb } from "./connection.js";
import { migrateToLatest, rollbackAll } from "./migrations.js";
import { seedContent, seedDev } from "./seeds/dev.js";

const cmd = process.argv[2];
const db = createDb();

try {
  if (cmd === "migrate") {
    await migrateToLatest(db);
    console.log("Migraciones aplicadas.");
  } else if (cmd === "rollback") {
    await rollbackAll(db);
    console.log("Migraciones revertidas.");
  } else if (cmd === "seed") {
    await migrateToLatest(db);
    await seedDev(db);
    console.log("Seeds de desarrollo aplicados.");
  } else if (cmd === "bootstrap") {
    await migrateToLatest(db);
    await seedContent(db);
    console.log("Contenido base aplicado (ruleset, catálogo, mapa). Sin usuarios.");
  } else {
    console.error("Uso: cli.ts <migrate|rollback|seed|bootstrap>");
    process.exitCode = 2;
  }
} finally {
  await db.destroy();
}
