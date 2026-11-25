#!/usr/bin/env node
/**
 * Mutantes de calibración del carril V1 ADM-SETUP (asistente web de primer arranque + kit de
 * recuperación del admin, D-OP-44).
 *
 * Cada mutante rompe UNA garantía y debe morir por un test concreto y NOMBRADO. Para no caer en el
 * verde vacío de vitest 4 (un `-t` que no casa da 0 tests y rc 0; y los nombres llevan `[` `]`,
 * metacaracteres de la expresión), NO se filtra con `-t`: se ejecuta el fichero entero con el
 * reporter JSON y se busca el test por su nombre EXACTO (subcadena literal). Se exige:
 *   - línea base: el test nombrado existe y está en `passed`, y el fichero tiene ≥1 test verde;
 *   - mutante: el test nombrado está en `failed` (≥1 rojo), y el resto del fichero no se cuenta.
 * El fichero mutado se restaura desde una copia en memoria (no `git checkout`), y al final se
 * comprueba que el árbol queda byte a byte como estaba.
 *
 * PESADO (PostgreSQL embebido): con prioridad baja y comprobando PRODGUARD antes de cada ejecución si
 * se define `S9_PRODGUARD` (ruta del script de guarda del laboratorio).
 *
 *   node scripts/v1-web-setup-mutants.mjs            # todos
 *   node scripts/v1-web-setup-mutants.mjs M-KIT-     # sólo los que empiezan por el prefijo
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T_SETUP = "apps/api/src/setup-web.test.ts";
const T_KIT = "apps/api/src/recovery-kit.test.ts";
const T_MIG = "apps/api/src/db/migration-027.test.ts";
const T_CMP = "infrastructure/tests/setup-token-compose.test.ts";
const T_INIT = "infrastructure/tests/init-secrets-nofollow.test.ts";
const T_CHK = "infrastructure/tests/check-secrets.test.ts";
const T_WEB = "apps/web/tests/setup-page.test.tsx";

const F_ROUTE = "apps/api/src/routes/setup.ts";
const F_STATE = "apps/api/src/services/install-state.ts";
const F_TOKEN = "apps/api/src/services/setup-token.ts";
const F_ADMIN = "apps/api/src/services/create-admin.ts";
const F_MIG = "apps/api/src/db/migrations.ts";
const F_KIT = "apps/api/src/routes/recovery-kit.ts";

export const MUTANTES = [
  // ---------------------------------------------------------- asistente (los 5 de la auditoría primero)
  {
    id: "M-SETUP-no-token-check",
    fichero: F_TOKEN,
    de: "return timingSafeEqual(sha256(expected), sha256(presented.trim()));",
    a: "return true;",
    test: T_SETUP,
    nombre: "[T2-token-erroneo]",
  },
  {
    id: "M-SETUP-reopen-after-admin-removed",
    fichero: F_STATE,
    de: 'if (row.setup_completed_at) return { open: false, reason: "completed" };',
    a: "",
    test: T_SETUP,
    nombre: "[T5-cierre-para-siempre]",
  },
  {
    id: "M-SETUP-no-advisory-lock",
    fichero: F_ADMIN,
    de: 'await trx.raw("SELECT pg_advisory_xact_lock(?)", [ADMIN_LOCK_KEY]);',
    a: "",
    test: T_SETUP,
    nombre: "[T6-carrera-dos-post]",
  },
  {
    id: "M-SETUP-log-token",
    fichero: F_TOKEN,
    de: "(huella ${setupTokenFingerprint(token)})",
    a: "(huella ${setupTokenFingerprint(token)} ${token})",
    test: T_SETUP,
    nombre: "[T9-log-sin-token]",
  },
  {
    id: "M-SETUP-migration-no-backfill",
    fichero: F_MIG,
    de: "CASE WHEN EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin') THEN now() END,\n               CASE WHEN EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin') THEN 'migration' END;",
    a: "NULL, NULL;",
    test: T_MIG,
    nombre: "[M027-backfill-con-admin]",
  },
  // ---------------------------------------------------------- asistente (resto)
  {
    id: "M-SETUP-status-ignores-token",
    fichero: F_STATE,
    de: 'if (!tokenPresent) return { open: false, reason: "no_token" };',
    a: "",
    test: T_SETUP,
    nombre: "[T1-status-tres-condiciones]",
  },
  {
    // Dentro del cerrojo: sin volver a mirar `install_state`, una instalación cerrada con 0 admins
    // (cerrada entre la comprobación de la ruta y el cerrojo) aceptaría otro «primer» admin web.
    // (Descartado por EQUIVALENTE: quitar sólo `adminCount > 0` de esta condición; lo cubre la
    // comprobación siguiente, `admin_exists`, que la ruta traduce al mismo 410. REV352-10.)
    id: "M-SETUP-no-recheck-in-lock",
    fichero: F_ADMIN,
    de: 'if (via === "web" && (!state || state.setup_completed_at || adminCount > 0)) {',
    a: "if (false) {",
    test: T_SETUP,
    nombre: "[T10-servicio-revalida]",
  },
  {
    id: "M-SETUP-no-close-on-web",
    fichero: F_ADMIN,
    de: "await markSetupCompleted(trx, String(user.id), via);",
    a: 'if (via === "cli") await markSetupCompleted(trx, String(user.id), via);',
    test: T_SETUP,
    nombre: "[T3-alta-correcta]",
  },
  {
    id: "M-SETUP-cli-no-close",
    fichero: F_ADMIN,
    de: "await markSetupCompleted(trx, String(user.id), via);",
    a: 'if (via === "web") await markSetupCompleted(trx, String(user.id), via);',
    test: T_SETUP,
    nombre: "[T8-cli-cierra]",
  },
  {
    id: "M-SETUP-no-policy",
    fichero: F_ADMIN,
    de: 'if (violation) throw new CreateAdminError("invalid_input", violation);',
    a: "",
    test: T_SETUP,
    nombre: "[T7-politica]",
  },
  {
    id: "M-SETUP-audit-token",
    fichero: F_ADMIN,
    de: "tokenFingerprint: input.webContext?.tokenFingerprint ?? null,",
    a: "tokenFingerprint: input.webContext?.tokenFingerprint ?? null, password: input.password,",
    test: T_SETUP,
    nombre: "[T3-alta-correcta]",
  },
  {
    id: "M-SETUP-no-reject-audit",
    fichero: F_ROUTE,
    de: 'action: "setup.token_rejected",',
    a: 'action: "setup.otra_cosa",',
    test: T_SETUP,
    nombre: "[T2-token-erroneo]",
  },
  {
    id: "M-SETUP-trigger-allows-reopen",
    fichero: F_MIG,
    de: "IF OLD.setup_completed_at IS NOT NULL AND (",
    a: "IF false AND (",
    test: T_MIG,
    nombre: "[M027-trigger-no-reabre]",
  },
  // ---------------------------------------------------------- kit de recuperación
  {
    id: "M-KIT-reusable",
    fichero: F_KIT,
    de: "if (consumed.length !== 1) return null;",
    a: "",
    test: T_KIT,
    nombre: "[K8-canje-simultaneo]",
  },
  {
    id: "M-KIT-not-consumed",
    fichero: F_KIT,
    de: ".where({ user_id: user.id, kit_hash: row.kit_hash })\n          .del()",
    a: ".where({ user_id: user.id, kit_hash: row.kit_hash })\n          .update({ created_at: trx.fn.now() })",
    test: T_KIT,
    nombre: "[K2-un-solo-uso]",
  },
  {
    id: "M-KIT-oracle-ghost",
    fichero: F_KIT,
    de: 'await reject("invalid");\n        throw unauthorized(GENERIC);',
    a: 'await reject("invalid");\n        throw unauthorized(user ? GENERIC : "no existe la cuenta");',
    test: T_KIT,
    nombre: "[K3-sin-oraculo]",
  },
  {
    id: "M-KIT-skip-2fa",
    fichero: F_KIT,
    de: "if (user.totp_secret) {\n        const guardKey",
    a: "if (false) {\n        const guardKey",
    test: T_KIT,
    nombre: "[K4-2fa-segundo-factor]",
  },
  {
    id: "M-KIT-no-reauth",
    fichero: F_KIT,
    de: "await requireStrongReauth(db, user, req.body ?? {});",
    a: "",
    test: T_KIT,
    nombre: "[K5-regenerar-reauth]",
  },
  {
    id: "M-KIT-any-role",
    fichero: F_KIT,
    de: 'const isAdmin = row ? !!(await db("user_roles").where({ user_id: user.id, role: "admin" }).first()) : false;',
    a: "const isAdmin = !!row;",
    test: T_KIT,
    nombre: "[K6-solo-admins]",
  },
  {
    id: "M-KIT-no-revoke-sessions",
    fichero: F_KIT,
    de: 'return trx("sessions").where({ user_id: user.id }).whereNull("revoked_at").update({ revoked_at: trx.fn.now() });',
    a: "return 0;",
    test: T_KIT,
    nombre: "[K1-canje-correcto]",
  },
  {
    id: "M-KIT-no-limit",
    fichero: F_KIT,
    de: 'rateLimit(deps.redeemIpLimiter, "recovery-kit"),',
    a: "",
    test: T_KIT,
    nombre: "[K7-limite]",
  },
  {
    id: "M-KIT-no-policy",
    fichero: F_KIT,
    de: "if (violation) throw badRequest(violation);",
    a: "",
    test: T_KIT,
    nombre: "[K9-politica]",
  },
  // ---------------------------------------------------------- infraestructura
  {
    id: "M-SETUP-token-en-otro-servicio",
    fichero: "infrastructure/docker-compose.yml",
    de: "secrets: [postgres_password, jwt_secret, artifact_verify_key]",
    a: "secrets: [postgres_password, jwt_secret, artifact_verify_key, setup_token]",
    test: T_CMP,
    nombre: "[INFRA-setup-token-solo-api]",
  },
  {
    id: "M-SETUP-init-no-gen",
    fichero: "infrastructure/scripts/init-secrets.sh",
    de: "\ngen setup_token.txt\n",
    a: "\n",
    test: T_INIT,
    nombre: "[INFRA-setup-token]",
  },
  // ---------------------------------------------------------- revisión de #352 (REV352-01/03/04/05/11)
  {
    id: "M-KIT-blocked-redeems",
    fichero: F_KIT,
    de: "const active = user ? accountIsActive(user) : false;",
    a: "const active = true;",
    test: T_KIT,
    nombre: "[K10-cuenta-bloqueada]",
  },
  {
    id: "M-KIT-revoke-noop",
    fichero: "apps/api/src/services/recovery-kit.ts",
    de: 'const n = await trx("admin_recovery_kits").where({ user_id: userId }).del();',
    a: "const n = 1;",
    test: T_KIT,
    nombre: "[K11-revocar-kit]",
  },
  {
    id: "M-KIT-no-2fa-guard",
    fichero: F_KIT,
    de: "if (await deps.secondFactorGuard.isBlocked(guardKey)) {",
    a: "if (false) {",
    test: T_KIT,
    nombre: "[K12-bloqueo-segundo-factor]",
  },
  {
    id: "M-SETUP-trigger-allows-delete",
    fichero: F_MIG,
    de: "CREATE TRIGGER install_state_no_delete BEFORE DELETE ON install_state\n        FOR EACH ROW EXECUTE FUNCTION install_state_no_reopen();",
    a: "",
    test: T_MIG,
    nombre: "[M027-no-delete-reabre]",
  },
  {
    id: "M-SETUP-insert-reopens",
    fichero: F_MIG,
    de: "IF NEW.setup_completed_at IS NULL AND EXISTS (SELECT 1 FROM user_roles WHERE role = 'admin') THEN",
    a: "IF false THEN",
    test: T_MIG,
    nombre: "[M027-no-delete-reabre]",
  },
  {
    id: "M-SETUP-generator-single-pass",
    fichero: "infrastructure/scripts/init-secrets.sh",
    de: 'while [ "${#out}" -lt "$n" ]; do',
    a: "for _una in 1; do",
    test: T_INIT,
    nombre: "[INFRA-generador-longitud]",
  },
  {
    // REV352-12 · reintroduce una fuente aleatoria inyectable por entorno en un script de producción.
    id: "M-SETUP-random-source-from-env",
    fichero: "infrastructure/scripts/init-secrets.sh",
    de: 'src="${2:-/dev/urandom}"',
    a: 'src="${2:-${S9_INIT_SECRETS_RANDOM_SOURCE:-/dev/urandom}}"',
    test: T_INIT,
    nombre: "[INFRA-generador-sin-fuente-de-entorno]",
  },
  {
    // REV352-13 · sin yaml, el script volvería a fallar con rc 1 (como «falta un secreto»).
    id: "M-SETUP-check-secrets-sin-yaml-rc1",
    fichero: "infrastructure/scripts/check-secrets.mjs",
    de: "process.exit(2);",
    a: "process.exit(1);",
    test: T_CHK,
    nombre: "[INFRA-check-secrets-sin-yaml]",
  },
  {
    id: "M-SETUP-check-secrets-ignora-faltantes",
    fichero: "infrastructure/scripts/check-secrets.mjs",
    de: 'missing.push({ ...s, why: "no existe" });',
    a: "",
    test: T_CHK,
    nombre: "[INFRA-check-secrets-falta]",
  },
  // ---------------------------------------------------------- web
  {
    id: "M-WEB-setup-no-reauth",
    fichero: "apps/web/src/pages/SetupPage.tsx",
    de: "{ setupToken: token.trim(), email: email.trim(), displayName: displayName.trim(), password },\n        { reauth: true },",
    a: "{ setupToken: token.trim(), email: email.trim(), displayName: displayName.trim(), password },",
    test: T_WEB,
    nombre: "[W3-recorrido-completo]",
  },
  {
    id: "M-WEB-closed-no-redirect",
    fichero: "apps/web/src/pages/SetupPage.tsx",
    de: 'window.location.hash = "#/"; // cerrado ⇒ al inicio de sesión',
    a: "",
    test: T_WEB,
    nombre: "[W2-cerrado-redirige]",
  },
  {
    id: "M-WEB-kit-no-ack",
    fichero: "apps/web/src/pages/recovery-kit-ui.tsx",
    de: "disabled={!saved}",
    a: "disabled={false}",
    test: T_WEB,
    nombre: "[W3-recorrido-completo]",
  },
  {
    id: "M-WEB-status-401-expires-session",
    fichero: "apps/web/src/pages/RecoveryKitPages.tsx",
    de: 'api<{ open: boolean }>("GET", "/setup/status", undefined, { reauth: true })',
    a: 'api<{ open: boolean }>("GET", "/setup/status")',
    // r37-session no lo detecta de forma determinista (carrera con la aserción): lo mata W4.
    test: T_WEB,
    nombre: "[W4-aviso-login]",
  },
  {
    id: "M-WEB-no-notice",
    fichero: "apps/web/src/pages/RecoveryKitPages.tsx",
    de: ".then((s) => alive && setOpen(!!s?.open))",
    a: ".then(() => alive && setOpen(false))",
    test: T_WEB,
    nombre: "[W4-aviso-login]",
  },
];

function guard() {
  const pg = process.env.S9_PRODGUARD;
  if (!pg) return;
  for (;;) {
    const r = spawnSync("bash", [pg], { encoding: "utf8" });
    if (/PRODGUARD_OK/.test(r.stdout ?? "")) return;
    console.error("PRODGUARD no está en OK: espero 60 s");
    spawnSync("sleep", ["60"]);
  }
}

/** Ejecuta un fichero de test (sin -t) y devuelve { rc, tests: [{ name, status }] }. */
function runFile(file) {
  guard();
  const dir = mkdtempSync(join(tmpdir(), "v1-web-setup-mut-"));
  const out = join(dir, "r.json");
  const r = spawnSync(
    "nice",
    ["-n", "19", "npx", "vitest", "run", "--maxWorkers=1", "--reporter=json", `--outputFile=${out}`, file],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  let tests = [];
  try {
    const j = JSON.parse(readFileSync(out, "utf8"));
    for (const f of j.testResults ?? []) {
      for (const a of f.assertionResults ?? []) tests.push({ name: a.fullName ?? a.title, status: a.status });
    }
  } catch {
    tests = [];
  }
  rmSync(dir, { recursive: true, force: true });
  return { rc: r.status, tests };
}

const find = (tests, nombre) => tests.filter((t) => String(t.name).includes(nombre));

const hashTree = () =>
  createHash("sha256")
    .update(spawnSync("git", ["diff", "HEAD"], { encoding: "utf8" }).stdout ?? "")
    .update(spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout ?? "")
    .digest("hex");

// `--check`: sólo verifica que cada patrón aparece exactamente una vez (barato, sin ejecutar tests).
if (process.argv[2] === "--check") {
  let bad = 0;
  for (const m of MUTANTES) {
    const n = readFileSync(m.fichero, "utf8").split(m.de).length - 1;
    if (n !== 1) {
      console.log(`PATRÓN ${m.id}: ${n} apariciones en ${m.fichero}`);
      bad++;
    }
  }
  console.log(`PATRONES: ${MUTANTES.length - bad}/${MUTANTES.length} únicos`);
  process.exit(bad === 0 ? 0 : 1);
}

const prefix = process.argv[2] ?? "";
const selected = MUTANTES.filter((m) => m.id.startsWith(prefix));
if (selected.length === 0) {
  console.error(`ningún mutante empieza por «${prefix}»`);
  process.exit(2);
}
const before = hashTree();

// Línea base: cada fichero implicado una vez, en verde, y cada test nombrado presente y verde.
const baseline = new Map();
let fail = 0;
for (const file of [...new Set(selected.map((m) => m.test))]) {
  const r = runFile(file);
  const passed = r.tests.filter((t) => t.status === "passed").length;
  const failed = r.tests.filter((t) => t.status === "failed").length;
  baseline.set(file, r);
  const ok = r.rc === 0 && passed >= 1 && failed === 0;
  console.log(`BASE ${ok ? "OK  " : "FAIL"} ${file} rc=${r.rc} passed=${passed} failed=${failed}`);
  if (!ok) fail++;
}
for (const m of selected) {
  const hits = find(baseline.get(m.test).tests, m.nombre);
  if (hits.length !== 1 || hits[0].status !== "passed") {
    console.log(`BASE FAIL ${m.id}: el test «${m.nombre}» no está (exactamente una vez) en verde en ${m.test}`);
    fail++;
  }
}
if (fail > 0) {
  console.log(`MUTANTES: línea base inválida (${fail}); no se lanza ningún mutante.`);
  process.exit(1);
}

let killed = 0;
for (const m of selected) {
  const original = readFileSync(m.fichero, "utf8");
  const n = original.split(m.de).length - 1;
  if (n !== 1) {
    console.log(`MUT  ERROR ${m.id}: el patrón aparece ${n} veces en ${m.fichero} (debe ser 1)`);
    fail++;
    continue;
  }
  writeFileSync(m.fichero, original.replace(m.de, m.a));
  let r;
  try {
    r = runFile(m.test);
  } finally {
    writeFileSync(m.fichero, original);
  }
  const hits = find(r.tests, m.nombre);
  const red = hits.length === 1 && hits[0].status === "failed";
  const totalRed = r.tests.filter((t) => t.status === "failed").length;
  console.log(
    `MUT  ${red ? "KILLED  " : "SURVIVED"} ${m.id} ← «${m.nombre}» (${m.test}) rc=${r.rc} rojos=${totalRed} estado=${hits[0]?.status ?? "ausente"}`,
  );
  if (red) killed++;
  else fail++;
}
const after = hashTree();
if (after !== before) {
  console.log("ÁRBOL ALTERADO tras los mutantes: revisa git status");
  fail++;
}
console.log(
  `MUTANTES: ${killed}/${selected.length} muertos por su test nombrado; árbol ${after === before ? "intacto" : "ALTERADO"}.`,
);
process.exit(fail === 0 ? 0 : 1);
