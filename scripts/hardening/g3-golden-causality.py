#!/usr/bin/env python3
"""OLA 2 · G3 · GOLDEN_CAUSALITY: el re-anclaje de a135a8f/7d49b704 lo causa SÓLO el rearme.

Uso: python3 -I scripts/hardening/g3-golden-causality.py <worktree> <salida.json>   (laboratorio, bajo flock)

Diferencial 2x2 sobre el SHA del worktree (árbol limpio, commit detached):
  A  regla ACTIVA      + anclas ACTUALES   ⇒ rc 0
  B  regla DESACTIVADA + anclas ACTUALES   ⇒ rojo, exactamente los 7 goldens re-anclados
  C  regla DESACTIVADA + anclas ANTERIORES ⇒ rc 0 (vuelven EXACTAMENTE los valores previos)
  D  regla ACTIVA      + anclas ANTERIORES ⇒ rojo, los 7 goldens + el control de rules-review-break
«Desactivar la regla» = sustituir SÓLO la condición de la pasada de rearme de battle.ts por
`if (false) {` (el respawn() individual sigue rearmando al que reaparece, como antes de G3).
«Anclas anteriores» = los valores de antes de G3, sustituidos literalmente (lista OLD_ANCHORS).
Cada fase restaura con `git checkout --` y al final se exige árbol limpio.
"""
import json
import os
import subprocess
import sys

WT, OUT = sys.argv[1], sys.argv[2]
ENV = dict(os.environ, PATH="/srv/s9-test/toolchain/node/bin:" + os.environ.get("PATH", ""))

BATTLE = "apps/arena-engine/src/sim/battle.ts"
TIE = "apps/arena-engine/tests/rules-respawn-tiebreak.test.ts"
SPAWN = "apps/arena-engine/tests/spawn-4v4.test.ts"
FIX = "apps/arena-engine/tests/fix-4v4-spawn-hash-identity.test.ts"
BREAK = "apps/arena-engine/tests/rules-review-break.test.ts"
FILES = [TIE, SPAWN, FIX, BREAK]
RULE_IF = 'if (respawnedThisTick > 0 && respawnRearmPolicyOf(this.config.ruleset) === "all_alive_participants") {'

# (fichero, valor actual, valor anterior a G3)
OLD_ANCHORS = [
    (TIE, 'tdm_1v1: { hash: "626dbae962a619f79d8a0887fac6ed4a087bf17f0ed8e41c42e07682871796e7", tick: 3000 }',
     'tdm_1v1: { hash: "df7b19ab8c88a3e1da243c93d76c837fc0ec0b06900259f4e92ead2f405c83f8", tick: 3000 }'),
    (TIE, 'tdm_2v2: { hash: "a9ca0c858792da3588f4c74dddedb3761c34a4a638b5b91261dca0468ed2d44c", tick: 3000 }',
     'tdm_2v2: { hash: "0af19ee467fcb2ff76059fcafb8e3010daa8ea9bfe80e1e0e9bca50d9d27a2a5", tick: 3000 }'),
    (TIE, 'tdm_4v4: { hash: "da66d598db143623fff6fb30f0ec8e9c76ad4082d34e4dacfcdd95639944c795", tick: 2286 }',
     'tdm_4v4: { hash: "682cd1e9276a3ca00aa465efc44dfb842fe85b00778972208f2a37284d4eefbb", tick: 2371 }'),
    (TIE, 'ctf_1v1: { hash: "5ca4f6688ffbf47a581faf70e4748c30dab6827c758e4cd4f12e5944169ad27f", tick: 2000 }',
     'ctf_1v1: { hash: "960c80cc76e70e3028d2bac75eaa30df4db63da3ce7215e39357dbda2d1e4578", tick: 2000 }'),
    (SPAWN, 'GOLDEN_1V1_HASH_E902B0A = "decdf0ae8871c795a708b99c065d5779124b2cdc4c39e0d31100b7716853b9b2"',
     'GOLDEN_1V1_HASH_E902B0A = "2fec122af7cb6cae1add29e13e777ae1cf8ed5ce88a8f3a7a4a0a64a9b1c9f52"'),
    (FIX, '"2v2-open": "33b4233a2c899af3c5733f82c0b8489041e69469e98e39b03a6c91e3db6ce636"',
     '"2v2-open": "e4ab04bdbc7db18c54c9046f10d1ebc9fd060c8160c04d30b0de81ade4bec0ed"'),
    (FIX, '"4v4-real": "70fef4b020f624dc80968b9ad3a73a662e558ea487c8234d9101ae754fbcca70"',
     '"4v4-real": "bc7231c2f169744d68c6ecf1627c6c047d05ea3dd57fa77f491c0c0c0d5bf237"'),
    (BREAK, 'expect(ctrl.deaths("veh_2")).toBeGreaterThanOrEqual(3);', 'expect(ctrl.deaths("veh_2")).toBe(3);'),
    (BREAK, '.respawnsUsed).toBeGreaterThanOrEqual(3);', ".respawnsUsed).toBe(3);"),
]
EXPECT_FAILED = {"A": 0, "B": 7, "C": 0, "D": 8}


def sh(*cmd, **kw):
    return subprocess.run(list(cmd), cwd=WT, env=ENV, **kw)


def sub(path, old, new):
    p = os.path.join(WT, path)
    s = open(p, encoding="utf8").read()
    n = s.count(old)
    if n != 1:
        raise SystemExit(f"ancla {old[:60]!r} en {path}: {n} ocurrencias")
    open(p, "w", encoding="utf8").write(s.replace(old, new))


def restore():
    sh("git", "checkout", "-q", "--", BATTLE, *FILES)


def vitest(tag):
    js = f"/tmp/g3-gc-{tag}.json"
    if os.path.exists(js):
        os.remove(js)
    with open(f"/tmp/g3-gc-{tag}.log", "w") as f:
        r = sh("npx", "vitest", "run", *FILES, "--reporter=default", "--reporter=json", f"--outputFile.json={js}",
               stdout=f, stderr=subprocess.STDOUT)
    d = json.load(open(js, encoding="utf8"))
    failed = sorted(a["fullName"] for fr in d["testResults"] for a in fr["assertionResults"] if a["status"] == "failed")
    return r.returncode, d["numTotalTests"], d["numPassedTests"], failed


def main():
    assert sh("git", "status", "--porcelain", "--untracked-files=no", capture_output=True, text=True).stdout == ""
    head = sh("git", "rev-parse", "HEAD", capture_output=True, text=True).stdout.strip()
    out = {"head": head, "files": FILES, "phases": {}}
    phases = {"A": (False, False), "B": (True, False), "C": (True, True), "D": (False, True)}
    ok = True
    for tag, (disable_rule, old_anchors) in phases.items():
        try:
            if disable_rule:
                sub(BATTLE, RULE_IF, "if (false) {")
            if old_anchors:
                for path, cur, old in OLD_ANCHORS:
                    sub(path, cur, old)
            rc, total, passed, failed = vitest(tag)
        finally:
            restore()
        good = len(failed) == EXPECT_FAILED[tag] and ((rc == 0) == (EXPECT_FAILED[tag] == 0))
        ok &= good
        out["phases"][tag] = {"ruleDisabled": disable_rule, "oldAnchors": old_anchors, "rc": rc, "total": total,
                              "passed": passed, "failed": failed, "expectedFailed": EXPECT_FAILED[tag], "asExpected": good}
        print(f"{tag}\truleDisabled={disable_rule}\toldAnchors={old_anchors}\tVITEST_RC={rc}\t{passed}/{total}"
              f"\tfailed={len(failed)} (esperado {EXPECT_FAILED[tag]})\t{'OK' if good else 'NO'}", flush=True)
        for t in failed:
            print(f"   FAIL {t}", flush=True)
    b, d = set(out["phases"]["B"]["failed"]), set(out["phases"]["D"]["failed"])
    out["B_subset_of_D"] = b <= d
    ok &= b <= d
    clean = sh("git", "status", "--porcelain", "--untracked-files=no", capture_output=True, text=True).stdout == ""
    out["treeCleanAfter"] = clean
    out["GOLDEN_CAUSALITY"] = "PASS" if ok and clean else "FAIL"
    json.dump(out, open(OUT, "w"), indent=2, ensure_ascii=False)
    print(f"B⊆D={b <= d} ARBOL_LIMPIO={clean} GOLDEN_CAUSALITY={out['GOLDEN_CAUSALITY']}", flush=True)
    sys.exit(0 if out["GOLDEN_CAUSALITY"] == "PASS" else 1)


if __name__ == "__main__":
    main()
