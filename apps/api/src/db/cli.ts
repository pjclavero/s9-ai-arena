/**
 * CLI de migraciones y seeds contra DATABASE_URL (PostgreSQL real, cap. 6.2).
 *
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts migrate
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts rollback:1
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts rollback:all
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts seed
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts bootstrap
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts demo-teams <email> [equipo...]
 *
 * `seed` incluye usuarios de desarrollo con contraseña conocida: SOLO para
 * desarrollo. `bootstrap` aplica únicamente el contenido base (ruleset,
 * catálogo y mapa) y es el comando apto para un entorno real.
 *
 * `rollback:1` revierte SOLO la última migración aplicada (exactamente una migración, no un lote).
 * `rollback:all` revierte TODAS las migraciones: es DESTRUCTIVA, borra el
 * esquema entero (todas las tablas), no solo la última. No hay `rollback`
 * a secas: un operador debe elegir explícitamente cuál de las dos quiere,
 * para no destruir el esquema completo pensando que deshace un solo paso.
 *
 * `demo-teams` crea equipos de tres bots para un usuario QUE YA EXISTE, con
 * código de los bots de ejemplo y loadouts de arquetipo validados. Las
 * versiones quedan en `draft`: la validación en sandbox no se salta.
 */
import { createDb } from "./connection.js";
import { migrateToLatest, rollbackAll, rollbackLast } from "./migrations.js";
import { seedContent, seedDev } from "./seeds/dev.js";
import { formatDemoTeamsResult, seedDemoTeams } from "./seeds/demo-teams.js";

const cmd = process.argv[2];
const db = createDb();

try {
  if (cmd === "migrate") {
    await migrateToLatest(db);
    console.log("Migraciones aplicadas.");
  } else if (cmd === "rollback:1") {
    await rollbackLast(db);
    console.log("Última migración revertida (una migración, no un lote).");
  } else if (cmd === "rollback:all") {
    console.warn("ATENCIÓN: rollback:all revierte TODAS las migraciones y destruye el esquema completo.");
    await rollbackAll(db);
    console.log("Todas las migraciones revertidas (esquema destruido).");
  } else if (cmd === "rollback") {
    console.error(
      "Uso ambiguo: 'rollback' ya no existe. Usa 'rollback:1' (revierte solo la última " +
        "migración) o 'rollback:all' (DESTRUCTIVA: revierte todas y borra el esquema entero).",
    );
    process.exitCode = 2;
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
    console.error("Uso: cli.ts <migrate|rollback:1|rollback:all|seed|bootstrap|demo-teams>");
    process.exitCode = 2;
  }
} finally {
  await db.destroy();
}
