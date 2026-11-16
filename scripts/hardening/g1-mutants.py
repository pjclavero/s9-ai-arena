#!/usr/bin/env python3
"""OLA 2 · G1 · Calibración propia del frente G1 (gate del catálogo por efecto + HE contra muro).

G  · copias SIN efecto (la clase de defecto del P2-1 de la integración): el motor sigue
     COPIANDO el campo del catálogo a la entidad viva (así que el hash de estado cambia),
     pero el comportamiento usa una constante. El gate CATALOG_CONTRACT (D1 por canal de
     efecto) debe ponerse ROJO en ese campo. Con la sonda antigua (stateHash) sobrevivían.
H  · HE_WALL_EXPLOSION_LOS (G1.5): cada pieza de la geometría de cara tiene un mutante que
     pone rojo un caso concreto de apps/arena-engine/tests/g1-he-wall-los.test.ts.
     H7-H10 (ronda 2, P1-1): origen del tramo DENTRO del muro (boca del arma de un vehículo
     pegado a él).
R  · ronda 2 (P2-1): los mutantes R1-R6 de la revisión independiente (evidencia-G1-review/
     rev-mutants.py), «el campo se copia a la observación / al registro / al cálculo del
     canal, pero el efecto real usa una constante». Deben morir en el D1 del GATE de su campo
     (filtro -t al D1), no sólo en anclas de hash o goldens.

Uso: scripts/hardening/run-mutants.sh g1 <worktree> <salida.json> [IDS]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mutlib import Mutant, run  # noqa: E402

GATE = "packages/module-catalog/catalog-contract.test.ts"
HE = "apps/arena-engine/tests/g1-he-wall-los.test.ts"
BATTLE = "apps/arena-engine/src/sim/battle.ts"
PHYSICS = "apps/arena-engine/src/sim/physics.ts"
SENSORS = "apps/arena-engine/src/sim/sensors.ts"
VEHICLE = "apps/arena-engine/src/sim/vehicle.ts"
DAMAGE = "apps/arena-engine/src/sim/damage.ts"
EFFECTIVE = "const effective = Math.max(profile.minFraction * amount, amount * (1 - reduction));"
INSIDE = "    if (h.collider.containsPoint(from)) return this.entrySurface(h.collider, from, dir, entityId, point);\n"
TOUCH = "    if (hit && (hit.timeOfImpact <= 0 || (hit.normal.x === 0 && hit.normal.y === 0)))\n"
MINE_EXPLODE = "this.explode(m.position, m.damage, m.explosionRadiusM, poses, m.ownerId, m.team, \"deployable\", null);"

MUTANTS = [
    Mutant("G1", "mina: triggerRadiusM copiado a la mina pero la detonación usa 2 m fijos", BATTLE,
           "> m.triggerRadiusM) continue;", "> 2) continue;", [GATE],
           name_filter="mine.triggerRadiusM",
           expect="D1 mine.triggerRadiusM: sin efecto observable en [mines]"),
    Mutant("G2", "mina: damage copiado a la mina pero la onda usa 40 fijos", BATTLE,
           MINE_EXPLODE, MINE_EXPLODE.replace("m.damage,", "40,"), [GATE],
           name_filter="mine.damage",
           expect="D1 mine.damage: sin efecto observable en [damage]"),
    Mutant("G3", "mina: explosionRadiusM copiado a la mina pero la onda usa 6 m fijos", BATTLE,
           MINE_EXPLODE, MINE_EXPLODE.replace("m.explosionRadiusM,", "6,"), [GATE],
           name_filter="mine.explosionRadiusM",
           expect="D1 mine.explosionRadiusM: sin efecto observable en [damage]"),
    Mutant("H1", "la onda de un impacto en muro vuelve a la línea de visión desde P (el defecto)", BATTLE,
           "      const los = surface\n", "      const los = (null as ImpactSurface | null)\n", [HE],
           expect="víctima visible / parcial / borde del mapa: menos ondas que impactos"),
    Mutant("H2", "sin semiplano de la cara: el muro golpeado no tapa a quien está detrás", PHYSICS,
           "    for (const n of touching.values()) if (dx * n.x + dy * n.y < 0) return false;\n", "", [HE],
           expect="víctima detrás del muro golpeado recibe la onda; F: detrás del muro = true"),
    Mutant("H3", "sólo se decide por cara el sólido golpeado (no los coplanarios que contienen P)", PHYSICS,
           "      if ((kind === \"wall\" || kind === \"destructible\") && !touching.has(handle)) {",
           "      if (false) {", [HE],
           expect="muros coplanarios / borde del mapa: el otro muro tapa la onda"),
    Mutant("H4", "normal de la cara invertida", PHYSICS,
           "const normal = hit ? { x: hit.normal.x, y: hit.normal.y }",
           "const normal = hit ? { x: -hit.normal.x, y: -hit.normal.y }", [HE],
           expect="normal (1,0) en vez de (-1,0); la víctima visible deja de recibir la onda"),
    Mutant("H5", "el hit_taken de la onda vuelve al rayo desde la víctima hacia P", BATTLE,
           "      const canSee = blastSurface\n", "      const canSee = (null as ImpactSurface | null)\n", [HE],
           expect="hit_taken de la onda sin sourceId"),
    Mutant("H6", "otro obstáculo deja de comprobarse (sólo cuenta la cara)", PHYSICS,
           "    if (!hit) return true;\n    const id = this.colliderToId.get(hit.collider.handle);",
           "    if (true) return true;\n    const id = this.colliderToId.get(hit!.collider.handle);", [HE],
           expect="víctima tapada por otro obstáculo recibe la onda"),
    # ---- ronda 2 · P1-1: boca del arma DENTRO del muro
    Mutant("H7", "origen dentro del muro sin tratar: vuelve la normal (0,0) de Rapier (el P1-1)", PHYSICS,
           INSIDE, "", [HE],
           also=[(TOUCH, "    if (false)\n", 1)],
           expect="boca dentro del muro: la víctima oculta recibe la onda; F: normal (0,0)"),
    Mutant("H8", "cara de entrada con la normal invertida (apunta al interior)", PHYSICS,
           "const nl = axis === 0 ? { x: u[0]! > 0 ? -1 : 1, y: 0 } : { x: 0, y: u[1]! > 0 ? -1 : 1 };",
           "const nl = axis === 0 ? { x: u[0]! > 0 ? 1 : -1, y: 0 } : { x: 0, y: u[1]! > 0 ? 1 : -1 };", [HE],
           expect="boca dentro del muro: la víctima del mismo lado deja de recibir la onda"),
    Mutant("H9", "la onda sigue centrada en el impacto (la boca, dentro del muro), no en la cara", BATTLE,
           "            surface ? surface.point : impact,\n", "            impact,\n", [HE],
           expect="cada onda del tirador pegado daña ~2 % menos que la del disparo lejano"),
    Mutant("H10", "punto de entrada sin recalcular: P se queda en la boca (sólo la normal de la cara)", PHYSICS,
           "    return { point: e.point, entityId, normal: e.normal };",
           "    return { point: { x: point.x, y: point.y }, entityId, normal: e.normal };", [HE],
           expect="F: el punto de la superficie no está en la cara; B: la onda no sale de la cara"),
    Mutant("H11", "punto de entrada con el t de SALIDA (cara del otro lado del muro)", PHYSICS,
           "const tNear = Math.min((-h[a]! - o[a]!) / u[a]!, (h[a]! - o[a]!) / u[a]!);",
           "const tNear = Math.max((-h[a]! - o[a]!) / u[a]!, (h[a]! - o[a]!) / u[a]!);", [HE],
           expect="F: la superficie cae en la cara opuesta; B: la víctima oculta recibe la onda"),
    # ---- ronda 2 · P2-1: R1-R6 de la revisión, contra el D1 del gate
    Mutant("R1", "sensor.fovRad copiado a la observación; rayos con FOV constante pi/2", SENSORS,
           "const a = pose.heading - fov / 2 + fov * t;",
           "const a = pose.heading - Math.PI / 4 + (Math.PI / 2) * t;", [GATE],
           name_filter="sensor\\.fovRad",
           expect="D1 sensor.fovRad: sin efecto observable en [sensors]"),
    Mutant("R2", "sensor.errorM copiado al contacto; ruido de posición constante 2 m", SENSORS,
           "const ex = (rng.next() * 2 - 1) * err;", "const ex = (rng.next() * 2 - 1) * 2;", [GATE],
           also=[("const ey = (rng.next() * 2 - 1) * err;", "const ey = (rng.next() * 2 - 1) * 2;", 1)],
           name_filter="sensor\\.errorM",
           expect="D1 sensor.errorM: sin efecto observable en [sensors]"),
    Mutant("R3", "armor.reduction copiada al registro de daño; efectivo con reducción constante 0,3", DAMAGE,
           EFFECTIVE,
           "const effective = Math.max(profile.minFraction * amount, amount * (1 - (armorActive ? Math.min(0.3, ARMOR_REDUCTION_MAX) : 0)));",
           [GATE], name_filter="armor\\.reduction",
           expect="D1 armor.reduction: sin efecto observable en [damage]"),
    Mutant("R4", "power.capacityEU copiada (energyCapacity); reserva y tope reales constantes 300", VEHICLE,
           "this.energyEU = clamp(this.energyEU + net * dt, 0, this.energyCapacity());",
           "this.energyEU = clamp(this.energyEU + net * dt, 0, 300);", [GATE],
           also=[("this.energyEU = this.energyCapacity();", "this.energyEU = 300;", 2)],
           name_filter="power\\.capacityEU",
           expect="D1 power.capacityEU: sin efecto observable en [energy]"),
    Mutant("R5", "chassis.hullHp sólo como denominador de hullLevel; casco real constante 300", VEHICLE,
           "this.hullHp = spec.hullHp;", "this.hullHp = 300;", [GATE],
           also=[("this.hullHp = this.spec.hullHp;", "this.hullHp = 300;", 1)],
           name_filter="chassis\\.hullHp",
           expect="D1 chassis.hullHp: sin efecto observable en [hull]"),
    Mutant("R6", "weapon.damage copiado a base del registro; efectivo con importe constante 20", DAMAGE,
           EFFECTIVE + "\n  const absorbed = amount - effective;",
           "const effective = Math.max(profile.minFraction * 20, 20 * (1 - reduction));\n  const absorbed = 20 - effective;",
           [GATE], name_filter="weapon\\.damage",
           expect="D1 weapon.damage: sin efecto observable en [damage]"),
]

if __name__ == "__main__":
    run("g1", MUTANTS, sys.argv)
