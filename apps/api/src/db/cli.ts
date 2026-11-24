/**
 * CLI de migraciones y seeds contra DATABASE_URL (PostgreSQL real, cap. 6.2).
 *
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts migrate
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts rollback:1
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts rollback:all
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts rollback:name <NNN_tema>
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts seed
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts bootstrap
 *   DATABASE_URL=postgres://... npx tsx apps/api/src/db/cli.ts demo-teams <email> [equipo...]
 *   ... cli.ts create-admin <email> <nombre> (--password-stdin | --password-file <ruta 0600>) [--allow-additional-admin]
 *   ... cli.ts reset-password <email> (--password-stdin | --password-file <ruta 0600>)
 *
 * `create-admin` (TD-023) crea el primer administrador SIN SQL. La contraseña
 * va por stdin o por un fichero 0600, nunca por argv; aplica la política de
 * contraseñas; se niega si ya hay un admin salvo `--allow-additional-admin`
 * (que queda auditado); no usa `seed`.
 *
 * `reset-password` (ADM-3, D-OP-8) es la vía de EMERGENCIA local cuando sólo hay un administrador (con varios se usa
 * la recuperación por token desde la web): fija la contraseña de una cuenta, cierra sus sesiones y anula sus tokens de
 * recuperación. Misma entrada segura (stdin o fichero 0600, nunca argv), política única y auditoría sin la contraseña.
 *
 * `seed` incluye usuarios de desarrollo con contraseña conocida: SOLO para
 * desarrollo. `bootstrap` aplica únicamente el contenido base (ruleset,
 * catálogo y mapa) y es el comando apto para un entorno real.
 *
 * `rollback:1` revierte SOLO la última migración DE LA LISTA entre las aplicadas (exactamente una, no un lote).
 * `rollback:name <NNN_tema>` (EQ5e) revierte UNA migración concreta por nombre,
 * esté o no al final de la historia (no depende del orden de integración).
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
import { migrateToLatest, rollbackAll, rollbackLast, rollbackNamed } from "./migrations.js";
import { seedContent, seedDev } from "./seeds/dev.js";
import { formatDemoTeamsResult, seedDemoTeams } from "./seeds/demo-teams.js";
import { createAdmin, CreateAdminError } from "../services/create-admin.js";
import {
  parseCreateAdminArgs,
  parseResetPasswordArgs,
  PasswordInputError,
  readPasswordFile,
  readPasswordStdin,
} from "./password-input.js";
import { resetPasswordLocal, ResetPasswordCliError } from "../services/account-recovery.js";

const cmd = process.argv[2];
const db = createDb();

try {
  if (cmd === "migrate") {
    await migrateToLatest(db);
    console.log("Migraciones aplicadas.");
  } else if (cmd === "rollback:1") {
    await rollbackLast(db);
    console.log("Última migración revertida (una migración, no un lote).");
  } else if (cmd === "rollback:name") {
    const name = process.argv[3];
    if (!name) {
      console.error("Uso: cli.ts rollback:name <NNN_tema> (p. ej. 017_streaming_admin)");
      process.exitCode = 2;
    } else {
      await rollbackNamed(db, name);
      console.log(`Migración ${name} revertida (sólo ésa).`);
    }
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
  } else if (cmd === "create-admin") {
    // TD-023 · primer administrador sin SQL. La contraseña NUNCA va en argv.
    try {
      const args = parseCreateAdminArgs(process.argv.slice(3));
      const password = args.source.kind === "file" ? readPasswordFile(args.source.path) : await readPasswordStdin();
      const r = await createAdmin(db, {
        email: args.email,
        displayName: args.displayName,
        password,
        allowAdditionalAdmin: args.allowAdditionalAdmin,
      });
      console.log(`Administrador creado: ${r.email} (id ${r.userId})${r.additional ? " [adicional, auditado]" : ""}.`);
    } catch (e) {
      // Códigos de salida de create-admin (documentados en docs/operations/first-run.md):
      //   0 creado · 1 ya existe un administrador · 2 uso o entrada inválidos (argumentos, fichero de
      //   contraseña inexistente o con permisos/propietario/tipo inválidos, política de contraseñas)
      //   · 3 precondición de estado (el email ya existe, o faltan los roles base: ejecuta `bootstrap`)
      //   · 4 error inesperado (sin traza; sólo el tipo y el código).
      if (e instanceof PasswordInputError) {
        console.error(`create-admin: ${e.message}`);
        process.exitCode = 2;
      } else if (e instanceof CreateAdminError) {
        console.error(`create-admin: ${e.message}`);
        process.exitCode = e.code === "invalid_input" ? 2 : e.code === "admin_exists" ? 1 : 3;
      } else {
        const err = e as { name?: string; code?: string };
        console.error(`create-admin: error inesperado (${err.name ?? "Error"}${err.code ? ` ${err.code}` : ""})`);
        process.exitCode = 4;
      }
    }
  } else if (cmd === "reset-password") {
    // ADM-3 · recuperación local de emergencia. Códigos de salida: 0 hecho · 2 uso o entrada inválidos (incluida la
    // política de contraseñas) · 3 la cuenta no existe · 4 error inesperado (sin traza).
    try {
      const args = parseResetPasswordArgs(process.argv.slice(3));
      const password = args.source.kind === "file" ? readPasswordFile(args.source.path) : await readPasswordStdin();
      const r = await resetPasswordLocal(db, { email: args.email, password });
      console.log(
        `Contraseña restablecida: ${r.email} (id ${r.userId}); sesiones cerradas: ${r.sessionsRevoked}.` +
          (r.blocked ? " AVISO: la cuenta sigue BLOQUEADA (desbloquéala desde la web)." : ""),
      );
    } catch (e) {
      if (e instanceof PasswordInputError) {
        console.error(`reset-password: ${e.message}`);
        process.exitCode = 2;
      } else if (e instanceof ResetPasswordCliError) {
        console.error(`reset-password: ${e.message}`);
        process.exitCode = e.code === "invalid_input" ? 2 : 3;
      } else {
        const err = e as { name?: string; code?: string };
        console.error(`reset-password: error inesperado (${err.name ?? "Error"}${err.code ? ` ${err.code}` : ""})`);
        process.exitCode = 4;
      }
    }
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
    console.error(
      "Uso: cli.ts <migrate|rollback:1|rollback:name|rollback:all|seed|bootstrap|create-admin|reset-password|demo-teams>",
    );
    process.exitCode = 2;
  }
} finally {
  await db.destroy();
}
