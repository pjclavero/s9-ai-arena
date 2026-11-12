#!/usr/bin/env python3
"""OLA 2 · G3 · RESPAWN_REARM_POLICY: calibración por mutantes (EN VM112, bajo flock, en serie).

Uso: python3 -I scripts/hardening/g3-rearm-mutants.py <worktree> <salida.json> [G1,G2,...]

Cada mutante aplica UNA sustitución exacta (si el ancla no aparece exactamente una vez se
registra `error`, killed=false, nunca se omite), ejecuta los tests que deben matarlo, anota
el rc REAL de vitest y restaura con `git checkout -- <fichero>`. El árbol debe estar limpio
(commit detached) antes de empezar; el control sin mutar tiene que dar rc 0.
"""
import json
import os
import subprocess
import sys

WT, OUT = sys.argv[1], sys.argv[2]
ONLY = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else None
ENV = dict(os.environ, PATH="/srv/s9-test/toolchain/node/bin:" + os.environ.get("PATH", ""))

BATTLE = "apps/arena-engine/src/sim/battle.ts"
VEHICLE = "apps/arena-engine/src/sim/vehicle.ts"
MODES = "apps/arena-engine/src/sim/modes.ts"
REPLAY = "apps/arena-engine/src/replay.ts"
RULES = "packages/game-rules/index.ts"
BRULES = "packages/game-rules/battle-rules.ts"
T_REARM = "apps/arena-engine/tests/respawn-rearm.test.ts"
T_TIE = "apps/arena-engine/tests/rules-respawn-tiebreak.test.ts"
TESTS = [T_REARM, T_TIE]

RULE_IF = 'if (respawnedThisTick > 0 && respawnRearmPolicyOf(this.config.ruleset) === "all_alive_participants") {'

MUTANTS = [
    # Garantía: los supervivientes recuperan munición / el 2v2 no se estanca.
    ("G1_sin_pasada_de_rearme", BATTLE, RULE_IF, "if (false) {"),
    # Garantía: nunca por encima del máximo (asignación, no suma).
    ("G2_rearme_suma", VEHICLE, "      m.ammo = m.spec.rounds ?? 0;\n      m.charges", "      m.ammo += m.spec.rounds ?? 0;\n      m.charges"),
    # Garantía: el que reaparece también se rearma (con self, sólo por respawn()).
    ("G3_respawn_sin_rearme", VEHICLE, "    this.rearm();\n    for (const s of SECTORS)", "    for (const s of SECTORS)"),
    # Garantía: una sola pasada por tick aunque reaparezcan varios.
    ("G4_pasada_por_reaparicion", BATTLE, "          respawnedThisTick += 1;\n",
     '          respawnedThisTick += 1;\n          if (respawnRearmPolicyOf(this.config.ruleset) === "all_alive_participants")\n'
     "            for (const w of this.vehicles) if (w.alive && !w.disqualified) w.rearm();\n"),
    # Garantía: sin respawn la munición es finita (nadie reaparece ni se rearma).
    ("G5_respawn_siempre", BATTLE, "    if (this.config.ruleset.respawn.enabled) {\n      // Poses vistas por spawnFor",
     "    if (true) {\n      // Poses vistas por spawnFor"),
    # Garantía: la regla es el valor por defecto de los modos con respawn.
    ("G6_defecto_self", RULES, 'export const DEFAULT_RESPAWN_REARM_POLICY: RespawnRearmPolicy = "all_alive_participants";',
     'export const DEFAULT_RESPAWN_REARM_POLICY: RespawnRearmPolicy = "self";'),
    # Garantía: sólo vivos NO descalificados.
    ("G7_rearma_descalificados", BATTLE, "        for (const v of this.vehicles) if (v.alive && !v.disqualified) v.rearm();",
     "        for (const v of this.vehicles) if (v.alive) v.rearm();"),
    # Garantía: con self, el comportamiento anterior (hash de antes de G3).
    ("G8_politica_ignorada", BATTLE, RULE_IF, "if (respawnedThisTick > 0) {"),
    # Garantía: el replay lleva lo necesario para que verify() reproduzca el rearme.
    ("G9_cabecera_sin_politica", REPLAY, "    ruleset: config.ruleset,\n    map: config.map,",
     "    ruleset: { ...config.ruleset, respawn: { ...config.ruleset.respawn, rearmPolicy: undefined } },\n    map: config.map,"),
    # Garantía: validación estricta en el motor.
    ("G10_sin_validacion_motor", MODES, "  errs.push(...respawnRearmPolicyProblems(ruleset));\n", ""),
    # Garantía: el personalizado no deja elegir la política (forbidden_field explícito).
    ("G11_personalizado_sin_prohibir", BRULES, '  "rearmPolicy",\n', ""),
    # Garantía: presets y personalizado con respawn llevan la política.
    ("G12_engineRulesetFor_sin_politica", BRULES, "          rearmPolicy: DEFAULT_RESPAWN_REARM_POLICY,\n", ""),
    # Garantía: el rearme ocurre en el PASO 7, no en la muerte (respawn ≠ baja).
    ("G13_politica_efectiva_sin_respawn", RULES,
     '  if (!r.respawn.enabled) return "self";\n  return r.respawn.rearmPolicy ?? "self";',
     '  return r.respawn.rearmPolicy ?? "all_alive_participants";'),
]


def sh(*cmd, **kw):
    return subprocess.run(list(cmd), cwd=WT, env=ENV, **kw)


def vitest(tag):
    log = f"/tmp/g3-mut-{tag}.log"
    with open(log, "w") as f:
        r = sh("npx", "vitest", "run", *TESTS, stdout=f, stderr=subprocess.STDOUT)
    summary = [l.strip() for l in open(log, encoding="utf8", errors="replace") if "Tests " in l]
    return r.returncode, (summary[-1] if summary else "")


def main():
    assert sh("git", "status", "--porcelain", "--untracked-files=no", capture_output=True, text=True).stdout == ""
    head = sh("git", "rev-parse", "HEAD", capture_output=True, text=True).stdout.strip()
    out = {"head": head, "tests": TESTS, "control": None, "mutants": []}
    rc, summ = vitest("control")
    out["control"] = {"rc": rc, "summary": summ}
    print(f"CONTROL\tVITEST_RC={rc}\t{summ}", flush=True)
    if rc != 0:
        json.dump(out, open(OUT, "w"), indent=2)
        sys.exit("control sin mutar en rojo: los mutantes no significan nada")
    for name, path, old, new in MUTANTS:
        if ONLY and name.split("_")[0] not in ONLY:
            continue
        p = os.path.join(WT, path)
        src = open(p, encoding="utf8").read()
        n = src.count(old)
        if n != 1:
            out["mutants"].append({"id": name, "file": path, "error": f"ancla con {n} ocurrencias", "killed": False})
            print(f"{name}\tERROR ancla={n}", flush=True)
            continue
        open(p, "w", encoding="utf8").write(src.replace(old, new))
        try:
            rc, summ = vitest(name)
        finally:
            sh("git", "checkout", "-q", "--", path)
        killed = rc != 0
        out["mutants"].append({"id": name, "file": path, "rc": rc, "killed": killed, "summary": summ})
        print(f"{name}\tVITEST_RC={rc}\t{'MUERTO' if killed else 'VIVO'}\t{summ}", flush=True)
    clean = sh("git", "status", "--porcelain", "--untracked-files=no", capture_output=True, text=True).stdout == ""
    out["treeCleanAfter"] = clean
    out["alive"] = [m["id"] for m in out["mutants"] if not m["killed"]]
    json.dump(out, open(OUT, "w"), indent=2)
    print(f"ARBOL_LIMPIO={clean} VIVOS={out['alive']}", flush=True)
    sys.exit(0 if not out["alive"] and clean else 1)


if __name__ == "__main__":
    main()
