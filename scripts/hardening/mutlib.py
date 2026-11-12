"""OLA 2 · G1 · Runner común de las matrices de mutantes de MC, MD y MB (scripts/hardening/).

Se ejecuta EN VM112 (nunca en ia02), dentro de `flock -o /srv/s9-test/heavy.lock`, en serie,
sobre un worktree con un commit limpio (detached): `git checkout -- <fichero>` restaura cada
mutante y no hay nada sin commitear que perder.

Reglas (las mismas para los tres equipos):
  · un mutante es UNA sustitución con ancla; el ancla debe aparecer EXACTAMENTE una vez en el
    árbol (`count == 1`). Ausente o ambigua ⇒ `NO_APLICA` (cuenta como fallo de la matriz: un
    ancla duplicada hizo equivalente al M10 de MD tras el merge de MA);
  · control previo sin mutar: rc 0 o la matriz no significa nada;
  · rc REAL de vitest por mutante; MUERTO ⇔ rc ≠ 0 y el log trae un test fallido por aserción
    (no un error de carga: `Error: Failed to load`/`SyntaxError`/`Transform failed` = ROJO_ERRONEO);
  · el árbol queda limpio al terminar (comprobado con `git status --porcelain`).

Salida: JSON con head, control, cada mutante y el recuento.
"""
from __future__ import annotations

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
    extra: dict = field(default_factory=dict)


def _sh(wt: str, args: list[str], **kw) -> subprocess.CompletedProcess:
    env = dict(os.environ, PATH="/srv/s9-test/toolchain/node/bin:" + os.environ.get("PATH", ""))
    return subprocess.run(args, cwd=wt, env=env, **kw)


def _clean(wt: str) -> bool:
    r = _sh(wt, ["git", "status", "--porcelain", "--untracked-files=no"], capture_output=True, text=True)
    return r.stdout.strip() == ""


def _count(src: str, m: Mutant) -> int:
    return len(re.findall(m.old, src, re.S | re.M)) if m.regex else src.count(m.old)


def _apply(src: str, m: Mutant) -> str:
    if m.regex:
        return re.sub(m.old, m.new, src, count=1, flags=re.S | re.M)
    return src.replace(m.old, m.new, 1)


def _vitest(wt: str, tests: list[str], name_filter: str | None, log: str) -> tuple[int, list[str], bool]:
    args = ["npx", "vitest", "run", *tests]
    if name_filter:
        args += ["-t", name_filter]
    with open(log, "w") as f:
        r = _sh(wt, args, stdout=f, stderr=subprocess.STDOUT)
    text = re.sub(r"\x1b\[[0-9;]*m", "", open(log, encoding="utf8", errors="replace").read())
    fails = [l.strip() for l in text.splitlines() if re.match(r"^\s*(×|✗|FAIL)\s", l)][:8]
    load_error = any(e in text for e in LOAD_ERRORS)
    return r.returncode, fails, load_error


def run(team: str, mutants: list[Mutant], argv: list[str]) -> None:
    if os.uname().nodename == "ia-server":
        sys.exit("STOP: los mutantes no se ejecutan en ia02 (DO_NOT_RUN_HEAVY_TESTS_ON_IA02)")
    if len(argv) < 3:
        sys.exit(f"uso: {argv[0]} <worktree> <salida.json> [ID,ID,...|--dry-run]")
    wt, out = argv[1], argv[2]
    dry = len(argv) > 3 and argv[3] == "--dry-run"
    only = set(argv[3].split(",")) if len(argv) > 3 and not dry else None
    ids = [m.id for m in mutants]
    assert len(ids) == len(set(ids)), "ids de mutante duplicados"

    head = _sh(wt, ["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if not _clean(wt):
        sys.exit("árbol sucio: abortar (commitea antes de calibrar)")
    selected = [m for m in mutants if only is None or m.id in only]

    # Comprobación estática de anclas (también es el --dry-run).
    anchors = {}
    for m in selected:
        src = open(os.path.join(wt, m.path), encoding="utf8").read()
        anchors[m.id] = _count(src, m)
    if dry:
        print(json.dumps({"team": team, "head": head, "anchors": anchors}, ensure_ascii=False, indent=1))
        sys.exit(0 if all(n == 1 for n in anchors.values()) else 1)

    tests_all = sorted({t for m in selected for t in m.tests})
    rc, fails, _ = _vitest(wt, tests_all, None, f"/tmp/{team}-mut-CONTROL.log")
    result = {"team": team, "head": head, "control": {"tests": tests_all, "rc": rc, "fails": fails}, "mutants": []}
    print(f"CONTROL rc={rc}", flush=True)
    if rc != 0:
        result["verdict"] = "CONTROL_ROJO"
        json.dump(result, open(out, "w"), ensure_ascii=False, indent=1)
        sys.exit("el control sin mutar no está verde: los mutantes no significan nada")

    for m in selected:
        entry = {"id": m.id, "desc": m.desc, "path": m.path, "tests": m.tests, "filter": m.name_filter}
        if anchors[m.id] != 1:
            entry.update(status="NO_APLICA", anchor_count=anchors[m.id], killed=False)
        else:
            p = os.path.join(wt, m.path)
            src = open(p, encoding="utf8").read()
            open(p, "w", encoding="utf8").write(_apply(src, m))
            diff = _sh(wt, ["git", "diff", "--stat"], capture_output=True, text=True).stdout.strip().splitlines()
            rc, fails, load_error = _vitest(wt, m.tests, m.name_filter, f"/tmp/{team}-mut-{m.id}.log")
            _sh(wt, ["git", "checkout", "-q", "--", m.path])
            assert _clean(wt), f"{m.id}: no revirtió"
            killed = rc != 0 and not load_error and len(fails) > 0
            status = "MUERTO" if killed else ("ROJO_ERRONEO" if rc != 0 else "VIVO")
            entry.update(status=status, rc=rc, killed=killed, fails=fails, diff=diff[-1] if diff else "")
        result["mutants"].append(entry)
        print(f"{m.id}\t{entry['status']}\trc={entry.get('rc')}", flush=True)

    result["killed"] = sum(1 for e in result["mutants"] if e["killed"])
    result["total"] = len(result["mutants"])
    result["tree_clean"] = _clean(wt)
    result["verdict"] = "TODOS_MUERTOS" if result["killed"] == result["total"] and result["tree_clean"] else "FALLA"
    json.dump(result, open(out, "w"), ensure_ascii=False, indent=1)
    print(f"{team}: {result['killed']}/{result['total']} muertos, árbol limpio={result['tree_clean']}", flush=True)
    sys.exit(0 if result["verdict"] == "TODOS_MUERTOS" else 1)
