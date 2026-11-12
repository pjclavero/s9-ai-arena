#!/usr/bin/env python3
"""OLA 2 · MC · Matriz de mutantes del gate CATALOG_CONTRACT y del alcance (17: M1-M12, X1-X4, X2b).

Origen: `.mc-tools/mutants.py` del equipo MC (no estaba en el repo). G1 la trae al repo, con
anclas re-verificadas sobre el árbol integrado de hardening/contracts y el runner común
(mutlib.py: ancla única, control, rc real, árbol limpio).

Cambios de G1 respecto al original:
  · M10 re-anclado: la entrada de `armor.reduction` declara ahora `observes` (canal de efecto).
  · M6 y M12 sobrevivían en el HEAD integrado (P2-1 de INTEGRACION): la sonda del gate medía
    `stateHash()` y el hash v2 de MD serializa la cola de radio y la mina enteras. Con la
    sonda por efecto observable (G1) deben MORIR contra el gate.

Uso (VM112, dentro de flock): python3 -I scripts/hardening/mc-mutants.py <worktree> <salida.json> [IDS|--dry-run]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mutlib import Mutant, run  # noqa: E402

GATE = "packages/module-catalog/catalog-contract.test.ts"
PRULE = "apps/arena-engine/tests/projectile-range-rule.test.ts"
RADIO = "apps/arena-engine/tests/radio-range-value.test.ts"
RANGE = "packages/module-catalog/range-characterization.test.ts"
MINE_NF = "apps/arena-engine/tests/mine-without-fire.test.ts"
RES = "packages/module-catalog/resolve/index.ts"
COMBAT = "apps/arena-engine/src/sim/combat.ts"
SENSORS = "apps/arena-engine/src/sim/sensors.ts"
FS = "packages/module-catalog/field-status.ts"

MUTANTS = [
    Mutant("M1", "campo falso reintroducido en el esquema (movement.terrain)",
           "packages/module-catalog/schema/module.schema.json",
           '"ratedLoadKg": {',
           '"terrain": { "type": "array", "items": { "type": "string" } },\n          "ratedLoadKg": {', [GATE]),
    Mutant("M2", "la frontera resolveVehicle deja de copiar errorM", RES,
           "    errorM: def.errorM,\n", "", [GATE]),
    Mutant("M3", "resolveVehicle no resuelve la vida del proyectil", RES,
           "    projectileLifetimeTicks: projectileLifetime,\n", "", [GATE, RANGE]),
    Mutant("M4", "el motor ignora la vida derivada y vuelve al TTL 90 fijo", COMBAT,
           "    ttlTicks,\n", "    ttlTicks: 90,\n", [GATE, RANGE]),
    Mutant("M5", "TTL - 1 (alcance distinto)", COMBAT,
           "    ttlTicks,\n", "    ttlTicks: ttlTicks - 1,\n", [RANGE]),
    Mutant("M6", "la radio vuelve a alcance infinito (sólo contra el GATE)", SENSORS,
           "  return dist(m.origin, receiverPos) <= m.rangeM;", "  return true;", [GATE]),
    Mutant("M7", "costCredits mal clasificado como ACTIVE", FS,
           'costCredits: V("validator: budget_exceeded / module_cost_cap_exceeded", scale(50, 1000)),',
           'costCredits: A("validator: budget_exceeded / module_cost_cap_exceeded", scale(50, 1000), ["damage"]),',
           [GATE]),
    Mutant("M8", "la UI vuelve a decir que weapon.rangeM es FUTURE",
           "packages/module-catalog/effect-status.ts",
           'rangeM: p("ACTIVE", false, "Alcance real del proyectil',
           'rangeM: p("FUTURE", false, "Alcance real del proyectil', [GATE]),
    Mutant("M9", "el validador deja de comprobar maxLoadKg",
           "packages/module-catalog/validator/index.ts",
           r"if \(([^\n]*maxLoadKg[^\n]*)\)", "if (false)", [GATE], regex=True),
    Mutant("M10", "una entrada ACTIVE sin mutación (sin perturb)", FS,
           'reduction: A("combat.ts applyDamage", scale(0.2), ["damage"]),',
           'reduction: { status: "ACTIVE", consumer: "combat.ts applyDamage", observes: ["damage"] },', [GATE]),
    Mutant("M11", "deployMine vuelve a exigir fire en el mismo comando", "apps/arena-engine/src/sim/battle.ts",
           "      if (!cmd) continue;\n      const wantsFire = Array.isArray(cmd.fire) && cmd.fire.length > 0;\n"
           "      if (!wantsFire && !cmd.deployMine) continue;",
           "      if (!cmd?.fire?.length || !Array.isArray(cmd.fire)) continue;\n      const wantsFire = true;\n"
           "      if (false) continue;", [MINE_NF]),
    Mutant("M12", "la sonda deja de pisar la mina (daño/radio/armado sólo copiados a la mina)",
           "packages/module-catalog/catalog-probe.ts",
           "const target = mine?.position ??",
           "const target = (false as boolean ? mine?.position : undefined) ??", [GATE]),
    Mutant("X1", "el alcance deja de derivarse de rangeM (90 fijo)", COMBAT,
           "const ttl = projectileLifetimeTicks(spec.rangeM, spec.projectileSpeedMs);", "const ttl = 90;", [PRULE]),
    Mutant("X2", "reaparece la regla heredada de 90 para specs sin rangeM", COMBAT,
           "projectileSpeedMs === undefined) {\n    throw", "projectileSpeedMs === undefined) {\n    return 90;\n    throw",
           [PRULE]),
    Mutant("X2b", "se deja de comprobar la coherencia de la vida derivada", COMBAT,
           "spec.projectileLifetimeTicks !== ttl", "false", [PRULE]),
    Mutant("X3", "el alcance de radio se duplica", SENSORS,
           "<= m.rangeM;", "<= m.rangeM * 2;", [RADIO]),
    Mutant("X4", "la radio ignora el rendimiento del módulo", SENSORS,
           "(r.spec.rangeM ?? 0) * sender.performanceOf(slot)", "(r.spec.rangeM ?? 0)", [RADIO]),
]

if __name__ == "__main__":
    run("mc", MUTANTS, sys.argv)
