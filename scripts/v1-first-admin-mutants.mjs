#!/usr/bin/env node
/**
 * Mutantes de calibración del carril B2 (create-admin + etiquetas, AUD2-08/TD-023).
 *
 * Cada mutante rompe UNA garantía y debe morir por un test concreto y NOMBRADO
 * (`vitest -t`). Línea base en verde primero; el fichero se restaura con
 * `git checkout` (commitea antes de lanzar: el harness revierte el árbol).
 * PESADO (PostgreSQL embebido): sólo en el laboratorio, nunca en el host de orquestación.
 *
 *   node scripts/v1-first-admin-mutants.mjs
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const T_DB = "apps/api/src/db/create-admin.test.ts";
const T_ENV = "infrastructure/tests/check-env.test.ts";

const MUTANTES = [
  {
    id: "M1-politica-sin-minimo",
    fichero: "apps/api/src/auth/passwords.ts",
    de: "password.length < PASSWORD_MIN_LENGTH",
    a: "password.length < 1",
    test: T_DB,
    nombre: "aplica la política de contraseñas",
  },
  {
    id: "M2-permite-segundo-admin-sin-flag",
    fichero: "apps/api/src/services/create-admin.ts",
    de: "adminCount > 0 && !input.allowAdditionalAdmin",
    a: "false",
    test: T_DB,
    nombre: "se niega si ya existe un admin",
  },
  {
    id: "M3-sin-cerrojo-consultivo",
    fichero: "apps/api/src/services/create-admin.ts",
    de: 'await trx.raw("SELECT pg_advisory_xact_lock(?)", [ADMIN_LOCK_KEY]);',
    a: "",
    test: T_DB,
    nombre: "dos altas simultáneas",
  },
  {
    id: "M4-auditoria-no-marca-adicional",
    fichero: "apps/api/src/services/create-admin.ts",
    de: "additional: adminCount > 0, existingAdmins",
    a: "additional: false, existingAdmins",
    test: T_DB,
    nombre: "con allowAdditionalAdmin crea el segundo",
  },
  {
    id: "M5-sin-rol-admin",
    fichero: "apps/api/src/services/create-admin.ts",
    de: '      { user_id: user.id, role: "admin" },\n',
    a: "",
    test: T_DB,
    nombre: "instalación vacía: crea el admin",
  },
  {
    id: "M6-promueve-cuenta-existente",
    fichero: "apps/api/src/services/create-admin.ts",
    de: 'if (await trx("users").where({ email }).first()) {',
    a: "if (false) {",
    test: T_DB,
    nombre: "no promueve una cuenta existente",
  },
  {
    id: "M7-fichero-con-permisos-abiertos",
    fichero: "apps/api/src/db/password-input.ts",
    de: "if ((st.mode & 0o077) !== 0) {",
    a: "if (false) {",
    test: T_DB,
    nombre: "fichero con permisos abiertos se rechaza",
  },
  {
    id: "M8-acepta-password-en-argv",
    fichero: "apps/api/src/db/password-input.ts",
    de: '/^--?password(=|$)/.test(a) || a === "-p"',
    a: "false",
    test: T_DB,
    nombre: "rechaza TODA forma de contraseña en argv",
  },
  {
    id: "M9-cli-sin-comprobar-admin-en-proceso",
    fichero: "apps/api/src/db/cli.ts",
    de: "allowAdditionalAdmin: args.allowAdditionalAdmin,",
    a: "allowAdditionalAdmin: true,",
    test: T_DB,
    nombre: "con un admin existente: rc=1 sin flag",
  },
  {
    id: "M10-puerta-acepta-latest",
    fichero: "infrastructure/scripts/check-env.mjs",
    de: "/^(sha-[0-9a-f]{7,40}|v",
    a: "/^(latest|sha-[0-9a-f]{7,40}|v",
    test: T_ENV,
    nombre: "TAG=latest falla en cerrado",
  },
  {
    id: "M11-backup-tag-no-obligatoria",
    fichero: "infrastructure/scripts/check-env.mjs",
    de: 'export const TAGS_OBLIGATORIAS = ["TAG", "BACKUP_TAG"];',
    a: 'export const TAGS_OBLIGATORIAS = ["TAG"];',
    test: T_ENV,
    nombre: "BACKUP_TAG ausente falla",
  },
  {
    id: "M12-ignora-entorno-del-shell",
    fichero: "infrastructure/scripts/check-env.mjs",
    de: "for (const k of Object.keys(envShell)) if",
    a: "for (const k of []) if",
    test: T_ENV,
    nombre: "se valida el valor EFECTIVO",
  },
  {
    id: "M13-fichero-ausente-es-aprobado",
    fichero: "infrastructure/scripts/check-env.mjs",
    de: "    return 2;\n  }\n  const r =",
    a: "    return 0;\n  }\n  const r =",
    test: T_ENV,
    nombre: "fichero inexistente es NO COMPROBADO",
  },
  {
    id: "M14-ejemplo-vuelve-a-latest",
    fichero: "infrastructure/.env.example",
    de: "\nTAG=\n",
    a: "\nTAG=latest\n",
    test: T_ENV,
    nombre: "ninguna variable de etiqueta trae `latest`",
  },
];

function vitest(test, nombre) {
  const r = spawnSync(
    "npx",
    ["vitest", "run", "--maxWorkers=1", test, "-t", nombre],
    { encoding: "utf8", env: { ...process.env, CI: "1" } },
  );
  return { rc: r.status, out: r.stdout + r.stderr };
}

let fallos = 0;
// Línea base: cada test nombrado en verde y encontrado (rc 0 con «No test» sería un verde vacuo).
for (const m of MUTANTES) {
  const b = vitest(m.test, m.nombre);
  if (b.rc !== 0 || /no tests? found/i.test(b.out)) {
    console.log(`BASE ROJA ${m.id} rc=${b.rc}`);
    fallos++;
  }
}
if (fallos) process.exit(2);
console.log(`LÍNEA BASE VERDE (${MUTANTES.length} pruebas nombradas)`);

for (const m of MUTANTES) {
  const orig = readFileSync(m.fichero, "utf8");
  if (!orig.includes(m.de)) {
    console.log(`MUTANTE NO APLICABLE ${m.id}: el texto objetivo no está en ${m.fichero}`);
    fallos++;
    continue;
  }
  writeFileSync(m.fichero, orig.replace(m.de, m.a));
  let r;
  try {
    r = vitest(m.test, m.nombre);
  } finally {
    spawnSync("git", ["checkout", "--", m.fichero]);
  }
  const murio = r.rc !== 0;
  console.log(`${murio ? "MUERTO " : "VIVO   "} ${m.id}  (test: "${m.nombre}", rc=${r.rc})`);
  if (!murio) fallos++;
}
const sucio = spawnSync("git", ["status", "--porcelain", "--", "apps", "infrastructure", "scripts"], { encoding: "utf8" }).stdout.trim();
if (sucio) {
  console.log(`ÁRBOL SUCIO tras los mutantes:\n${sucio}`);
  fallos++;
}
console.log(fallos ? `FALLO: ${fallos}` : `TODOS LOS MUTANTES MUEREN (${MUTANTES.length}); árbol limpio`);
process.exit(fallos ? 1 : 0);
