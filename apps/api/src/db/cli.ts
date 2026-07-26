/**
 * CLI de migraciones y seeds contra DATABASE_URL (PostgreSQL real, cap. 6.2).
 *
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts migrate
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts rollback
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts seed
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts bootstrap
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts demo-teams <email> [equipo...]
 *
 * `seed` incluye usuarios de desarrollo con contraseña conocida: SOLO para
 * desarrollo. `bootstrap` aplica únicamente el contenido base (ruleset,
 * catálogo y mapa) y es el comando apto para un entorno real.
 *
 * `demo-teams` crea equipos de tres bots para un usuario QUE YA EXISTE, con
 * código de los bots de ejemplo y loadouts de arquetipo validados. Las
 * versiones quedan en `draft`: la validación en sandbox no se salta.
 */
import { createDb } from "./connection.js";
import { migrateToLatest, rollbackAll } from "./migrations.js";
import { seedContent, seedDev } from "./seeds/dev.js";
import { formatDemoTeamsResult, seedDemoTeams } from "./seeds/demo-teams.js";

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
  } else if (cmd === "demo-teams") {
    const email = process.argv[3];
    if (!email) {
      console.error("Uso: cli.ts demo-teams <email-del-propietario> [nombre-equipo...]");
      process.exitCode = 2;
    } else {
      const teams = process.argv.slice(4);
      const r = await seedDemoTeams(db, email, teams.length > 0 ? teams : undefined);
      console.log(formatDemoTeamsResult(r));
    }
  } else {
    console.error("Uso: cli.ts <migrate|rollback|seed|bootstrap|demo-teams>");
    process.exitCode = 2;
  }
} finally {
  await db.destroy();
}
