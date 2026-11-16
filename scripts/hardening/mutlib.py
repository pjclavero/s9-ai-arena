"""OLA 2 · G1 · Runner común de las matrices de mutantes de MC, MD, MB y G1 (scripts/hardening/).

Las tandas se ejecutan en el LABORATORIO (nunca en la máquina de orquestación), en serie y
bajo el cerrojo de tandas pesadas, sobre un worktree con un commit limpio (detached):
`git checkout -- <fichero>` restaura cada mutante y no hay nada sin commitear que perder.
El envoltorio reproducible es `scripts/hardening/run-mutants.sh`.

Reglas (las mismas para todas las matrices):
  · un mutante es UNA sustitución con ancla; el ancla debe aparecer EXACTAMENTE una vez en el
    fichero (`count == 1`). Ausente o ambigua ⇒ `NO_APLICA` (cuenta como fallo de la matriz: un
    ancla duplicada hizo equivalente al M10 de MD tras el merge de MA);
  · las anclas están versionadas con el código: `--dry-run` las comprueba sin ejecutar nada
    (lo hace también el test apps/arena-engine/tests/hardening-mutant-anchors.test.ts en CI);
  · control previo sin mutar: rc 0 o la matriz no significa nada;
  · rc REAL de vitest por mutante; MUERTO ⇔ rc ≠ 0 y el log trae un test fallido por aserción
    (no un error de carga: `Error: Failed to load`/`SyntaxError`/`Transform failed` = ROJO_ERRONEO);
  · el árbol queda limpio al terminar (comprobado con `git status --porcelain`).

Salida DETERMINISTA: JSON con claves ordenadas, sin horas ni duraciones (se quitan los
«123ms» de las líneas de fallo), con el SHA del árbol, el sha256 del fichero de la matriz
y, por mutante, el sha256 del fichero mutado (dos ejecuciones del mismo SHA dan el mismo JSON
salvo que cambie el resultado de vitest).

Entorno: `S9_NODE_BIN` (opcional) se antepone al PATH; `S9_NO_HEAVY_HOSTS` (por defecto
`ia-server`) lista, separados por comas, los hosts donde se niega a ejecutar mutantes;
`S9_MUT_LOGDIR` (por defecto /tmp) recibe los logs de vitest.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field

LOAD_ERRORS = ("Failed to load", "SyntaxError", "Transform failed", "TransformError", "Cannot find module")


@dataclass
class Mutant:
    id: str
    desc: str
    path: str
    old: str
    new: str
    tests: list[str]
    # Filtro -t de vitest (opcional): el test concreto que lo debe matar.
    name_filter: str | None = None
    # Ancla como expresión regular (re.S | re.M) en vez de texto literal.
    regex: bool = False
    # Fallo esperado (texto para la matriz MUTANT / TEST / EXPECTED FAILURE / ACTUAL).
    expect: str = ""
    extra: dict = field(default_factory=dict)
    # Sustituciones literales ADICIONALES en el mismo fichero: (ancla, sustituto, recuento
    # exacto). Se reemplazan todas las apariciones; si algún recuento no cuadra, el ancla del
    # mutante cuenta como no aplicable (-1). Para mutantes que tocan varias líneas a la vez.
    also: list = field(default_factory=list)
    # G1 ronda 4 · sustituciones literales en OTROS ficheros: (ruta, ancla, sustituto, recuento
    # exacto). Para quitar un consumidor que vive repartido (p. ej. vehicle.ts y battle.ts). Si
    # algún recuento no cuadra, el mutante cuenta como no aplicable (-1); se restauran todos.
    others: list = field(default_factory=list)


def _env() -> dict:
    env = dict(os.environ)
    nb = os.environ.get("S9_NODE_BIN")
    if nb:
        env["PATH"] = nb + os.pathsep + env.get("PATH", "")
    return env


def _sh(wt: str, args: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=wt, env=_env(), **kw)


def _clean(wt: str) -> bool:
    r = _sh(wt, ["git", "status", "--porcelain", "--untracked-files=no"], capture_output=True, text=True)
    return r.stdout.strip() == ""


def _count(src: str, m: Mutant) -> int:
    if any(src.count(old) != n for old, _, n in m.also):
        return -1
    return len(re.findall(m.old, src, re.S | re.M)) if m.regex else src.count(m.old)


def _apply(src: str, m: Mutant) -> str:
    if m.regex:
        src = re.sub(m.old, m.new, src, count=1, flags=re.S | re.M)
    else:
        src = src.replace(m.old, m.new, 1)
    for old, new, _ in m.also:
        src = src.replace(old, new)
    return src


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_DUR = re.compile(r"\s+\d+(?:\.\d+)?\s*m?s$")


def _vitest(wt: str, tests: list[str], name_filter: str | None, log: str) -> tuple[int, list[str], bool]:
    args = ["npx", "vitest", "run", *tests]
    if name_filter:
        args += ["-t", name_filter]
    with open(log, "w") as f:
        r = _sh(wt, args, stdout=f, stderr=subprocess.STDOUT)
    text = _ANSI.sub("", open(log, encoding="utf8", errors="replace").read())
    fails = sorted({_DUR.sub("", l.strip()) for l in text.splitlines() if re.match(r"^\s*(×|✗|FAIL)\s", l)})[:12]
    load_error = any(e in text for e in LOAD_ERRORS)
    return r.returncode, fails, load_error


def _dump(obj: dict, out: str) -> None:
    with open(out, "w", encoding="utf8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")


def run(team: str, mutants: list[Mutant], argv: list[str]) -> None:
    if len(argv) < 3:
        sys.exit(f"uso: {argv[0]} <worktree> <salida.json> [ID,ID,...|--dry-run]")
    wt, out = argv[1], argv[2]
    dry = len(argv) > 3 and argv[3] == "--dry-run"
    only = set(argv[3].split(",")) if len(argv) > 3 and not dry else None
    ids = [m.id for m in mutants]
    assert len(ids) == len(set(ids)), "ids de mutante duplicados"
    matrix_file = os.path.abspath(sys.modules["__main__"].__file__)
    matrix_sha = _sha(open(matrix_file, "rb").read())
    selected = [m for m in mutants if only is None or m.id in only]
    if only is not None and len(selected) != len(only):
        sys.exit(f"ids desconocidos: {sorted(only - set(ids))}")

    # Comprobación estática de anclas (también es el --dry-run: válido en cualquier host).
    anchors = {}
    for m in selected:
        src = open(os.path.join(wt, m.path), encoding="utf8").read()
        anchors[m.id] = _count(src, m)
        for path, old, _, n in m.others:
            if open(os.path.join(wt, path), encoding="utf8").read().count(old) != n:
                anchors[m.id] = -1
    if dry:
        bad = {k: v for k, v in anchors.items() if v != 1}
        print(json.dumps({"team": team, "matrix_sha256": matrix_sha, "anchors": anchors, "bad": bad},
                         ensure_ascii=False, indent=1, sort_keys=True))
        sys.exit(0 if not bad else 1)

    blocked = [h.strip() for h in os.environ.get("S9_NO_HEAVY_HOSTS", "ia-server").split(",") if h.strip()]
    if os.uname().nodename in blocked:
        sys.exit("STOP: los mutantes no se ejecutan en este host (DO_NOT_RUN_HEAVY_TESTS)")
    if not _clean(wt):
        sys.exit("árbol sucio: abortar (commitea antes de calibrar)")
    head = _sh(wt, ["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    logdir = os.environ.get("S9_MUT_LOGDIR", "/tmp")

    tests_all = sorted({t for m in selected for t in m.tests})
    rc, fails, _ = _vitest(wt, tests_all, None, os.path.join(logdir, f"{team}-mut-CONTROL.log"))
    result = {"team": team, "head": head, "matrix_sha256": matrix_sha,
              "control": {"tests": tests_all, "rc": rc, "fails": fails}, "mutants": []}
    print(f"CONTROL rc={rc}", flush=True)
    if rc != 0:
        result["verdict"] = "CONTROL_ROJO"
        _dump(result, out)
        sys.exit("el control sin mutar no está verde: los mutantes no significan nada")

    for m in selected:
        entry = {"id": m.id, "desc": m.desc, "path": m.path, "tests": m.tests, "filter": m.name_filter,
                 "expect": m.expect}
        if anchors[m.id] != 1:
            entry.update(status="NO_APLICA", anchor_count=anchors[m.id], killed=False)
        else:
            p = os.path.join(wt, m.path)
            src = open(p, encoding="utf8").read()
            mutated = _apply(src, m)
            open(p, "w", encoding="utf8").write(mutated)
            for path, old, new, _ in m.others:
                q = os.path.join(wt, path)
                other = open(q, encoding="utf8").read().replace(old, new)
                open(q, "w", encoding="utf8").write(other)
                mutated += other  # el sha256 del mutante cubre todos los ficheros tocados
            rc, fails, load_error = _vitest(wt, m.tests, m.name_filter, os.path.join(logdir, f"{team}-mut-{m.id}.log"))
            _sh(wt, ["git", "checkout", "-q", "--", m.path, *sorted({o[0] for o in m.others})])
            assert _clean(wt), f"{m.id}: no revirtió"
            killed = rc != 0 and not load_error and len(fails) > 0
            status = "MUERTO" if killed else ("ROJO_ERRONEO" if rc != 0 else "VIVO")
            entry.update(status=status, rc=rc, killed=killed, fails=fails,
                         mutated_sha256=_sha(mutated.encode("utf8")))
        result["mutants"].append(entry)
        print(f"{m.id}\t{entry['status']}\trc={entry.get('rc')}", flush=True)

    result["killed"] = sum(1 for e in result["mutants"] if e["killed"])
    result["total"] = len(result["mutants"])
    result["tree_clean"] = _clean(wt)
    result["verdict"] = "TODOS_MUERTOS" if result["killed"] == result["total"] and result["tree_clean"] else "FALLA"
    _dump(result, out)
    print(f"{team}: {result['killed']}/{result['total']} muertos, árbol limpio={result['tree_clean']}", flush=True)
    sys.exit(0 if result["verdict"] == "TODOS_MUERTOS" else 1)
