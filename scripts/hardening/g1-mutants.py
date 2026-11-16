#!/usr/bin/env python3
"""OLA 2 · G1 · Calibración propia del frente G1 (gate del catálogo por efecto + HE contra muro).

G  · copias SIN efecto (la clase de defecto del P2-1 de la integración): el motor sigue
     COPIANDO el campo del catálogo a la entidad viva (así que el hash de estado cambia),
     pero el comportamiento usa una constante. El gate CATALOG_CONTRACT (D1 por canal de
     efecto) debe ponerse ROJO en ese campo. Con la sonda antigua (stateHash) sobrevivían.
H  · HE_WALL_EXPLOSION_LOS (G1.5): cada pieza de la geometría de cara tiene un mutante que
     pone rojo un caso concreto de apps/arena-engine/tests/g1-he-wall-los.test.ts.

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
]

if __name__ == "__main__":
    run("g1", MUTANTS, sys.argv)
