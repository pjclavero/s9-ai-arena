#!/usr/bin/env python3
"""OLA 2 · G3 · RESPAWN_REARM_POLICY: calibración por mutantes (laboratorio, bajo flock, en serie).

Uso: python3 -I scripts/hardening/g3-rearm-mutants.py <worktree> <salida.json> [G1,G2,...]

Cada mutante aplica UNA sustitución exacta (si el ancla no aparece exactamente una vez se
registra `error`, killed=false, nunca se omite) y declara:
  - `killer`: el test concreto que tiene que matarlo (fichero + nombre completo exacto);
  - `assertion`: la aserción de ese test que debe ponerse roja (texto del código);
  - `reason`: regex que debe aparecer en el mensaje de fallo del killer (rojo por la razón
    correcta, no por un crash o un timeout).
Se ejecutan los tests con el reporter JSON de vitest, se anota el rc REAL de vitest y el
mutante cuenta como MUERTO sólo si rc != 0 Y el killer está `failed` Y su mensaje casa con
`reason`. Se restaura con `git checkout -- <fichero>` y al final se exige árbol limpio.
El control sin mutar tiene que dar rc 0 con el killer de cada mutante `passed`.
"""
import json
import os
import re
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

RULE_PASS = "        for (const v of this.vehicles) if (v.alive && !v.disqualified) v.rearm();"
RULE_PASS_DEAD = "        for (const v of this.vehicles) if (!v.disqualified) v.rearm();"
RULE_IF = 'if (respawnedThisTick > 0 && respawnRearmPolicyOf(this.config.ruleset) === "all_alive_participants") {'
D_DATA = "G3 · la regla es DATOS: explícita, validada y documentada"
D_ALL = "G3 · all_alive_participants"
D_RULES = "G3 · reglas del rearme: asignación, idempotente, tope en el máximo, sólo munición"
D_SELF = "G3 · self (comportamiento anterior) y sin respawn"
D_REPLAY = "G3 · determinismo, stateHash y replay"
EQ = r"to deeply equal"


def k(describe, name):
    return f"{describe} {name}"


# (id, fichero, ancla, sustitución, killer, aserción, regex del mensaje)
MUTANTS = [
    # --- los 13 originales (definidos en 899d3cc; anclas de G9 reescritas por G3.1)
    ("G1_sin_pasada_de_rearme", BATTLE, RULE_IF, "if (false) {",
     k(D_ALL, "los SUPERVIVIENTES (de ambos bandos) recuperan la munición cuando reaparece un vehículo"),
     "for (const v of [v1, v2, v3]) expect(stock(v), v.id).toEqual(maxStock(v));", EQ),
    ("G2_rearme_suma", VEHICLE, "      m.ammo = m.spec.rounds ?? 0;\n      m.charges", "      m.ammo += m.spec.rounds ?? 0;\n      m.charges",
     k(D_RULES, "asignación, no suma: desde munición parcial UNA llamada deja exactamente el máximo"),
     "expect(stock(v1)).toEqual(maxStock(v1));", EQ),
    ("G3_respawn_sin_rearme", VEHICLE, "    this.rearm();\n    for (const s of SECTORS)", "    for (const s of SECTORS)",
     k(D_SELF, "self: el superviviente NO se rearma; el que reaparece sí"),
     "expect(stock(v4)).toEqual(maxStock(v4));", EQ),
    ("G4_pasada_por_reaparicion", BATTLE, "          respawnedThisTick += 1;\n",
     '          respawnedThisTick += 1;\n          if (respawnRearmPolicyOf(this.config.ruleset) === "all_alive_participants")\n'
     "            for (const w of this.vehicles) if (w.alive && !w.disqualified) w.rearm();\n",
     k(D_ALL, "dos reapariciones en el MISMO tick ⇒ un solo rearme, exactamente al máximo, nunca por encima"),
     'expect(calls.get("veh_1")).toBe(1);', r"expected [2-9]\d* to be 1"),
    # G5 · la guarda `respawn.enabled` del PASO 7 es REDUNDANTE con `respawnsLeft()` (0 sin respawn):
    # quitar sólo una es un mutante equivalente (medido en bd22876: G5 de una sola guarda, VIVO).
    # El mutante quita las DOS (ver EXTRA) para probar la garantía «sin respawn, munición finita».
    ("G5_respawn_siempre", BATTLE, "    if (this.config.ruleset.respawn.enabled) {\n      // Poses vistas por spawnFor",
     "    if (true) {\n      // Poses vistas por spawnFor",
     k(D_SELF, "sin respawn la munición sigue siendo FINITA (nadie se rearma aunque haya bajas)"),
     "expect(v4.alive).toBe(false);", r"expected true to be false"),
    ("G6_defecto_self", RULES, 'export const DEFAULT_RESPAWN_REARM_POLICY: RespawnRearmPolicy = "all_alive_participants";',
     'export const DEFAULT_RESPAWN_REARM_POLICY: RespawnRearmPolicy = "self";',
     k(D_DATA, "todo ruleset del catálogo CON respawn declara all_alive_participants; sin respawn, nada"),
     'expect(DEFAULT_RESPAWN_REARM_POLICY).toBe("all_alive_participants");', r"expected 'self' to be 'all_alive_participants'"),
    ("G7_rearma_descalificados", BATTLE, "        for (const v of this.vehicles) if (v.alive && !v.disqualified) v.rearm();",
     "        for (const v of this.vehicles) if (v.alive) v.rearm();",
     k(D_ALL, "un descalificado no se rearma"),
     "expect(rounds(v1)).toEqual(v1.modulesOf(\"ammo\").map(() => 3));", EQ),
    ("G8_politica_ignorada", BATTLE, RULE_IF, "if (respawnedThisTick > 0) {",
     k(D_SELF, "self: el superviviente NO se rearma; el que reaparece sí"),
     "expect(rounds(v1)).toEqual(v1.modulesOf(\"ammo\").map(() => 3));", EQ),
    ("G9_cabecera_sin_politica", REPLAY, "    ruleset: rulesetForHeader(config.ruleset),\n",
     "    ruleset: { ...config.ruleset, respawn: { ...config.ruleset.respawn, rearmPolicy: undefined } },\n",
     k(D_REPLAY, "verify() reproduce el replay con rearme; sin la política en la cabecera, diverge"),
     'expect(replay.header.ruleset.respawn.rearmPolicy).toBe("all_alive_participants");',
     r"expected undefined to be 'all_alive_participants'"),
    ("G10_sin_validacion_motor", MODES, "  errs.push(...respawnRearmPolicyProblems(ruleset));\n", "",
     k(D_DATA, "validación estricta en el motor: valor desconocido o política sin respawn ⇒ la batalla no se crea"),
     "expect(() => idleBattle(bad)).toThrow(/rearmPolicy desconocida/);", r"to throw"),
    ("G11_personalizado_sin_prohibir", BRULES, '  "rearmPolicy",\n', "",
     k(D_DATA, "el personalizado NO deja elegir la política (munición): forbidden_field explícito"),
     'expect(res.errors).toContainEqual(expect.objectContaining({ field: "rules.params.respawn.rearmPolicy", code: "forbidden_field" }));',
     r"to deep equally contain"),
    ("G12_engineRulesetFor_sin_politica", BRULES, "          rearmPolicy: DEFAULT_RESPAWN_REARM_POLICY,\n", "",
     k(D_DATA, "presets y personalizado: engineRulesetFor fija la política en todo modo con respawn"),
     'else expect(r.respawn.rearmPolicy, p.id).toBe("all_alive_participants");',
     r"expected undefined to be 'all_alive_participants'"),
    ("G13_politica_efectiva_sin_respawn", RULES,
     '  if (!r.respawn.enabled) return "self";\n  return r.respawn.rearmPolicy ?? "self";',
     '  return r.respawn.rearmPolicy ?? "all_alive_participants";',
     k(D_DATA, "política efectiva: ausente ⇒ self; sin respawn ⇒ self"),
     'expect(respawnRearmPolicyOf(tdm(undefined))).toBe("self");', r"expected 'all_alive_participants' to be 'self'"),
    # --- nuevos (G3.1 y reglas del rearme)
    ("G14_cabecera_sin_normalizar", REPLAY, "    ruleset: rulesetForHeader(config.ruleset),\n", "    ruleset: config.ruleset,\n",
     k(D_REPLAY, "REPLAY_RULE_HEADER: la cabecera declara la política EFECTIVA aunque la config la deje implícita"),
     'expect(replay.header.ruleset.respawn.rearmPolicy).toBe("self");', r"expected undefined to be 'self'"),
    ("G15_cabecera_admite_default", REPLAY,
     "  if (ruleset.respawn.enabled === true && ruleset.respawn.rearmPolicy === undefined) {",
     "  if (false) {",
     k(D_REPLAY, "verify() reproduce el replay con rearme; sin la política en la cabecera, diverge"),
     "expect(String(bad.rejected)).toMatch(/^rules_incomplete: respawn\\.rearmPolicy ausente/);", r"expected 'null' to match"),
    ("G16_reconstruccion_con_default", REPLAY,
     "  if (rearm) throw new Error(`configFromHeader: ${rearm}`);\n", "",
     k(D_REPLAY, "reconstrucción determinista: configFromHeader y resimulateWithEvents no rellenan la política"),
     "expect(() => configFromHeader(stripped.header)).toThrow(/rules_incomplete/);", r"to throw"),
    ("G17_verify_sin_chequeo_de_regla", REPLAY, "  const rearm = headerRearmPolicyProblem(h.ruleset);\n  if (rearm) return rearm;\n", "",
     k(D_REPLAY, "VERIFY_REPRODUCES_RULE: un valor no admitido en la cabecera se rechaza con motivo"),
     # Ronda 2 (P3-1): el test captura la excepción como `rejected: "threw: …"`, así que el mutante
     # cae en ESTA aserción (prefijo `^rules_invalid` incumplido) y no por un error sin capturar.
     "expect(String(res.rejected)).toMatch(/^rules_invalid: respawn\\.rearmPolicy desconocida/);",
     # vitest trunca el valor recibido (`rules_invali…`): la regex exige el prefijo `threw: configFromHeader:`
     # y el patrón esperado `/^rules_invalid: respawn…/`, no un texto que el informe no muestra entero.
     r"expected 'threw: configFromHeader: rules_inval[^']*' to match /\^rules_invalid: respawn"),
    ("G18_rearme_sin_cargas", VEHICLE, "      m.charges = m.spec.charges ?? 0;\n    }\n  }\n\n  respawn(",
     "    }\n  }\n\n  respawn(",
     k(D_RULES, "las cargas de mina también vuelven a su máximo (asignación)"),
     "expect(mines.map((m) => m.charges)).toEqual(mines.map((m) => m.spec.charges ?? 0));", EQ),
    ("G19_rearme_toca_cooldown", VEHICLE, "      m.ammo = m.spec.rounds ?? 0;\n      m.charges",
     "      m.cooldownUntilTick = 0;\n      m.ammo = m.spec.rounds ?? 0;\n      m.charges",
     k(D_RULES, "sólo munición: no repara módulos ni toca energía ni cooldowns"),
     "expect(mods.map((m) => ({ hp: m.hp, cd: m.cooldownUntilTick }))).toEqual(before);", EQ),
    # --- ronda 2 (P2-2): la cláusula «vivos» de la regla. Mismo mutante, un killer por escenario.
    ("R2_rearma_muertos_mismo_tick", BATTLE, RULE_PASS, RULE_PASS_DEAD,
     k(D_ALL, "un vehículo que MUERE en el PASO 5 del mismo tick en que reaparece otro no se rearma"),
     'expect(rounds(v1)).toEqual(v1.modulesOf("ammo").map(() => 3));', EQ),
    ("R2b_rearma_muertos_en_espera", BATTLE, RULE_PASS, RULE_PASS_DEAD,
     k(D_ALL, "un muerto que espera su reaparición no se rearma cuando reaparece otro"),
     'expect(rounds(v1)).toEqual(v1.modulesOf("ammo").map(() => 3));', EQ),
    ("R2c_rearma_eliminados_limitado", BATTLE, RULE_PASS, RULE_PASS_DEAD,
     k(D_ALL, "respawn limitado: un vehículo ELIMINADO no se rearma cuando reaparece otro"),
     'expect(rounds(v1)).toEqual(v1.modulesOf("ammo").map(() => 3));', EQ),
]


# Sustituciones adicionales de un mutante (mismo criterio de ancla única; se restauran igual).
EXTRA = {
    "G5_respawn_siempre": [
        (MODES, "  if (!ruleset.respawn.enabled) return 0;\n  if (!respawnLimited(ruleset)) return Number.POSITIVE_INFINITY;",
         "  if (!respawnLimited(ruleset)) return Number.POSITIVE_INFINITY;"),
    ],
}


def sh(*cmd, **kw):
    return subprocess.run(list(cmd), cwd=WT, env=ENV, **kw)


def vitest(tag):
    log = f"/tmp/g3-mut-{tag}.log"
    js = f"/tmp/g3-mut-{tag}.json"
    if os.path.exists(js):
        os.remove(js)
    with open(log, "w") as f:
        r = sh("npx", "vitest", "run", *TESTS, "--reporter=default", "--reporter=json", f"--outputFile.json={js}",
               stdout=f, stderr=subprocess.STDOUT)
    tests = {}
    try:
        d = json.load(open(js, encoding="utf8"))
        for fr in d.get("testResults", []):
            for a in fr.get("assertionResults", []):
                tests[a["fullName"]] = {"status": a["status"], "msg": "\n".join(a.get("failureMessages") or [])}
        summ = f"passed={d.get('numPassedTests')} failed={d.get('numFailedTests')} total={d.get('numTotalTests')}"
    except (OSError, ValueError) as e:
        summ = f"SIN_JSON ({e})"
    return r.returncode, summ, tests


def clean_msg(m):
    m = re.sub(r"\x1b\[[0-9;]*m", "", m)
    return m.strip().splitlines()[0][:300] if m.strip() else ""


def main():
    assert sh("git", "status", "--porcelain", "--untracked-files=no", capture_output=True, text=True).stdout == ""
    head = sh("git", "rev-parse", "HEAD", capture_output=True, text=True).stdout.strip()
    out = {"head": head, "tests": TESTS, "control": None, "mutants": []}
    rc, summ, tests = vitest("control")
    missing = [m[0] for m in MUTANTS if tests.get(m[4], {}).get("status") != "passed"]
    out["control"] = {"rc": rc, "summary": summ, "killersNotPassing": missing}
    print(f"CONTROL\tVITEST_RC={rc}\t{summ}\tkillers_no_passed={missing}", flush=True)
    if rc != 0 or missing:
        json.dump(out, open(OUT, "w"), indent=2, ensure_ascii=False)
        sys.exit("control sin mutar en rojo o killer inexistente: los mutantes no significan nada")
    for name, path, old, new, killer, assertion, reason in MUTANTS:
        if ONLY and name.split("_")[0] not in ONLY:
            continue
        subs = [(path, old, new), *EXTRA.get(name, [])]
        srcs = {}
        bad = None
        for sp, so, _ in subs:
            srcs.setdefault(sp, open(os.path.join(WT, sp), encoding="utf8").read())
            if srcs[sp].count(so) != 1:
                bad = f"ancla con {srcs[sp].count(so)} ocurrencias en {sp}"
        if bad:
            out["mutants"].append({"id": name, "file": path, "error": bad, "killed": False})
            print(f"{name}\tERROR {bad}", flush=True)
            continue
        for sp, so, sn in subs:
            srcs[sp] = srcs[sp].replace(so, sn)
        for sp, txt in srcs.items():
            open(os.path.join(WT, sp), "w", encoding="utf8").write(txt)
        try:
            rc, summ, tests = vitest(name)
        finally:
            sh("git", "checkout", "-q", "--", *srcs.keys())
        kt = tests.get(killer, {"status": "missing", "msg": ""})
        msg = clean_msg(kt["msg"])
        right_reason = bool(re.search(reason, re.sub(r"\x1b\[[0-9;]*m", "", kt["msg"])))
        killed = rc != 0 and kt["status"] == "failed" and right_reason
        failed = sorted(t for t, v in tests.items() if v["status"] == "failed")
        out["mutants"].append({
            "id": name, "file": path, "rc": rc, "killed": killed, "summary": summ,
            "killer": killer, "killerStatus": kt["status"], "assertion": assertion,
            "reasonRegex": reason, "rightReason": right_reason, "killerMessage": msg, "allFailed": failed,
        })
        verdict = "MUERTO" if killed else ("ROJO_RAZON_EQUIVOCADA" if rc != 0 else "VIVO")
        print(f"{name}\tVITEST_RC={rc}\t{verdict}\tkiller={kt['status']}\t{msg}\t[{summ}]", flush=True)
    clean = sh("git", "status", "--porcelain", "--untracked-files=no", capture_output=True, text=True).stdout == ""
    out["treeCleanAfter"] = clean
    out["alive"] = [m["id"] for m in out["mutants"] if not m["killed"]]
    json.dump(out, open(OUT, "w"), indent=2, ensure_ascii=False)
    print(f"ARBOL_LIMPIO={clean} NO_MUERTOS={out['alive']}", flush=True)
    sys.exit(0 if not out["alive"] and clean else 1)


if __name__ == "__main__":
    main()
