#!/usr/bin/env python3
"""OLA 2 · G2 · Mutantes de calibración de lo que G2 añade (se ejecuta EN VM112, dentro de flock, en serie).

Uso: python3 scripts/hardening/g2-mutants.py <worktree> <salida.json> [G1,G2,...]

Mismo patrón que ma-mutants.py: cambio mínimo con ancla ÚNICA (un patrón ausente o repetido se
registra como `error`, killed=false, nunca se omite), vitest sobre los tests que lo deben matar,
rc REAL y restauración con `git checkout`. El árbol debe estar limpio (commit) antes de empezar.

`expect` (opcional): subcadena que debe aparecer en la salida de vitest; así un mutante no cuenta
como muerto por una razón ajena (p. ej. un error de carga).
"""
import json
import re
import subprocess
import sys

WT = sys.argv[1]
OUT = sys.argv[2]
ONLY = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else None

P = "packages/projection/"
PURE = P + "projection.test.ts"
ARMOR = "apps/arena-engine/tests/contract-pending/armor-exact.test.ts"
IDS = "apps/arena-engine/tests/contract-pending/projection-ids.test.ts"
EQP = "apps/arena-engine/tests/contract-pending/equipment-privacy.test.ts"
RDET = "apps/arena-engine/tests/contract-pending/replay-determinism.test.ts"
BLIFE = "apps/bot-manager/tests/contract-pending/battle-lifecycle.test.ts"
XVFB = "apps/streamer/tests/contract-pending/xvfb-on-demand.test.ts"
WORKER = "apps/tournament-worker/tests/contract-pending/battle-lifecycle-worker.test.ts"
HUD = "apps/web/tests/g2-hud-armor-broken.test.tsx"
PS = "apps/arena-engine/src/protocol-server.ts"
RES = "apps/tournament-worker/src/battle-resources.ts"
CA = "apps/tournament-worker/src/container-agents.ts"

# (nombre, fichero, patrón, reemplazo, tests, expect-opcional, ediciones-extra-opcionales)
MUTANTS = [
    # ------------------------------------------------------------ D-B4 · armorBroken público
    ("G1_armor_all_sectors_leak", P + "project-frame.ts",
     "Number.isFinite(sec.hpMax) && armorBroken(sec.hp, sec.hpMax)) broken[s] = true;",
     "Number.isFinite(sec.hpMax)) (broken as any)[s] = armorBroken(sec.hp, sec.hpMax);",
     [PURE, ARMOR], None),
    ("G2_policy_row_removed", P + "policy.ts",
     '    "vehicle.armorBroken": all("SANITIZED"),\n', "", [PURE, ARMOR, HUD], None),
    ("G3_projection_never_emits", P + "project-frame.ts",
     "    if (Object.keys(broken).length > 0) out.armorBroken = broken;", "    void broken;", [PURE, ARMOR], None),
    ("G4_internal_frame_without_armor", "apps/arena-engine/src/sim/internal-frame.ts",
     "        armor: Object.fromEntries(", "        armorX: Object.fromEntries(", [ARMOR], None),
    ("G5_exact_hp_leak", P + "project-frame.ts",
     "if (sec && Number.isFinite(sec.hp)", "if (sec && ((broken as any)[s + 'Hp'] = sec.hp, true) && Number.isFinite(sec.hp)",
     [PURE, ARMOR], None),
    ("G6_overlay_ignores_armor_broken", "apps/web/src/viewer/overlay.ts",
     "        armorBrokenSectors: armorBrokenSectorsOf(v.armorBroken),", "        armorBrokenSectors: [],", [HUD], None),
    ("G7_hud_phantom_icon", "apps/web/src/viewer/damage-visuals.ts",
     "  if ((v.armorBrokenSectors?.length ?? 0) > 0) armorBroken = true;", "  armorBroken = true;", [HUD], None),
    ("G8_overlay_sticky_state", "apps/web/src/viewer/overlay.ts",
     "        armorBrokenSectors: armorBrokenSectorsOf(v.armorBroken),",
     "        armorBrokenSectors: [...new Set([...(this.vehicles.get(v.id)?.armorBrokenSectors ?? []), ...armorBrokenSectorsOf(v.armorBroken)])],",
     [HUD], None),
    # ------------------------------------------------ MA · observación del bot por el protocolo
    ("G9_bot_observation_raw", PS, "this.ids.observation(observation)", "observation", [IDS], "contrato MA cumplido · G2"),
    ("G10_bot_event_raw", PS, "this.ids.event(event)", "event", [IDS], "contrato MA cumplido · G2"),
    ("G11_bot_welcome_internal_self", PS, "selfId: ids.selfId(),", "selfId: vehicle.id,", [IDS], "contrato MA cumplido · G2"),
    # ------------------------------------------------------------ MF · contratos en el worker
    ("G12_battle_free_not_idempotent", "apps/arena-engine/src/sim/physics.ts",
     "    if (this.freed) return;\n", "", [BLIFE], "Battle.free() dos veces"),
    ("G13_xvfb_not_started", "apps/streamer/src/supervisor.ts",
     "    if (this.opts.display) {\n      // OLA2-MF", "    if (false && this.opts.display) {\n      // OLA2-MF", [XVFB], "arranca Xvfb"),
    ("G14_xvfb_after_chromium", "apps/streamer/src/supervisor.ts",
     "    if (this.opts.display) {\n      // OLA2-MF", "    this.launchPipeline();\n    if (this.opts.display) {\n      // OLA2-MF", [XVFB], None),
    # ------------------------------------------------------ REVIEW-ME-2 P2-A / P2-B
    ("G15_hashsees_undo_broken_is_fixture_error", RDET,
     "        return [() => p.ttlTicks--, () => p.ttlTicks++];", "        return [() => p.ttlTicks--, () => p.ttlTicks];", [RDET], "FixtureError"),
    ("G16_owner_loses_exact_damage", P + "policy.ts",
     '    "stats.damageDealt": ownerOnly(),', '    "stats.damageDealt": all("PRIVATE"),', [EQP], "owner"),
    ("G17_third_party_gets_damage", P + "policy.ts",
     '    "stats.damageTaken": ownerOnly(),', '    "stats.damageTaken": PUBLIC,', [EQP], None),
    ("G18_hits_not_quantized_for_third", P + "equipment.ts",
     '  if ("shotsHit" in out && q("shotsHit")) out.shotsHit = step(out.shotsHit, STATS_HITS_STEP);', "", [EQP], None),
    ("G19_permodule_public", P + "policy.ts",
     '    "stats.perModule": ownerOnly(),', '    "stats.perModule": PUBLIC,', [EQP], None),
    ("G20_radio_stats_public", P + "policy.ts",
     '    "stats.radio": ownerOnly(),', '    "stats.radio": PUBLIC,', [EQP], None),
]
# Los mutantes de MF en el worker se añaden con su ancla real tras medir (ver informe G2).
EXTRA_PATH = sys.argv[4] if len(sys.argv) > 4 else None
if EXTRA_PATH:
    MUTANTS += [tuple(m) for m in json.load(open(EXTRA_PATH))]
if ONLY:
    MUTANTS = [m for m in MUTANTS if m[0] in ONLY]


def run(cmd, timeout=1500):
    p = subprocess.run(cmd, cwd=WT, shell=True, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout + p.stderr


def apply(path, old, new):
    full = f"{WT}/{path}"
    s = open(full).read()
    if s.count(old) != 1:
        raise RuntimeError(f"patrón no único/ausente en {path}: {old[:60]!r}")
    open(full, "w").write(s.replace(old, new))


results = []
for m in MUTANTS:
    name, path, old, new, tests, expect = m[:6]
    entry = {"mutant": name, "file": path, "tests": tests}
    try:
        apply(path, old, new)
        rc, out = run("npx vitest run --maxWorkers=1 " + " ".join(tests))
        clean = re.sub(r"\x1b\[[0-9;]*m", "", out)
        entry["vitest_rc"] = rc
        entry["failing"] = sorted(set(re.findall(r"FAIL\s+(\S+ > .+)", clean)))[:6]
        entry["summary"] = [l.strip() for l in clean.splitlines() if l.strip().startswith(("Test Files", "Tests "))]
        # Muerto = rc != 0 Y (si se pide) la razón esperada aparece en la salida.
        entry["expect"] = expect
        entry["expect_seen"] = (expect in clean) if expect else None
        entry["killed"] = rc != 0 and (expect is None or expect in clean)
    except Exception as e:  # noqa: BLE001
        entry["error"] = str(e)
        entry["killed"] = False
    finally:
        run(f"git checkout -- {path}")
    results.append(entry)
    print(json.dumps({k: entry.get(k) for k in ("mutant", "vitest_rc", "killed", "error")}), flush=True)

rc, st = run("git status --porcelain")
json.dump({"results": results, "tree_after": st.strip()}, open(OUT, "w"), indent=1, ensure_ascii=False)
print("TREE_AFTER=" + (st.strip() or "clean"))
print("KILLED=%d/%d" % (sum(1 for r in results if r.get("killed")), len(results)))
