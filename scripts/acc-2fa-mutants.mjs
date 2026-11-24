#!/usr/bin/env node
/**
 * ACC-2FA · Calibración de los tests de la verificación en dos pasos con mutantes.
 *
 * Para cada mutante: el test NOMBRADO (por su etiqueta en mayúsculas) debe estar VERDE en la base y ROJO
 * con el mutante. Se lee el resultado del reporter JSON de vitest; nunca se filtra con `-t` (en vitest 4 un
 * filtro que no casa da un verde vacío). Además se exige ≥1 test aprobado en la base y que el test nombrado
 * exista en ambas ejecuciones.
 *
 * En SERIE, sobre un árbol COMMITEADO: cada mutante reescribe un fichero y lo restaura con su contenido
 * original (no con `git checkout`). Si PRODGUARD_SCRIPT apunta a la guardia de carga del entorno, espera a
 * PRODGUARD_OK antes de cada ejecución. Siempre 1 worker y prioridad baja.
 *
 * Uso: node scripts/acc-2fa-mutants.mjs [A1 W3 ...]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUTH = "apps/api/src/routes/auth.ts";
const ENROLL = "apps/api/src/auth/totp-enrollment.ts";
const USERS = "apps/api/src/routes/users.ts";
const SEC = "apps/web/src/pages/TwoFactorSection.tsx";
const LOGIN = "apps/web/src/pages/LoginPage.tsx";
const T_API = "apps/api/src/acc-2fa.test.ts";
const T_WEB = "apps/web/tests/acc-2fa-account.test.tsx";

// [id, descripción, fichero, ancla, sustituto, test, etiqueta del test que debe ponerse rojo]
const M = [
  [
    "A1",
    "setup activa la 2FA en el acto",
    AUTH,
    "    const secret = generateTotpSecret();\n    res.status(200).json({\n      otpauthUrl: totpUri(secret, user.email),\n      secret,",
    '    const secret = generateTotpSecret();\n    await db("users").where({ id: user.id }).update({ totp_secret: secret });\n    res.status(200).json({\n      otpauthUrl: totpUri(secret, user.email),\n      secret,',
    T_API,
    "SETUP_NO_ACTIVA",
  ],
  [
    "A2",
    "confirm no comprueba el código",
    AUTH,
    'if (typeof totp !== "string" || !(await consumeTotpCode(db, userId, secret, totp))) {',
    'if (typeof totp !== "string") {',
    T_API,
    "CONFIRMA_CON_CODIGO",
  ],
  [
    "A3",
    "token de alta sin atar a la sesión",
    ENROLL,
    'return Buffer.from(`${INFO}|${userId}|${sessionId}`, "utf8");',
    'return Buffer.from(`${INFO}|${userId}`, "utf8");',
    T_API,
    "TOKEN_ATADO",
  ],
  [
    "A4",
    "token de alta sin caducidad",
    ENROLL,
    "    if (p.exp * 1000 <= now) return null;\n",
    "",
    T_API,
    "TOKEN_CADUCA",
  ],
  [
    "A5",
    "confirm sin límite de intentos",
    AUTH,
    'await guarded2fa(req, userId, "confirm", async () => {',
    'await (async (_r: unknown, _u: unknown, _o: unknown, f: () => Promise<void>) => f())(req, userId, "confirm", async () => {',
    T_API,
    "CONFIRMA_LIMITE",
  ],
  [
    "A6",
    "dos confirmaciones simultáneas activan dos veces",
    AUTH,
    '      .whereNull("totp_secret") // dos confirmaciones simultáneas: sólo una activa\n',
    "",
    T_API,
    "CONFIRMA_UNA_VEZ",
  ],
  [
    "A7",
    "el paso TOTP no se consume (replay)",
    AUTH,
    "  return inserted.length === 1;",
    "  return inserted.length >= 0;",
    T_API,
    "TOTP_UN_USO",
  ],
  [
    "A8",
    "código de recuperación leer-filtrar-escribir sobre la fila ya cargada (código de main)",
    AUTH,
    '  const n = await db("users")\n    .where({ id: user.id })\n    .whereRaw("recovery_codes @> ?::jsonb", [JSON.stringify([h])])\n    .update({ recovery_codes: db.raw("recovery_codes - ?::text", [h]) });\n  return n === 1;',
    '  const hashes: string[] = Array.isArray(user.recovery_codes)\n    ? (user.recovery_codes as string[])\n    : JSON.parse((user.recovery_codes as string) ?? "[]");\n  if (!hashes.includes(h)) return false;\n  await db("users")\n    .where({ id: user.id })\n    .update({ recovery_codes: JSON.stringify(hashes.filter((x) => x !== h)) });\n  return true;',
    T_API,
    "RECUPERACION_RANCIO",
  ],
  [
    "A9",
    "código de recuperación sin normalizar",
    AUTH,
    "  const h = hashToken(normalizeRecoveryCode(code));",
    "  const h = hashToken(code);",
    T_API,
    "RECUPERACION_FORMATO",
  ],
  [
    "A10",
    "regenerar sin reautenticación",
    AUTH,
    'await guarded2fa(req, userId, "recovery_codes", () => requireStrongReauth(db, user, req.body ?? {}));',
    "void guarded2fa;",
    T_API,
    "REGENERA_REAUTH",
  ],
  [
    "A11",
    "regenerar no invalida los anteriores",
    AUTH,
    '      .whereNotNull("totp_secret")\n      .update({ recovery_codes: JSON.stringify(hashes), updated_at: db.fn.now() });',
    '      .whereNotNull("totp_secret")\n      .update({ recovery_codes: JSON.stringify([...hashes, ...(user.recovery_codes as string[])]), updated_at: db.fn.now() });',
    T_API,
    "REGENERA_INVALIDA",
  ],
  [
    "A12",
    "la auditoría guarda los códigos",
    AUTH,
    "      detail: { count: plain.length },",
    "      detail: { count: plain.length, codes: plain },",
    T_API,
    "REGENERA_INVALIDA",
  ],
  [
    "A13",
    "respuestas con secretos cacheables",
    AUTH,
    'const NO_STORE = "no-store";',
    'const NO_STORE = "private, max-age=60";',
    T_API,
    "SETUP_NO_ACTIVA",
  ],
  [
    "A14",
    "desactivar sin límite de intentos",
    AUTH,
    'await guarded2fa(req, user.id, "disable", () => requireStrongReauth(db, user, req.body ?? {}));',
    "await requireStrongReauth(db, user, req.body ?? {});",
    T_API,
    "REAUTH_LIMITE",
  ],
  [
    "A15",
    "getMe sin recuento de códigos",
    USERS,
    "    if (user.totp_secret) me.recoveryCodesRemaining = recoveryCodesCount(user.recovery_codes);\n",
    "",
    T_API,
    "RECUENTO_ME",
  ],
  [
    "A16",
    "getMe cacheable",
    USERS,
    '    res.setHeader("Cache-Control", "private, no-store");\n    res.json(me);',
    "    res.json(me);",
    T_API,
    "RECUENTO_ME",
  ],
  [
    "A17",
    "confirm no revoca las otras sesiones",
    AUTH,
    '    const revoked = await revokeOtherSessions(db, userId, req.auth!.sessionId);\n    await audit(db, {\n      actorId: userId,\n      action: "auth.2fa.enabled",',
    '    const revoked = 0;\n    await audit(db, {\n      actorId: userId,\n      action: "auth.2fa.enabled",',
    T_API,
    "CONFIRMA_CON_CODIGO",
  ],
  [
    "W1",
    "el QR codifica sólo el secreto",
    SEC,
    "<QrSvg value={stage.otpauthUrl}",
    "<QrSvg value={stage.secret}",
    T_WEB,
    "W_QR_Y_SECRETO",
  ],
  [
    "W2",
    "«Hecho» sin marcar «Los he guardado»",
    SEC,
    "onClick={finishCodes} disabled={!saved}>",
    "onClick={finishCodes} disabled={false}>",
    T_WEB,
    "W_CONFIRMA",
  ],
  [
    "W3",
    "los códigos se guardan en sessionStorage",
    SEC,
    '      resetForms();\n      setStage({ kind: "codes", codes: r.recoveryCodes, reason: "enabled" });',
    '      resetForms();\n      sessionStorage.setItem("s9_2fa", r.recoveryCodes.join(","));\n      setStage({ kind: "codes", codes: r.recoveryCodes, reason: "enabled" });',
    T_WEB,
    "W_NO_PERSISTE",
  ],
  [
    "W4",
    "el código no se limpia de espacios",
    SEC,
    '    const typed = code.replace(/\\s+/g, "");',
    "    const typed = code;",
    T_WEB,
    "W_CONFIRMA",
  ],
  [
    "W5",
    "umbral de aviso con <=",
    SEC,
    "{stage.remaining < LOW_RECOVERY_CODES && (",
    "{stage.remaining <= LOW_RECOVERY_CODES && (",
    T_WEB,
    "W_POCOS_CODIGOS",
  ],
  [
    "W6",
    "el 429 se trata como servicio caído",
    SEC,
    '  if (e.status === 429) return "Demasiados intentos fallidos: espera unos 15 minutos antes de volver a intentarlo.";\n',
    "",
    T_WEB,
    "W_CONFIRMA_ERRORES",
  ],
  [
    "W7",
    "desactivar sin enviar el código",
    SEC,
    "      const body = { password, totp: reauthCode.trim() };",
    "      const body = { password };",
    T_WEB,
    "W_DESACTIVA",
  ],
  [
    "W8",
    "un 400 (alta caducada) no vuelve al inicio",
    SEC,
    '      if (status === 400) setStage({ kind: "off" });\n',
    "",
    T_WEB,
    "W_CONFIRMA_ERRORES",
  ],
  [
    "W9",
    "el login fuerza teclado numérico",
    LOGIN,
    '                aria-label="totp"\n                autoComplete="one-time-code"',
    '                aria-label="totp"\n                inputMode="numeric"\n                autoComplete="one-time-code"',
    T_WEB,
    "W_LOGIN_RECUPERACION",
  ],
  [
    "W10",
    "el login no recorta el código",
    LOGIN,
    "...(totp.trim() ? { totp: totp.trim() } : {}),",
    "...(totp ? { totp } : {}),",
    T_WEB,
    "W_LOGIN_RECUPERACION",
  ],
];

function waitProdguard() {
  const guard = process.env.PRODGUARD_SCRIPT;
  if (!guard) return true;
  for (let i = 0; i < 360; i++) {
    const r = spawnSync("bash", [guard], { encoding: "utf8" });
    if ((r.stdout ?? "").includes("PRODGUARD_OK")) return true;
    spawnSync("sleep", ["10"]);
  }
  return false;
}

/** Ejecuta un fichero de test y devuelve { rc, tests: Map<etiqueta, estado>, passed }. */
function runTests(testFile) {
  if (!waitProdguard()) throw new Error("PRODGUARD nunca dio OK");
  const dir = mkdtempSync(join(tmpdir(), "acc2fa-mut-"));
  const out = join(dir, "r.json");
  const r = spawnSync(
    "nice",
    ["-n", "19", "npx", "vitest", "run", "--maxWorkers=1", "--reporter=json", `--outputFile=${out}`, testFile],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const tests = new Map();
  let passed = 0;
  try {
    const j = JSON.parse(readFileSync(out, "utf8"));
    for (const f of j.testResults ?? []) {
      for (const a of f.assertionResults ?? []) {
        const tag = String(a.title).split(":")[0].trim();
        tests.set(tag, a.status);
        if (a.status === "passed") passed++;
      }
    }
  } catch {
    /* sin JSON: compilación rota ⇒ sin tests */
  }
  rmSync(dir, { recursive: true, force: true });
  return { rc: r.status, tests, passed };
}

const only = process.argv.slice(2);
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();
if (dirty) {
  console.error("ARBOL_SUCIO antes de empezar (commitea primero):\n" + dirty);
  process.exit(2);
}

const baseline = new Map();
let fails = 0;
for (const [id, desc, file, anchor, repl, testFile, tag] of M) {
  if (only.length && !only.includes(id)) continue;
  if (!baseline.has(testFile)) {
    const b = runTests(testFile);
    console.log(`BASE ${testFile}: rc=${b.rc} aprobados=${b.passed}`);
    baseline.set(testFile, b);
  }
  const b = baseline.get(testFile);
  if (b.rc !== 0 || b.passed < 1 || b.tests.get(tag) !== "passed") {
    console.log(`${id} BASE_NO_VERDE (${tag}=${b.tests.get(tag)}, rc=${b.rc}, aprobados=${b.passed})`);
    fails++;
    continue;
  }
  const path = join(ROOT, file);
  const src = readFileSync(path, "utf8");
  const n = src.split(anchor).length - 1;
  if (n !== 1) {
    console.log(`${id} ANCLA_NO_UNICA (${n}) en ${file}`);
    fails++;
    continue;
  }
  writeFileSync(path, src.replace(anchor, repl));
  let r;
  try {
    r = runTests(testFile);
  } finally {
    writeFileSync(path, src);
  }
  const st = r.tests.get(tag);
  // Sólo cuenta como muerto si el test NOMBRADO se ejecutó y falló (una compilación rota no calibra nada).
  const killed = st === "failed";
  console.log(`${id} ${killed ? "MUERTO" : "VIVO"} · ${desc} · ${tag}=${st ?? "sin resultado"} rc=${r.rc}`);
  if (!killed) fails++;
}

const after = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();
console.log(after ? "ARBOL_SUCIO:\n" + after : "ARBOL_LIMPIO");
console.log(`RESUMEN fallos_calibracion=${fails}`);
process.exit(fails || after ? 1 : 0);
