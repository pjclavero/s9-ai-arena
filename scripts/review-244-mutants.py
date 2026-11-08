#!/usr/bin/env python3
"""Calibración de los tests del revisor #244: cada mutante debe poner en ROJO el test
indicado, y por la razón esperada (patrón en la salida). Serie, nunca en paralelo."""
import subprocess, sys, re, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIS = "apps/api/src/review-244-vis.test.ts"
MIG = "apps/api/src/db/review-244-migration.test.ts"

M = [
    ("M1 staff cambia code_public", "apps/api/src/routes/bots.ts",
     'const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));\n    assertOwner(req.auth, bot);\n    const v = await getVersionOr404(db, bot.id as string, pathParam(req, "version"));\n    const codePublic',
     'const bot = await getVisibleBot(db, req.auth, pathParam(req, "botId"));\n    assertOwner(req.auth, bot, true);\n    const v = await getVersionOr404(db, bot.id as string, pathParam(req, "version"));\n    const codePublic',
     VIS, "RV-C1", r"expected 200 to be 403"),
    ("M2 createTournament con rol user", "apps/api/openapi.yaml",
     "operationId: createTournament\n      x-min-role: organizer", "operationId: createTournament\n      x-min-role: user",
     VIS, "RV-T1", r"expected 201 to be 403"),
    ("M3 broadcast por coerción", "apps/api/src/routes/tournaments.ts",
     'if (broadcast !== undefined && typeof broadcast !== "boolean") throw badRequest("broadcast debe ser true o false");',
     "", VIS, "RV-T1", r"expected 201 to be 400"),
    ("M4 close-entries acepta broadcast", "apps/api/src/routes/tournaments.ts",
     '.update({ state: "closed", seeds_revealed',
     '.update({ broadcast: req.body?.broadcast === true || t.broadcast, state: "closed", seeds_revealed',
     VIS, "RV-T4", r"expected true to be false"),
    ("M5 battleToJson con dueño", "apps/api/src/routes/battles.ts",
     "        botName: p.bot_name ?? undefined,\n        version: p.version,",
     "        botName: p.bot_name ?? undefined,\n        ownerId: p.bot_owner_id,\n        version: p.version,",
     VIS, "RV-P", r"ownerId"),
    ("M6 código legible sin code_public", "apps/api/src/routes/bots.ts",
     '  return v.state === "published" && v.code_public === true;\n}\n\nfunction decodeVersionFiles',
     '  return v.state === "published";\n}\n\nfunction decodeVersionFiles',
     VIS, "RV-C3", r"expected (200|304) to be 403"),
    ("M7 403 en vez de 404 (oráculo)", "apps/api/src/services/bots.ts",
     "if (!bot || !(await canSeeBot(db, auth, bot))) throw notFound();",
     "if (!bot) throw notFound();\n  if (!(await canSeeBot(db, auth, bot))) throw forbidden();",
     VIS, "RV-O1", r"(403|404)"),
    ("M8 filtros de replay sin identificabilidad", "apps/api/src/services/replay-list.ts",
     "  whereBotIdentifiable(db, sub, auth);\n  return fn(sub);", "  return fn(sub);",
     VIS, "RV-O2", r"to not include|expected 1 to be 0"),
    ("M9 motivo único", "apps/api/src/replay-access.ts",
     '      ? "tournament_not_broadcastable"\n      : "battle_not_public";',
     '      ? "battle_not_public"\n      : "battle_not_public";',
     VIS, "RV-S2", r"tournament_not_broadcastable"),
    ("M10 toda batalla mostrable", "apps/api/src/replay-access.ts",
     '          .whereNot("bots.visibility", "public"),\n      )\n      .orWhereExists',
     '          .whereRaw("false"),\n      )\n      .orWhereExists',
     VIS, "RV-S", r"expected (201|200|2\d\d) to be (404|409)|battle_not_public"),
    ("M11 019 debilita otra cláusula del guardián", "apps/api/src/db/migrations.ts",
     "        IF OLD.state <> 'validating' AND (\n             NEW.artifact_hash IS DISTINCT FROM OLD.artifact_hash\n             OR NEW.validated_build_id IS DISTINCT FROM OLD.validated_build_id) THEN\n          RAISE EXCEPTION 'bot_version_immutable: el artefacto de la versión % del bot % sólo se fija al validar',\n            OLD.version, OLD.bot_id USING ERRCODE = 'integrity_constraint_violation';\n        END IF;`;",
     "        `;",
     MIG, "RV-M1", r"AssertionError"),
    ("M12 down(019) sin D9", "apps/api/src/db/migrations.ts",
     "await db.raw(BOT_VERSION_GUARD_HEAD + BOT_VERSION_GUARD_D9_IRREVERSIBLE + BOT_VERSION_GUARD_TAIL);",
     "await db.raw(BOT_VERSION_GUARD_HEAD + BOT_VERSION_GUARD_TAIL);",
     MIG, "RV-M1", r"AssertionError"),
]

def sh(cmd):
    return subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True)

only = sys.argv[1:]
fails = 0
for name, path, old, new, test, filt, why in M:
    if only and name.split()[0] not in only:
        continue
    p = os.path.join(ROOT, path)
    src = open(p).read()
    if src.count(old) != 1:
        print(f"{name}: ANCLA NO ÚNICA ({src.count(old)}) -> MUTANTE INVÁLIDO"); fails += 1; continue
    open(p, "w").write(src.replace(old, new))
    try:
        r = sh(f"timeout 900 npx vitest run {test} 2>&1")
        out = r.stdout + r.stderr
        open(f"/tmp/r244-mut-{name.split()[0]}.log","w").write(out)
        red = r.returncode != 0 and re.search(r"\d+ failed", out) is not None
        failed = re.findall(r"×\s+(RV-[A-Z]+\d*)", out)
        # El rojo debe ser DEL test esperado y por la razón esperada (fichero entero, sin -t:
        # con -t los tests que dependen de la preparación de otros fallan por otra razón).
        reason = re.search(why, out) is not None and any(f.startswith(filt) for f in failed)
        verdict = "ROJO-OK" if (red and reason) else ("ROJO-RAZON?" if red else "VERDE (mutante vivo)")
        if verdict != "ROJO-OK": fails += 1
        print(f"{name}: rc={r.returncode} {verdict} fallan={sorted(set(failed))}")
    finally:
        open(p, "w").write(src)
d = sh("git status --porcelain --untracked-files=no").stdout.strip()
print("ARBOL_LIMPIO" if not d else "ARBOL_SUCIO:\n" + d)
print(f"RESUMEN fallos_calibracion={fails}")
sys.exit(1 if fails else 0)
