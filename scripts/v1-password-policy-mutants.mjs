#!/usr/bin/env node
/**
 * Mutantes de calibración de la política de contraseñas (V1, PASSWORD-POLICY).
 *
 * Cada mutante rompe UNA garantía y debe morir por un test concreto y NOMBRADO (`vitest -t`).
 * Línea base en verde primero; el fichero se restaura con `git checkout` (commitea antes de lanzar:
 * el harness revierte el árbol). Los de punto de entrada usan PostgreSQL embebido: sólo con PRODGUARD_OK.
 *
 *   node scripts/v1-password-policy-mutants.mjs [id ...]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PW = "apps/api/src/auth/passwords.ts";
const CL = "apps/api/src/auth/common-passwords.ts";
const RT = "apps/api/src/routes/auth.ts";
const CA = "apps/api/src/services/create-admin.ts";
const T_U = "apps/api/src/auth/passwords.test.ts";
const T_I = "apps/api/src/v1-password-policy.test.ts";

const m = (id, fichero, de, a, test, nombre) => ({ id, fichero, de, a, test, nombre });
const FOLD = 'const fold = (s: string): string => s.normalize("NFC").toLowerCase();';
const CA_DE = 'if (violation) throw new CreateAdminError("invalid_input", violation);';
const CA_A = 'if (false) throw new CreateAdminError("invalid_input", violation);';
const MUTANTES = [
  m(
    "P1-sin-tope",
    PW,
    "if (length > MAX_PASSWORD_LENGTH)",
    "if (false)",
    T_U,
    "128 caracteres se aceptan y 129 se rechazan",
  ),
  m(
    "P2-tope-off-by-one",
    PW,
    "if (length > MAX_PASSWORD_LENGTH)",
    "if (length >= MAX_PASSWORD_LENGTH)",
    T_U,
    "128 caracteres se aceptan y 129 se rechazan",
  ),
  m(
    "P3-cuenta-unidades-utf16",
    PW,
    "const length = [...folded].length;",
    "const length = folded.length;",
    T_U,
    "emoji y multibyte cuentan como UN carácter",
  ),
  m(
    "P4-sin-nfc",
    PW,
    FOLD,
    "const fold = (s: string): string => s.toLowerCase();",
    T_U,
    "se cuenta tras normalizar a NFC",
  ),
  m(
    "P5-sin-blocklist",
    PW,
    "if (commonPasswords().has(folded))",
    "if (false)",
    T_U,
    "rechaza una contraseña común sin distinguir mayúsculas",
  ),
  m(
    "P6-blocklist-distingue-mayusculas",
    PW,
    FOLD,
    'const fold = (s: string): string => s.normalize("NFC");',
    T_U,
    "rechaza una contraseña común sin distinguir mayúsculas",
  ),
  m(
    "P7-sin-derivadas-de-cuenta",
    PW,
    "if (folded === s || sinCola === s)",
    "if (false)",
    T_U,
    "rechaza el email, su parte local",
  ),
  m(
    "P8-regla-de-composicion",
    PW,
    "  return null;\n}\n\nexport function verifyPassword",
    "  if (!/[0-9]/.test(password)) return `${sujeto} debe incluir un número`;\n  return null;\n}\n\nexport function verifyPassword",
    T_U,
    "no exige mayúsculas, cifras ni símbolos",
  ),
  m("P9-minimo-8", PW, "MIN_PASSWORD_LENGTH = 12;", "MIN_PASSWORD_LENGTH = 8;", T_U, "el mínimo sigue siendo 12"),
  m("P10-no-string-pasa", PW, 'if (typeof password !== "string") {', "if (false) {", T_U, "el mínimo sigue siendo 12"),
  m(
    "P11-mensaje-filtra-la-contrasena",
    PW,
    "${sujeto} es demasiado común",
    "${sujeto} (${password}) es demasiado común",
    T_U,
    "el mensaje no revela la contraseña",
  ),
  m(
    "P12-lista-con-entrada-mal-formada",
    CL,
    "readonly string[] = [\n",
    'readonly string[] = [\n  "Corta",\n',
    T_U,
    "la lista es versionada",
  ),
  m(
    "E1-registro-sin-politica",
    RT,
    "if (violation) throw badRequest(violation);\n      if (typeof displayName",
    "if (false) throw badRequest(violation);\n      if (typeof displayName",
    T_I,
    "registro rechaza 129 caracteres",
  ),
  m(
    "E2-cambio-sin-politica",
    RT,
    "if (violation) throw badRequest(violation);\n      // Política ANTES",
    "if (false) throw badRequest(violation);\n      // Política ANTES",
    T_I,
    "cambio rechaza 129 caracteres",
  ),
  m(
    "E3-reset-sin-politica",
    RT,
    "if (generic) throw badRequest(generic);",
    "if (false) throw badRequest(generic);",
    T_I,
    "reset rechaza 129 caracteres",
  ),
  m(
    "E4-reset-sin-derivadas-de-cuenta",
    RT,
    "if (ownerViolation) throw badRequest(ownerViolation);",
    "if (false) throw badRequest(ownerViolation);",
    T_I,
    "reset rechaza 129 caracteres",
  ),
  m("E5-createadmin-sin-politica", CA, CA_DE, CA_A, T_I, "createAdmin rechaza 129 caracteres"),
  m("E6-cli-sin-politica", CA, CA_DE, CA_A, T_I, "CLI create-admin"),
];

function vitest(test, nombre) {
  const r = spawnSync("npx", ["vitest", "run", "--maxWorkers=1", test, "-t", nombre], {
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return { rc: r.status, out: r.stdout + r.stderr };
}

// Opcional: ids de mutantes a ejecutar.
const SOLO = process.argv.slice(2);
if (SOLO.length)
  for (let i = MUTANTES.length - 1; i >= 0; i--) if (!SOLO.includes(MUTANTES[i].id)) MUTANTES.splice(i, 1);
let fallos = 0;
// Línea base: cada test nombrado en verde y encontrado (rc 0 con «No test» sería un verde vacuo).
const vistos = new Set();
for (const mu of MUTANTES) {
  const clave = `${mu.test}|${mu.nombre}`;
  if (vistos.has(clave)) continue;
  vistos.add(clave);
  const b = vitest(mu.test, mu.nombre);
  if (b.rc !== 0 || /no tests? found/i.test(b.out)) {
    console.log(`BASE ROJA ${mu.id} rc=${b.rc}`);
    fallos++;
  }
}
if (fallos) process.exit(2);
console.log(`LÍNEA BASE VERDE (${vistos.size} pruebas nombradas)`);

for (const mu of MUTANTES) {
  const orig = readFileSync(mu.fichero, "utf8");
  if (!orig.includes(mu.de)) {
    console.log(`MUTANTE NO APLICABLE ${mu.id}: el texto objetivo no está en ${mu.fichero}`);
    fallos++;
    continue;
  }
  writeFileSync(
    mu.fichero,
    orig.replace(mu.de, () => mu.a),
  );
  let r;
  try {
    r = vitest(mu.test, mu.nombre);
  } finally {
    spawnSync("git", ["checkout", "--", mu.fichero]);
  }
  const murio = r.rc !== 0;
  console.log(`${murio ? "MUERTO " : "VIVO   "} ${mu.id}  (test: "${mu.nombre}", rc=${r.rc})`);
  if (!murio) fallos++;
}
const sucio = spawnSync("git", ["status", "--porcelain", "--", "apps", "scripts"], { encoding: "utf8" }).stdout.trim();
if (sucio) {
  console.log(`ÁRBOL SUCIO tras los mutantes:\n${sucio}`);
  fallos++;
}
console.log(fallos ? `FALLO: ${fallos}` : `TODOS LOS MUTANTES MUEREN (${MUTANTES.length}); árbol limpio`);
process.exit(fallos ? 1 : 0);
