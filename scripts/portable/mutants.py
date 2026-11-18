#!/usr/bin/env python3
"""PORTABLE · Calibración del export/import de bots y equipos: cada mutante rompe UNA garantía y
debe poner en ROJO el test indicado (por su nombre), con la línea base en verde y el árbol limpio
después.

Uso:  python3 scripts/portable/mutants.py [M1 M2 ...]
Serie, nunca en paralelo sobre el mismo árbol. COMMITEA ANTES: el script restaura cada fichero tras
su mutante, pero no protege cambios sin commitear. Exige PostgreSQL de test (como `npm run test:db`).
Ejecutar SÓLO en el laboratorio (VM111), no en ia02.
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FMT = "scripts/portable/lib/format.mjs"
IMP = "scripts/portable/lib/import.mjs"
EXP = "scripts/portable/lib/export.mjs"
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
      (IMP, "  const { manifest, bots, teams } = verifyExport(src);\n  assertEngineCompatible(manifest.engineVersion, targetEngine);",
       '  const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));\n'
       '  const bots = readdirSync(join(src, "bots")).map((s) => JSON.parse(readFileSync(join(src, "bots", s, "bot.json"), "utf8")));\n'
       "  const teams = [];\n  const __late = () => verifyExport(src);\n"
       "  assertEngineCompatible(manifest.engineVersion, targetEngine);"),
      (IMP, "  // (3) equipos\n", "  __late();\n  // (3) equipos\n")],
     [T_FMT, T_RT], "M2 ·"),
    ("M3 secret_leak: el export mete el id y el correo del dueño y no escanea",
     [(EXP, "        visibility: bot.visibility,\n        retired: !!bot.retiredAt,",
       "        visibility: bot.visibility,\n        ownerId: bot.ownerId,\n        email: me.email,\n        retired: !!bot.retiredAt,"),
      (EXP, "if (hits.length) throw new PortableError", "if (false) throw new PortableError")],
     [T_RT], "M3 ·"),
    ("M3b secret_scanner_blind: el escáner deja de detectar correos",
     [(FMT, '    if (EMAIL_RE.test(text)) hits.push(`${label}: contiene un correo electrónico`);\n', "")],
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
