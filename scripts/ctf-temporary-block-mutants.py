#!/usr/bin/env python3
"""V1 · Calibración del bloqueo temporal de CTF.

Cada mutante rompe UNA garantía y debe poner en ROJO el test indicado (fragmento de su
nombre en la salida de vitest). Antes de los mutantes se ejecuta la línea base (sin mutar):
los dos ficheros de prueba tienen que estar en VERDE.

En serie y sobre un árbol COMMITEADO (cada mutante se revierte con `git checkout`; el
script comprueba al final que el árbol queda limpio). Ligero: `nice -n 19`, un worker,
y sólo con PRODGUARD_OK antes de CADA ejecución.

Uso: python3 scripts/ctf-temporary-block-mutants.py [M1 M2 ...]
"""
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRODGUARD = os.environ.get("PRODGUARD", "prodguard.sh")  # ruta del script de guarda de carga
API_T = "apps/api/src/ctf-temporary-block.test.ts"
WEB_T = "apps/web/tests/ctf-temporary-block.test.tsx"
PRACTICE = "apps/api/src/ctf-practice.ts"
BATTLES = "apps/api/src/routes/battles.ts"
NEWPAGE = "apps/web/src/pages/BattleNewPage.tsx"
RULES_CHECK = "apps/api/src/routes/battle-rules.ts"
PICKER = "apps/web/src/pages/BattleRulesPicker.tsx"

# (id, fichero, ancla, sustituto, test, fragmento del test que debe fallar)
MUTANTS = [
    ("M1", BATTLES, "if (mode === CTF_MODE && !ctfPracticeEnabledFromEnv()) {", "if (false) {", API_T,
     "preset ctf ⇒ 400 mode_disabled"),
    ("M2", PRACTICE, "return ctfPracticeEnabledFromEnv(env) ? [] : [", "return true ? [] : [", API_T,
     "declara CTF bloqueado con motivo"),
    ("M3", PRACTICE, 'return raw === "1" || raw === "true";', 'return raw !== "0";', API_T,
     "valores que no son 1/true siguen bloqueando"),
    ("M4", BATTLES,
     'defineOperation(router, "getBattle", async (req, res) => {\n',
     'defineOperation(router, "getBattle", async (req, res) => {\n    if (!ctfPracticeEnabledFromEnv()) { const b0 = await db("battles").where({ id: pathParam(req, "battleId") }).first(); if (b0?.mode === CTF_MODE) throw notFound(); }\n',
     API_T, "una CTF fallida sigue visible"),
    ("M8", RULES_CHECK, "if (mode === CTF_MODE && !ctfPracticeEnabledFromEnv()) {", "if (false) {", API_T,
     "responde 400 mode_disabled como la creación"),
    ("M5", NEWPAGE, "const offered = (r.modes ?? []).filter((x) => !off.has(x));", "const offered = r.modes ?? [];", WEB_T,
     "el selector de modo no ofrece capture_the_flag"),
    ("M6", PICKER, "p.format === format && !blocked(p.game)", "p.format === format", WEB_T,
     "ni el preset CTF ni el juego CTF"),
    ("M7", PICKER, "disabled={!!ctfBlock} ", "", WEB_T, "ni el preset CTF ni el juego CTF"),
]


def sh(*a, **k):
    return subprocess.run(a, cwd=ROOT, text=True, capture_output=True, **k)


def guard():
    while True:
        out = subprocess.run(["bash", PRODGUARD], capture_output=True, text=True).stdout
        if "PRODGUARD_OK" in out:
            return
        print("  PRODGUARD no OK, espero 60 s", flush=True)
        time.sleep(60)


def run(test):
    guard()
    r = subprocess.run(
        ["nice", "-n", "19", "npx", "vitest", "run", test, "--maxWorkers=1"],
        cwd=ROOT, text=True, capture_output=True,
    )
    return r.returncode, r.stdout + r.stderr


def main():
    only = set(sys.argv[1:])
    if sh("git", "status", "--porcelain", "--untracked-files=no").stdout.strip():
        sys.exit("el árbol debe estar commiteado y limpio")
    bad = 0
    for t in (API_T, WEB_T):
        rc, _ = run(t)
        print(f"BASE {t}: rc={rc}", flush=True)
        bad += rc != 0
    if bad:
        sys.exit("línea base en rojo")
    muertos = 0
    sel = [m for m in MUTANTS if not only or m[0] in only]
    for mid, f, a, b, test, frag in sel:
        path = os.path.join(ROOT, f)
        src = open(path, encoding="utf-8").read()
        if src.count(a) != 1:
            print(f"{mid}: ANCLA no única/ausente en {f}")
            bad += 1
            continue
        open(path, "w", encoding="utf-8").write(src.replace(a, b))
        try:
            rc, out = run(test)
        finally:
            sh("git", "checkout", "--", f)
        # El test nombrado debe aparecer como FALLIDO (línea «FAIL … > <nombre>»).
        muerto = rc != 0 and any(("FAIL" in l or "×" in l) and frag in l for l in out.splitlines())
        print(f"{mid}: rc={rc} {'MUERTO por «' + frag + '»' if muerto else 'SUPERVIVIENTE/otra causa'}", flush=True)
        muertos += muerto
        bad += not muerto
    if sh("git", "status", "--porcelain", "--untracked-files=no").stdout.strip():
        print("ÁRBOL SUCIO tras los mutantes")
        bad += 1
    print(f"mutantes muertos {muertos}/{len(sel)}; rc={1 if bad else 0}")
    sys.exit(1 if bad else 0)


main()
