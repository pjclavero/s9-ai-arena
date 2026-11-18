#!/usr/bin/env python3
"""PORTABLE · Calibración del export/import de bots y equipos: cada mutante rompe UNA garantía y
debe poner en ROJO el test indicado (por su nombre), con la línea base en verde y el árbol limpio
después.

Uso:  python3 scripts/portable/mutants.py [M1 M2 ...]
Serie, nunca en paralelo sobre el mismo árbol. COMMITEA ANTES: el script restaura cada fichero tras
su mutante, pero no protege cambios sin commitear. Exige PostgreSQL de test (como `npm run test:db`).
Ejecutar SÓLO en el laboratorio de pruebas (no en el host de orquestación).
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FMT = "scripts/portable/lib/format.mjs"
IMP = "scripts/portable/lib/import.mjs"
EXP = "scripts/portable/lib/export.mjs"
API = "scripts/portable/lib/api.mjs"
CLI = "scripts/portable/portable.mjs"
GUARD = "scripts/portable/e2e/guard.sh"
T_FMT = "apps/api/src/portable-format.test.ts"
T_RT = "apps/api/src/portable-roundtrip.test.ts"
LOG = os.environ.get("PORTABLE_MUT_LOGDIR", "/tmp")

# (id y descripción, [(fichero, ancla, sustitución)], [tests a ejecutar], fragmento de nombre del test que debe caer)
M = [
    ("M1 no_checksum: el import/verify no comprueba los hashes",
     [(FMT, 'if (sha256Hex(readFileSync(join(dir, ...rel.split("/")))) !== want) {', "if (false) {"),
      (FMT, 'if (sha256Hex(buf) !== f.sha256 || (typeof f.bytes === "number" && buf.length !== f.bytes)) {', "if (false) {")],
     [T_FMT], "M1 ·"),
    ("M2 write_before_validate: el import escribe antes de validar el export",
     [(IMP, 'import { readFileSync } from "node:fs";', 'import { readFileSync, readdirSync } from "node:fs";'),
      (IMP, "  const { manifest, bots, teams } = verifyExport(src, limits);\n  assertEngineCompatible(manifest.engineVersion, targetEngine);",
       '  const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));\n'
       '  const bots = readdirSync(join(src, "bots")).map((s) => JSON.parse(readFileSync(join(src, "bots", s, "bot.json"), "utf8")));\n'
       "  const teams = [];\n  const __late = () => verifyExport(src);\n"
       "  assertEngineCompatible(manifest.engineVersion, targetEngine);"),
      (IMP, "  // (3) equipos\n", "  __late();\n  // (3) equipos\n")],
     [T_FMT, T_RT], "M2 ·"),
    ("M3 secret_leak: el export mete el id y el correo del dueño y no escanea",
     [(EXP, "        visibility: bot.visibility,\n        retired: !!bot.retiredAt,",
       "        visibility: bot.visibility,\n        ownerId: bot.ownerId,\n        email: me.email,\n        retired: !!bot.retiredAt,"),
      (EXP, "  if (hits.length)\n    throw new PortableError(", "  if (false)\n    throw new PortableError(")],
     [T_RT], "M3 ·"),
    ("M3b secret_scanner_blind: el escáner deja de detectar correos",
     [(FMT, '    if (EMAIL_RE.test(probe)) hits.push(`${label}: contiene un correo electrónico`);\n', "")],
     [T_FMT], "M3 ·"),
    ("M4a dup_bots: el import repetido no reconoce el bot existente",
     [(IMP, "let target = existingBots.get(bot.name);", "let target = undefined;")],
     [T_RT], "M4 ·"),
    ("M4b dup_versions: el import repetido no reconoce la versión existente",
     [(IMP, "const found = existingVersions.get(`${v.source.sha256}|${v.runtime}|${lk}`);", "const found = undefined;")],
     [T_RT], "M4 ·"),
    ("M5 team_dangling_bot: un equipo puede referenciar un bot que no existe (verify)",
     [(FMT, 'if (typeof b !== "string" || !botSlugs.has(b)) {', 'if (typeof b !== "string") {')],
     [T_FMT], "M5 ·"),
    ("M5b team_missing_bot_silent: un equipo con un bot que falló se da por bueno",
     [(IMP, "          teamFail(`el bot «${slug}» no está en el destino (¿falló su import?): equipo incompleto.`);\n", "")],
     [T_RT], "M5 ·"),
    ("M6 engine_newer: se importa un export de un motor más nuevo",
     [(FMT, "if (compareVersions(sourceEngine, targetEngine) > 0) {", "if (false) {")],
     [T_FMT], "M6 ·"),
    ("M6b engine_unknown: se acepta un motor desconocido en el export",
     [(FMT, "if (!SUPPORTED_ENGINE_VERSIONS.includes(sourceEngine)) {", "if (false) {")],
     [T_FMT], "M6 ·"),
    ("M7 format_version: no se comprueba formatVersion",
     [(FMT, "if (manifest.formatVersion !== FORMAT_VERSION) {", "if (false) {")],
     [T_FMT], "M7 ·"),
    ("M8 selection_drops_draft: la política heads pierde el último borrador",
     [(FMT, '  if (draft && !chosen.has(draft.version)) chosen.set(draft.version, "latest_draft");\n', "")],
     [T_FMT, T_RT], "última publicada + última en borrador"),
    ("M9 export_overwrites: el export sobrescribe un destino no vacío",
     [(EXP, "if (existsSync(dest) && readdirSync(dest).length > 0) {", "if (false) {")],
     [T_RT], "no sobrescribe"),
    ("M10 dry_run_writes: --dry-run crea bots de verdad",
     [(IMP, "        if (!dryRun) {\n          log(`crear bot ${bot.slug}`);", "        if (true) {\n          log(`crear bot ${bot.slug}`);")],
     [T_RT], "--dry-run"),
    # ---------------------------------------------------------------- RONDA 2 (revisión independiente del PR #300)
    ("R5 credenciales_argv: el CLI acepta --password/--token por argv",
     [(CLI, '  "token-stdin": { type: "boolean" },', '  "token-stdin": { type: "boolean" },\n  password: { type: "string" },\n  token: { type: "string" },')],
     [T_FMT], "R5 ·"),
    ("R5b argv_sin_mensaje_explicito: una opción con pinta de credencial deja de dar credentials_argv",
     [(CLI, "      if (CREDENTIAL_LIKE.test(flag))", "      if (false)")],
     [T_FMT], "R5 ·"),
    ("R7 hash_tras_import_ignorado: no se verifica el hash del código en el destino",
     [(IMP, "if (d.sourceSha256 !== v.source.sha256) {", "if (false) {")],
     [T_FMT], "R7 ·"),
    ("R9 export_marker_ausente: el export no deja marcador de incompleto al empezar",
     [(EXP, '  writeFileSync(join(dest, INCOMPLETE_MARKER), "export en curso o fallido\\n");\n', "")],
     [T_FMT], "R9 ·"),
    ("R10 motor_obligatorio_roto: runExport acepta engineVersion vacío",
     [(EXP, "  if (!engineVersion)\n    throw", "  if (false)\n    throw")],
     [T_FMT], "R10 ·"),
    ("R12 padre_colgante: se acepta una versión con padre inexistente",
     [(FMT, "if (v.parentVersion != null && !vers.has(v.parentVersion)) {", "if (false) {")],
     [T_FMT], "R12 ·"),
    ("R13 secreto_conocido_ignorado: el export no pasa los valores sensibles conocidos al escáner",
     [(EXP, "const hits = scanExportDir(dest, files, known);", "const hits = scanExportDir(dest, files, []);")],
     [T_FMT], "R13 ·"),
    ("R1a traversal_verify: safeRel acepta cualquier ruta",
     [(FMT, "function safeRel(p) {\n", 'function safeRel(p) {\n  return typeof p === "string";\n')],
     [T_FMT], "R1a ·"),
    ("R1b slug_abierto: SLUG_RE acepta cualquier cosa",
     [(FMT, "export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;", "export const SLUG_RE = /^.+$/;")],
     [T_FMT], "R1b ·"),
    ("V1 politica_por_defecto_heads: el valor por defecto vuelve a ser heads (pierde congeladas)",
     [(FMT, 'export const DEFAULT_VERSIONS_POLICY = "all";', 'export const DEFAULT_VERSIONS_POLICY = "heads";')],
     [T_FMT, T_RT], "P1-3 ·"),
    ("V2 export_ignora_politica_por_defecto: runExport usa heads si no se le dice otra cosa",
     [(EXP, "  versionsPolicy = DEFAULT_VERSIONS_POLICY,", '  versionsPolicy = "heads",')],
     [T_FMT], "sin versionsPolicy el export lleva TODAS"),
    ("S1 sin_tope_por_fichero: verifyExport no limita el tamaño de un fichero",
     [(FMT, "    if (size > cap)\n", "    if (false)\n")],
     [T_FMT], "tope por fichero"),
    ("S2 sin_tope_total: verifyExport no limita el tamaño total",
     [(FMT, "    if (total > lim.maxTotalBytes)\n", "    if (false)\n")],
     [T_FMT], "tope total"),
    ("S3 manifest_sin_tope_propio: el manifest usa el tope de un fichero normal",
     [(FMT, "const cap = rel === MANIFEST || rel === CHECKSUMS ? lim.maxManifestBytes : lim.maxFileBytes;", "const cap = lim.maxFileBytes;")],
     [T_FMT], "manifest.json tiene su propio tope"),
    ("S4 import_sin_topes: el import no pasa los topes a verifyExport",
     [(IMP, "const { manifest, bots, teams } = verifyExport(src, limits);", "const { manifest, bots, teams } = verifyExport(src);")],
     [T_FMT], "el import también aplica los topes"),
    ("S5 sin_enforce_en_verify: verifyExport no llama a enforceLimits",
     [(FMT, "  enforceLimits(dir, real, limits);\n", "")],
     [T_FMT], "tope por fichero"),
    ("L1 loadouts_descartados_sin_listar: el manifest no lista las revisiones descartadas",
     [(EXP, "      omittedLoadouts.push({ bot: slug, revision: l.revision, ...(l.name ? { name: l.name } : {}) });\n", "      void l;\n")],
     [T_FMT], "revisiones de loadout descartadas"),
    ("L2 equipos_ajenos_sin_listar: los bots en equipos donde no es capitán no se listan",
     [(EXP, "      if (s) lostMembership.set(s, (lostMembership.get(s) ?? 0) + 1);", "      void s;")],
     [T_FMT], "equipos donde NO es capitán"),
    ("N1 lista_blanca_vacia: un nombre parecido a un correo/UUID vuelve a abortar el export",
     [(FMT, 'export const FREE_TEXT_KEYS = new Set(["name"]);', "export const FREE_TEXT_KEYS = new Set([]);")],
     [T_FMT], "NOMBRE de un bot parezca"),
    ("N2 avisos_escaneados: los avisos del manifest (con nombres de equipo) se escanean como el resto",
     [(FMT, 'if (Array.isArray(value)) return key === "warnings" ? [] : value.map((v) => stripFreeText(v, key));', "if (Array.isArray(value)) return value.map((v) => stripFreeText(v, key));")],
     [T_FMT], "NOMBRE de un bot parezca"),
    ("N3 slug_con_forma_de_uuid: slugify deja pasar un tramo con forma de UUID",
     [(FMT, '    .replace(/\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b/g, (m) => m.replace(/-/g, ""))\n', "")],
     [T_FMT], "slugify nunca produce"),
    ("N4 manifest_sin_escanear: el manifest no se escanea en busca de secretos",
     [(EXP, "  hits.push(...scanExportDir(dest, [{ path: MANIFEST }], known));", "  void 0;")],
     [T_FMT], "sólo llega al MANIFEST"),
    ("E1 motor_sin_validar: --engine-version no se contrasta con lo que dice la API",
     [(EXP, "  if (flag && detected && flag !== detected.version) {", "  if (false) {")],
     [T_FMT], "resolveEngineVersion"),
    ("E2 motor_batalla_vieja: se lee el motor de la batalla MÁS ANTIGUA",
     [(EXP, "    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,", "    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,")],
     [T_FMT], "MÁS RECIENTE"),
    ("R3a externos_con_nombre: el equipo vuelve a guardar el NOMBRE de bots de otros usuarios",
     [(EXP, "      else externalCount += 1;", "      else { externalCount += 1; (globalThis.__ext ??= []).push(b.name); }"),
      (EXP, "        externalBotsCount: externalCount,", "        externalBotsCount: externalCount,\n        externalBots: (globalThis.__ext ?? []).map((name) => ({ name })),")],
     [T_FMT], "R3-3 ·"),
    ("R3b accept_sin_exactitud: --accept-engine acepta un valor distinto del de --engine-version",
     [(EXP, "      if (acceptVersion !== flag)\n", "      if (false)\n")],
     [T_FMT], "R3-2 · --accept-engine"),
    ("R3c accept_sin_motivo: --accept-engine no exige motivo",
     [(EXP, 'if (typeof reason !== "string" || reason.trim().length < 10 || reason.length > 300)', "if (false)")],
     [T_FMT], "R3-2 · --accept-engine"),
    ("R3d accept_sin_auditar: el motor forzado no queda anotado en el manifest",
     [(EXP, "    ...(engineOverride ? { engineOverride } : {}),\n", "")],
     [T_FMT], "R3-2 · el manifest"),
    ("Q1 detecta_motor_sin_filtro_finished: la detección lee también batallas no terminadas",
     [(EXP, '"/battles?status=finished&limit=50"', '"/battles?limit=50"')],
     [T_FMT], "Q1 ·"),
    ("Q3 refresh_fallido_reutiliza: tras un refresh fallido se conserva el refresh token",
     [(API, "      this.refreshToken = null;\n      return false;", "      return false;")],
     [T_FMT], "Q3 ·"),
    ("R4a forzado_sin_aviso_cli: el CLI no anuncia el motor forzado",
     [(CLI, "    if (engineOverride)\n      log(\n", "    if (false)\n      log(\n")],
     [T_FMT], "R4-3 · el CLI export con --accept-engine"),
    ("R4b forzado_sin_resumen_cli: la línea de resumen no dice que es forzado ni el motivo",
     [(CLI, '${manifest.engineOverride ? `; forzado, API reporta ${manifest.engineOverride.detected}; motivo: ${manifest.engineOverride.reason}` : ""}', "")],
     [T_FMT], "R4-3 · el CLI export con --accept-engine"),
    ("R4c guarda_sin_consentimiento: el E2E corre sin S9_PORTABLE_E2E_LAB",
     [(GUARD, '[ "${S9_PORTABLE_E2E_LAB:-}" != "1" ]', "false")],
     [T_FMT], "R4-2 · sin consentimiento"),
    ("R4d guarda_sin_ajenos: el E2E ignora los contenedores ajenos en marcha",
     [(GUARD, 'if [ -n "$foreign" ]; then', "if false; then")],
     [T_FMT], "R5-3 · un contenedor ajeno cualquiera"),
    ("R4e guarda_sin_hosts_vetados: se ignora S9_PORTABLE_FORBIDDEN_HOSTS",
     [(GUARD, 'if [ "$(hostname)" = "$h" ]; then', "if false; then")],
     [T_FMT], "R4-2 · S9_PORTABLE_FORBIDDEN_HOSTS"),
    ("G1 guarda_cuenta_propios: los contenedores etiquetados del propio ensayo cuentan como ajenos",
     [(GUARD, 'if [ "$own" != \'"1"\' ]; then foreign=', "if true; then foreign=")],
     [T_FMT], "R5-1 · los contenedores del propio ensayo"),
    ("G2 guarda_veto_invertido: S9_PORTABLE_FORBIDDEN_HOSTS veta a todos menos al nombrado",
     [(GUARD, 'if [ "$(hostname)" = "$h" ]; then', 'if [ "$(hostname)" != "$h" ]; then')],
     [T_FMT], "R4-2 · S9_PORTABLE_FORBIDDEN_HOSTS"),
    ("G3 guarda_consentimiento_no_frena: sin LAB=1 se avisa pero se sigue",
     [(GUARD, 'si esta máquina lo es." >&2\n    return 1', 'si esta máquina lo es." >&2\n    return 0')],
     [T_FMT], "R4-2 · sin consentimiento"),
    ("G4 guarda_ajenos_no_frena: con contenedores ajenos avisa pero sigue",
     [(GUARD, '(¿producción u otro carril?):$foreign" >&2\n    return 1', '(¿producción u otro carril?):$foreign" >&2\n    return 0')],
     [T_FMT], "R5-3 · un contenedor ajeno cualquiera"),
    ("GD1 guarda_docker_falla_abierto: si docker ps falla, la guarda deja pasar",
     [(GUARD, 'if [ "$rc" != 0 ]; then', "if false; then")],
     [T_FMT], "R5-4 · si «docker ps» falla"),
    ("GD2 guarda_sin_docker_abierto: sin docker en el PATH no se detecta (mensaje propio)",
     [(GUARD, "if ! command -v docker >/dev/null 2>&1; then", "if false; then")],
     [T_FMT], "R5-4 · si docker no está"),
    ("GD3 guarda_sin_compose: se ignora la etiqueta com.docker.compose.project",
     [(GUARD, 'if [ -n "$composes" ]; then', "if false; then")],
     [T_FMT], "R5-2 · producción PARADA"),
    ("GD4 guarda_override_mudo: la anulación peligrosa no imprime aviso",
     [(GUARD, 'echo "AVISO PELIGROSO', ': "AVISO PELIGROSO')],
     [T_FMT], "R5-6 · la anulación consciente"),
    ("GD5 guarda_parados_cuentan: un contenedor ajeno PARADO cuenta como en marcha",
     [(GUARD, "exited | created | dead) ;;", "exited_x) ;;")],
     [T_FMT], "R5-3 · un contenedor ajeno PARADO"),
    ("GD6 guarda_nombre_basta: el prefijo s9portable- sin etiqueta se toma por propio",
     [(GUARD, 'if [ "$own" != \'"1"\' ]; then foreign=', 'if [ "$own" != \'"1"\' ] && [ "${name#s9portable-}" = "$name" ]; then foreign=')],
     [T_FMT], "R5-3 · el NOMBRE s9portable-"),
    ("H1 guarda_sin_parados: docker ps sin -a (no ve contenedores compose parados)",
     [(GUARD, "docker ps -a --format", "docker ps --format")],
     [T_FMT], "R5-2 · producción PARADA"),
    ("H3 guarda_etiqueta_cualquier_valor: cualquier valor de la etiqueta s9portable.e2e vale como propio",
     [(GUARD, 'if [ "$own" != \'"1"\' ]; then foreign=', 'if [ "$own" = \'""\' ]; then foreign=')],
     [T_FMT], "R6-3 · la etiqueta s9portable.e2e con valor"),
    ("H6 guarda_allow_definida_vacia: ALLOW definida pero vacía también salta la capa 2",
     [(GUARD, 'if [ "${S9_PORTABLE_E2E_ALLOW_PRODUCT_CONTAINERS:-}" = "1" ]; then', 'if [ -n "${S9_PORTABLE_E2E_ALLOW_PRODUCT_CONTAINERS+x}" ]; then')],
     [T_FMT], "R6-4 · ALLOW_PRODUCT_CONTAINERS definida pero VACÍA"),
    ("P21 guarda_spoof_barra: una etiqueta que EMPIEZA por 1 (p. ej. `1|`) se toma por propia",
     [(GUARD, 'if [ "$own" != \'"1"\' ]; then foreign=', 'if [ "${own#\\"1}" = "$own" ]; then foreign=')],
     [T_FMT], "R6-1 · ESPOOFING: la etiqueta"),
    ("P22 guarda_formato_inesperado_abierto: una línea con campos de más no se rechaza",
     [(GUARD, ' || [ -n "$extra" ]; then', '; then')],
     [T_FMT], "R6-1 · salida de «docker ps» con formato inesperado"),
    ("P23 guarda_sin_json: se vuelve al formato con `|` (parseo ambiguo)",
     [(GUARD, "{{json .Names}}\\t{{json .State}}", "{{json .Names}}|{{json .State}}")],
     [T_FMT], "R5-1 · los contenedores del propio ensayo"),
    ("GD7 run_sin_etiqueta: run.sh no etiqueta sus contenedores",
     [("scripts/portable/e2e/run.sh", " --label s9portable.e2e=1", "")],
     [T_FMT], "R5-7 · run.sh etiqueta"),
    ("R4f guarda_sin_invocar: run.sh deja de invocar la guarda",
     [("scripts/portable/e2e/run.sh", "s9_portable_guard || { echo STOP; exit 1; }", ": # sin guarda")],
     [T_FMT], "R4-2 · run.sh y repeat.sh"),
    ("A1 sin_refresh: el cliente no renueva con el refresh token",
     [(API, "    if (await this.refresh()) return;\n", "")],
     [T_FMT], "cuenta con 2FA"),
    ("A2 totp_consumido_reenviado: tras caducar, con TOTP, se reintenta el login con el código ya usado",
     [(API, "    if (this.auth.email && !this.auth.totp) return this.login(false);", "    if (this.auth.email) return this.login(false);")],
     [T_FMT], "NO reintenta el login con un código consumido"),
    ("A3 refresh_no_rota: el cliente no guarda el refresh token rotado",
     [(API, '    this.refreshToken = typeof res.body.refreshToken === "string" ? res.body.refreshToken : null;\n    return true;', "    return true;")],
     [T_FMT], "cuenta con 2FA"),
]


def sh(cmd):
    return subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True)


def run_tests(tests):
    return sh("timeout 1500 npx vitest run " + " ".join(tests) + " --reporter=verbose 2>&1")


def main():
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    fails = 0
    if "--no-baseline" not in sys.argv and not only:
        base = run_tests([T_FMT, T_RT])
        open(f"{LOG}/portable-mut-BASE.log", "w").write(base.stdout)
        ok = base.returncode == 0
        print(f"BASE rc={base.returncode} {'VERDE' if ok else 'ROJO (la calibración no vale)'}")
        if not ok:
            sys.exit(2)
    for name, edits, tests, frag in M:
        mid = name.split()[0]
        if only and mid not in only:
            continue
        originals = {}
        bad = False
        for path, old, new in edits:
            p = os.path.join(ROOT, path)
            originals.setdefault(path, open(p).read())
            cur = open(p).read()
            if cur.count(old) != 1:
                print(f"{name}: ANCLA NO ÚNICA ({cur.count(old)}) en {path} -> MUTANTE INVÁLIDO")
                bad = True
                break
            open(p, "w").write(cur.replace(old, new))
        try:
            if bad:
                fails += 1
                continue
            r = run_tests(tests)
            out = re.sub(r"\x1b\[[0-9;]*m", "", r.stdout)
            open(f"{LOG}/portable-mut-{mid}.log", "w").write(out)
            failed = sorted(set(re.findall(r"(?:×|✗)\s+(.*?)(?:\s+\d+ms)?$", out, flags=re.M)))
            named = [f for f in failed if frag in f]
            verdict = "ROJO-OK" if (r.returncode != 0 and named) else ("ROJO-OTRO-TEST" if r.returncode != 0 else "VERDE (mutante vivo)")
            if verdict != "ROJO-OK":
                fails += 1
            print(f"{name}: rc={r.returncode} {verdict} mata={named[:3] or failed[:3]}")
        finally:
            for path, src in originals.items():
                open(os.path.join(ROOT, path), "w").write(src)
    d = sh("git status --porcelain --untracked-files=no").stdout.strip()
    print("ARBOL_LIMPIO" if not d else "ARBOL_SUCIO:\n" + d)
    print(f"RESUMEN fallos_calibracion={fails}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
