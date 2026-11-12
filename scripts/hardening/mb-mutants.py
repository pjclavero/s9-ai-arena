#!/usr/bin/env python3
"""OLA 2 · MB · Matriz de mutantes del gate DAMAGE_CONTRACT (12 + M9 de la ronda de revisión).

Origen: `mb-mutants.py` del equipo MB (informes/mb-evidencias y VM112; no estaba en el repo),
versión de 12 mutantes (M1, M2, M2b, M3, M3b, M3c, M4, M4b, M5, M6, M7, M8). El M9 de la
ronda de revisión (turretRateRads de la montura de chassis.medium@1 de 1.0 a 2.2) NO estaba
en ninguna copia: G1 lo RECONSTRUYE desde REVIEW-MB-2 §3 («M9: turretRateRads de
chassis.medium@1 de 1.0 a 2.2 → rc=1, 3 tests fallan»). Total: 13.

Todos contra apps/arena-engine/tests/damage-contract.test.ts, con el runner común (mutlib.py).
Uso (VM112, dentro de flock): python3 -I scripts/hardening/mb-mutants.py <worktree> <salida.json> [IDS|--dry-run]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mutlib import Mutant, run  # noqa: E402

T = ["apps/arena-engine/tests/damage-contract.test.ts"]
BATTLE = "apps/arena-engine/src/sim/battle.ts"
DAMAGE = "apps/arena-engine/src/sim/damage.ts"
VEHICLE = "apps/arena-engine/src/sim/vehicle.ts"
CONTRACT = "packages/game-rules/damage-contract.ts"
EFFECTIVE = "const effective = Math.max(profile.minFraction * amount, amount * (1 - reduction));"


def m(id_, desc, path, old, new):
    return Mutant(id_, desc, path, old, new, T)


MUTANTS = [
    m("M1", "HE: el impactado directo vuelve a recibir su propia onda (doble daño)", BATTLE,
      "      if (v.id === excludeId) continue;\n", ""),
    m("M2", "variación de daño con el RNG del motor (D-B3)", DAMAGE, EFFECTIVE,
      EFFECTIVE[:-1] + " * (0.9 + 0.2 * rng.next());"),
    m("M2b", "variación de daño con Math.random (D-B3)", DAMAGE, EFFECTIVE,
      EFFECTIVE[:-1] + " * (0.95 + 0.1 * Math.random());"),
    m("M3", "el arco de torreta vuelve a leerse del arma (D-B2)", VEHICLE,
      "    return this.mountOf(slot)?.turretArcRad ?? 0;",
      "    return (this.modules.get(slot)?.spec as any)?.turretArcRad ?? this.mountOf(slot)?.turretArcRad ?? 0;"),
    m("M3b", "la tasa de torreta vuelve a leerse del arma (D-B2)", VEHICLE,
      "      rate = Math.max(rate, mount.turretRateRads * this.performanceOf(w.spec.slot));",
      "      rate = Math.max(rate, ((w.spec as any).turretRateRads ?? mount.turretRateRads) * this.performanceOf(w.spec.slot));"),
    m("M3c", "el arco sólo se aplica al disparar, no al girar", VEHICLE,
      "    const limited = arc < FULL_ARC;", "    const limited = false && arc < FULL_ARC;"),
    m("M4", "hullLevel con N distinto de 20 (D-B5)", CONTRACT,
      "export const HULL_LEVEL_STEPS = 20;", "export const HULL_LEVEL_STEPS = 10;"),
    m("M4b", "hullLevel ignora N por defecto", CONTRACT,
      "export function hullLevel(hullHp: number, hullHpMax: number, steps: number = HULL_LEVEL_STEPS): number {",
      "export function hullLevel(hullHp: number, hullHpMax: number, steps: number = 16): number {"),
    m("M5", "el daño de zona sortea la puerta única resolveDamage", BATTLE,
      '        this.damageVehicle(v, dps * TICK_DT, z.position, poses, null, null, ZONE_DAMAGE_TYPE, "zone");',
      "        v.hullHp = Math.max(0, v.hullHp - dps * TICK_DT);\n        if (v.hullHp <= 0) v.alive = false;"),
    m("M6", "candidatos de módulo sin ordenar por slot", DAMAGE,
      "      .sort((a, b) => (a.spec.slot < b.spec.slot ? -1 : a.spec.slot > b.spec.slot ? 1 : 0));", ";"),
    m("M7", "rumbo de torreta sin normalizar", VEHICLE,
      "    this.turretHeading = normalizeAngle(this.turretHeading);\n  }", "  }"),
    m("M8", "blindaje con copia propia de hp (doble fuente)", VEHICLE,
      "          get hp() {\n            return rt.hp;\n          },\n          set hp(v: number) {\n            rt.hp = v;\n          },",
      "          hp: m.hp,"),
    # Reconstruido por G1 desde REVIEW-MB-2 §3.
    m("M9", "montura de chassis.medium@1 a 2,2 rad/s (rebalanceo silencioso del giro)",
      "packages/module-catalog/data/chassis.medium@1.json",
      '"id": "turret_main", "accepts": ["weapon"], "maxSize": "L", "mount": { "turretRateRads": 1.0,',
      '"id": "turret_main", "accepts": ["weapon"], "maxSize": "L", "mount": { "turretRateRads": 2.2,'),
]

if __name__ == "__main__":
    run("mb", MUTANTS, sys.argv)
