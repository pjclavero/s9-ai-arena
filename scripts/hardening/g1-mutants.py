#!/usr/bin/env python3
"""OLA 2 · G1 · Calibración propia del frente G1 (gate del catálogo por efecto + HE contra muro).

G  · copias SIN efecto (la clase de defecto del P2-1 de la integración): el motor sigue
     COPIANDO el campo del catálogo a la entidad viva (así que el hash de estado cambia),
     pero el comportamiento usa una constante. El gate CATALOG_CONTRACT (D1 por canal de
     efecto) debe ponerse ROJO en ese campo. Con la sonda antigua (stateHash) sobrevivían.
H  · HE_WALL_EXPLOSION_LOS (G1.5): cada pieza de la geometría de cara tiene un mutante que
     pone rojo un caso concreto de apps/arena-engine/tests/g1-he-wall-los.test.ts.
     H7-H11 (ronda 2, P1-1): origen del tramo DENTRO del muro (boca del arma de un vehículo
     pegado a él).
R  · ronda 2 (P2-1): los mutantes R1-R6 de la revisión independiente (evidencia-G1-review/
     rev-mutants.py), «el campo se copia a la observación / al registro / al cálculo del
     canal, pero el efecto real usa una constante». Deben morir en el D1 del GATE de su campo
     (filtro -t al D1), no sólo en anclas de hash o goldens.
N  · ronda 3 (P2-1b): N1, N2 y N2b de la segunda revisión (evidencia-G1-review/ronda2/
     rev2-mutants.py): casco con su valor inicial copiado pero muerte por un umbral fijo, y
     registro de daño que sigue al importe mientras lo APLICADO es constante. Mueren en su D1.
K  · ronda 3: la misma clase sobre otros canales (sensores, energía, munición): el campo se
     copia (a la observación, a una comprobación, a un contador) y el efecto usa una
     constante. Mueren en el D1 de su campo.
P  · ronda 3: defensa ESTRUCTURAL. Cada mutante reintroduce en la SONDA un canal que copia la
     configuración (un nivel absoluto, el valor inicial, el registro de daño, el importe de
     los eventos); el bloque D0 del gate (D0a traslación de reservas, D0b registro falseado)
     debe ponerse rojo. Calibran la defensa: sin ellos, D0 podría pasar en vacío.
E  · ronda 4 (P2-1c): E1 y E3 de la tercera revisión (evidencia-G1-review/ronda3/
     rev3-mutants.py), sin modificar, y sus controles E5 y E6. «El consumidor ya no limita,
     pero el estado propio sigue cambiando»: la energía se gasta y se recarga sin limitar
     nada (E1); el arco no limita el giro ni el disparo, pero se emite out_of_arc (E3). Mueren
     en el D1 «gobierna» de su campo (y en su ablación D4), no en el «cambia» (observes).
Q  · ronda 4: la misma clase, «consumidor quitado, estado intacto», en otros campos cuyo
     `observes` era su propio estado: el casco se descuenta pero nadie muere (Q1), el blindaje
     se desgasta pero no protege (Q2), y el estado de un módulo destruido se calcula pero el
     módulo sigue funcionando: arma (Q3), movimiento (Q4), sensor (Q5), radio (Q6) y mina (Q7).
     Vivos con el gate de fe138fe; mueren en el D1 «gobierna» de su campo.
F  · ronda 5 (P2-1d): «consumidor quitado con huella en el RNG». F1, F2 y F3 de la cuarta
     revisión (evidencia-G1-review/ronda4/rev4-mutants.py), sin modificar: la energía no
     limita pero su falta consume una tirada del flujo combat (F1); el error del radar es fijo
     y errorM sólo decide cuántas tiradas de sensores se consumen (F2); F3 es el control del
     sumidero. F4 (autor): la misma clase en ammo.rounds. F5 (autor): el ruido del radar se
     anula con el MISMO consumo de tiradas. Mueren en el gate porque D1 y D4 se evalúan con el
     RNG NEUTRO de la sonda. F2R/F5R: los mismos F2/F5 contra el test de comportamiento del
     radar (apps/arena-engine/tests/g1-radar-error.test.ts), fuera del gate.
U  · ronda 5: defensa ESTRUCTURAL de la regla «mismo comportamiento con distinto consumo del
     RNG ⇒ mismo resultado» (bloque D5 del gate). U1: el modo neutro se ignora (la sonda usa el
     RNG del motor); U2: la tirada neutra avanza con cada consumo. D5 debe ponerse rojo.
I  · ronda 6 (P2-1e): «consumidor quitado con huella en un CONTADOR interno» (ids de entidad).
     RH1 = el H1 de la quinta revisión (evidencia-G1-review/ronda5/rev5-mutants.py; se renombra
     porque H1 ya es un mutante HE de esta matriz), sin modificar: la
     energía no limita y, cuando falta, se gasta un id de entidad antes de disparar o sembrar.
     I1 (autor): la misma clase sólo al sembrar minas (mine.power.perActionEU). Mueren en el
     gate porque los canales projectiles/mines registran la etiqueta observable, no el id.
W  · ronda 6: defensa ESTRUCTURAL D6 (ids de entidad gastados de más ⇒ mismos canales).
     W1/W2: los canales projectiles / mines vuelven a registrar el id crudo. D6 debe ponerse rojo.

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
PROBE = "packages/module-catalog/catalog-probe.ts"
COMBAT = "apps/arena-engine/src/sim/combat.ts"
RADAR = "apps/arena-engine/tests/g1-radar-error.test.ts"
F2_OLD = "const err = (s.spec.errorM ?? 2) / Math.max(0.25, perf);"
F2_NEW = "const err = 2; for (let i = 0; i < Math.round(s.spec.errorM ?? 2); i++) rng.next();"
F5_EX = "const ex = (rng.next() * 2 - 1) * err;"
F5_EY = "const ey = (rng.next() * 2 - 1) * err;"
FIRE_SEQ = 'const p = fire(v, slot, this.tick, muzzle, this.rng.stream("combat"), this.entitySeq++);'
MINE_REJ = ('        if (rej) {\n          this.emit({ kind: "rejected_action", slot: cmd.deployMine.slot, reason: rej }, v.id);\n'
            '        } else {')
MINE_SPEND = "\n          if (v.energyEU < (v.modules.get(cmd.deployMine.slot)?.spec.perActionEU ?? 0)) this.entitySeq++;"
EFFECTIVE = "const effective = Math.max(profile.minFraction * amount, amount * (1 - reduction));"
INSIDE = "    if (h.collider.containsPoint(from)) return this.entrySurface(h.collider, from, dir, entityId, point);\n"
TOUCH = "    if (hit && (hit.timeOfImpact <= 0 || (hit.normal.x === 0 && hit.normal.y === 0)))\n"
HULL_SUB = "target.hullHp = Math.max(0, target.hullHp - hull);"
ARMOR_SUB = "armor.hp = Math.max(0, armor.hp - absorbed * profile.armorWearFactor);"
MODULE_SUB = "m.hp = Math.max(0, m.hp - moduleBudget);"
N2_ALSO = [(HULL_SUB, "target.hullHp = Math.max(0, target.hullHp - 10);", 1),
           (MODULE_SUB, "m.hp = Math.max(0, m.hp - 2);", 1)]
MINE_EXPLODE = "this.explode(m.position, m.damage, m.explosionRadiusM, poses, m.ownerId, m.team, \"deployable\", null);"
REJECT = ('        if (rejection) {\n          this.emit({ kind: "rejected_action", slot, reason: rejection }, v.id);\n'
          '          continue;\n        }')
REJECT_BUT = ('        if (rejection) {\n          this.emit({ kind: "rejected_action", slot, reason: rejection }, v.id);\n'
              '          if (rejection !== "%s") continue;\n        }')

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
    # ---- ronda 3 · P2-1b: N1/N2/N2b de la segunda revisión, contra el D1 del gate
    Mutant("N1", "chassis.hullHp copiado al estado; muerte con 300 de daño acumulado constante", DAMAGE,
           HULL_SUB, "target.hullHp = target.hullHp - hull;", [GATE],
           also=[("const killed = target.hullHp <= 0 && target.alive;",
                  "const killed = target.spec.hullHp - target.hullHp >= 300 && target.alive;", 1)],
           name_filter="chassis\\.hullHp",
           expect="D1 chassis.hullHp: sin efecto observable en [hull]"),
    Mutant("N2", "weapon.damage al registro; casco/módulo/blindaje APLICADOS constantes (-10/-2/-1)", DAMAGE,
           ARMOR_SUB, "armor.hp = Math.max(0, armor.hp - 1);", [GATE], also=N2_ALSO,
           name_filter="weapon\\.damage",
           expect="D1 weapon.damage: sin efecto observable en [damage]"),
    Mutant("N2b", "ammo.damageMultiplier al registro; aplicados constantes (el mismo mutante, otro campo)", DAMAGE,
           ARMOR_SUB, "armor.hp = Math.max(0, armor.hp - 1);", [GATE], also=N2_ALSO,
           name_filter="ammo\\.damageMultiplier",
           expect="D1 ammo.damageMultiplier: sin efecto observable en [damage]"),
    # ---- ronda 3 · la misma clase sobre otros canales (propios)
    Mutant("K1", "sensor.fovRad copiado al ÁNGULO informado de cada rayo; el rayo se lanza con FOV pi/2 fijo",
           SENSORS, "const hit = world.physics.castRay(origin, a, range, v.id);",
           "const hit = world.physics.castRay(origin, pose.heading - Math.PI / 4 + (Math.PI / 2) * t, range, v.id);",
           [GATE], name_filter="sensor\\.fovRad",
           expect="D1 sensor.fovRad: sin efecto observable en [sensors] (vivo con la sonda de 577bd59, que registraba el ángulo)"),
    Mutant("K2", "power.perActionEU copiado a la comprobación no_energy; el gasto real es 1 EU fijo", COMBAT,
           "v.spendEnergy(w.spec.perActionEU ?? 0);", "v.spendEnergy(1);", [GATE],
           also=[("v.spendEnergy(m.spec.perActionEU ?? 0);", "v.spendEnergy(1);", 1)],
           name_filter="power\\.perActionEU",
           expect="D1 power.perActionEU: sin efecto observable en [energy]"),
    Mutant("K3", "power.generationEUs copiado (energyGeneration); la recarga real usa 5 EU/s fijos", VEHICLE,
           "const net = this.energyGeneration() - this.passiveDrain();", "const net = 5 - this.passiveDrain();",
           [GATE], name_filter="power\\.generationEUs",
           expect="D1 power.generationEUs: sin efecto observable en [energy]"),
    Mutant("K4", "ammo.rounds copiado al contador (que se descuenta) pero no_ammo no lo mira", COMBAT,
           'if (!ammo || ammo.ammo <= 0) return "no_ammo";', 'if (!ammo) return "no_ammo";', [GATE],
           name_filter="ammo\\.rounds",
           expect="D1 ammo.rounds: sin efecto observable en [projectiles]"),
    # ---- ronda 3 · defensa estructural: la SONDA vuelve a copiar; D0 debe ponerse rojo
    Mutant("P1", "la sonda registra el hp ABSOLUTO del casco (el canal hull de 577bd59)", PROBE,
           "  rec.transition(\"hull\", t, `${id}:alive`, v.alive);\n",
           "  rec.transition(\"hull\", t, `${id}:alive`, v.alive);\n  rec.ch.hull.push([t, id, r6(v.hullHp)]);\n",
           [GATE], name_filter="D0a",
           expect="D0a: el canal hull cambia al trasladar el casco de quien no muere"),
    Mutant("P2", "la sonda registra la energía ABSOLUTA almacenada", PROBE,
           "  if (withEnergy) rec.flow([\"energy\"], t, `${id}:energy`, v.energyEU, reset);\n",
           "  if (withEnergy) rec.ch.energy.push([t, id, r6(v.energyEU)]);\n",
           [GATE], name_filter="D0a",
           expect="D0a: el canal energy cambia al trasladar la capacidad"),
    Mutant("P3", "la sonda registra el hp ABSOLUTO de cada módulo", PROBE,
           "    rec.transition(\"modules\", t, `${id}:${m.spec.slot}:state`, v.stateOf(m.spec.slot));\n",
           "    rec.transition(\"modules\", t, `${id}:${m.spec.slot}:state`, v.stateOf(m.spec.slot));\n"
           "    rec.ch.modules.push([t, id, m.spec.slot, r6(m.hp)]);\n",
           [GATE], name_filter="D0a",
           expect="D0a: el canal modules cambia al escalar el hp de un módulo que nadie toca"),
    Mutant("P4", "la sonda vuelve a leer el REGISTRO de daño (effective/hull/moduleDamage) en el canal damage", PROBE,
           "  ch.score.push([t, frame.score]);\n",
           "  ch.score.push([t, frame.score]);\n  for (const d of battle.damageRecordsOfLastTick())\n"
           "    ch.damage.push([t, d.target, r6(d.effective), r6(d.hull), d.moduleSlot, r6(d.moduleDamage)]);\n",
           [GATE], name_filter="D0b",
           expect="D0b: el canal damage cambia al falsear el registro"),
    Mutant("P5", "el canal events vuelve a llevar el `damage` de hit_taken/hit_dealt (= effective del registro)", PROBE,
           "const EVENT_FIELDS = [\"tick\",", "const EVENT_FIELDS = [\"damage\", \"tick\",", [GATE],
           name_filter="D0b",
           expect="D0b: el canal events cambia al falsear el importe de los eventos"),
    Mutant("P6", "el flujo registra también la PRIMERA medida (el valor inicial, copia del spec)", PROBE,
           "    if (prev === undefined) return;\n",
           "    if (prev === undefined) {\n      for (const c of channels) this.ch[c].push([t, key, \"init\", r6(value)]);\n"
           "      return;\n    }\n",
           [GATE], name_filter="D0a",
           also=[("    for (const c of PROBE_CHANNELS) rec.ch[c].length = 0;\n", "", 1)],
           expect="D0a: los canales cambian al trasladar los valores iniciales"),
    # ---- ronda 4 · P2-1c: E1/E3 de la tercera revisión y sus controles E5/E6 (mismas sustituciones)
    Mutant("E1", "power.*: la energía no limita ninguna acción (sin no_energy); sólo contabilidad", COMBAT,
           '  if (v.energyEU < cost) return "no_energy";\n', "", [GATE],
           also=[('  if (v.energyEU < (m.spec.perActionEU ?? 0)) return "no_energy";\n', "", 1)],
           name_filter="power\\.",
           expect="D1 power.* «gobierna [projectiles, mines]» y D4 ENERGY_LIMIT; el «cambia [energy]» sigue verde"),
    Mutant("E3", "turretArcRad: arco sin efecto (stepTurret 2π, dispara igual); sólo el evento out_of_arc", VEHICLE,
           "const arc = this.turretArc();", "const arc = Math.PI * 2;", [GATE],
           others=[(BATTLE, REJECT, REJECT_BUT % "out_of_arc", 1)],
           name_filter="turretArcRad",
           expect="D1 turretArcRad «gobierna [turret, projectiles]» y D4 TURRET_ARC; el «cambia [events]» sigue verde"),
    Mutant("E5", "control: mine.charges se descuentan pero no limitan", COMBAT,
           '  if (m.charges <= 0) return "no_charges";\n', "", [GATE],
           name_filter="mine\\.charges",
           expect="D1 mine.charges (cambia [mines] y gobierna [mines]); muere también en fe138fe"),
    Mutant("E6", "control: el evento cooldown se emite pero se dispara igualmente", BATTLE,
           REJECT, REJECT_BUT % "cooldown", [GATE],
           name_filter="weapon\\.cooldownTicks",
           expect="D1 weapon.cooldownTicks (cambia/gobierna [projectiles]); muere también en fe138fe"),
    # ---- ronda 4 · Q: consumidor quitado, estado intacto (vivos en fe138fe)
    Mutant("Q1", "chassis.hullHp: el casco se descuenta (y se recorta a 0) pero nadie muere", DAMAGE,
           "const killed = target.hullHp <= 0 && target.alive;", "const killed = false;", [GATE],
           name_filter="chassis\\.hullHp",
           expect="D1 chassis.hullHp «gobierna [score]» y D4 HULL_DEATH; el «cambia [hull]» sigue verde"),
    Mutant("Q2", "armor.reduction: el blindaje se desgasta (absorbed) pero el casco recibe el importe entero", DAMAGE,
           "const hull = effective * profile.hullShare;", "const hull = amount * profile.hullShare;", [GATE],
           name_filter="armor\\.reduction",
           expect="D1 armor.reduction «gobierna [hull]» y D4 ARMOR_OFF; el «cambia [damage]» sigue verde"),
    Mutant("Q3", "weapon.hp: el estado del arma se calcula pero el arma destruida/crítica dispara, gira y daña igual",
           COMBAT,
           '  if (state === "destroyed" || state === "offline") return "module_destroyed";\n'
           '  if (!moduleActs(state, rng.next())) return "critical_failure";\n',
           "  rng.next();\n", [GATE],
           also=[("/ Math.max(0.25, v.performanceOf(slot)))", ")", 1),
                 ("* v.performanceOf(slot);", ";", 1)],
           others=[(VEHICLE, 'for (const w of this.activeModulesOf("weapon")) {\n      const mount = this.mountOf(w.spec.slot);',
                    'for (const w of this.modulesOf("weapon")) {\n      const mount = this.mountOf(w.spec.slot);', 1),
                   (VEHICLE, "rate = Math.max(rate, mount.turretRateRads * this.performanceOf(w.spec.slot));",
                    "rate = Math.max(rate, mount.turretRateRads);", 1)],
           name_filter="weapon\\.hp",
           expect="D1 weapon.hp «gobierna [projectiles, turret]» y D4 MODULE_STATE; el «cambia [modules]» sigue verde"),
    Mutant("Q4", "movement.hp: el estado del tren de rodaje se calcula pero el destruido sigue moviendo a plena prestación",
           VEHICLE, 'const drives = this.activeModulesOf("movement");', 'const drives = this.modulesOf("movement");',
           [GATE], also=[("const perf = this.performanceOf(d.spec.slot);", "const perf = 1;", 1)],
           name_filter="movement\\.hp",
           expect="D1 movement.hp «gobierna [kinematics]» y D4 MODULE_STATE; el «cambia [modules]» sigue verde"),
    Mutant("Q5", "sensor.hp: el estado del sensor se calcula pero el destruido sigue observando a pleno alcance", SENSORS,
           'for (const s of v.activeModulesOf("sensor")) {', 'for (const s of v.modulesOf("sensor")) {', [GATE],
           also=[("    if (!moduleActs(state, rng.next())) continue;\n", "    rng.next();\n", 1),
                 ("const perf = v.performanceOf(slot);", "const perf = 1;", 1)],
           name_filter="sensor\\.hp",
           expect="D1 sensor.hp «gobierna [sensors]» y D4 MODULE_STATE; el «cambia [modules]» sigue verde"),
    Mutant("Q6", "radio.hp: el estado de la radio se calcula pero la destruida sigue emitiendo a pleno alcance", SENSORS,
           'if (st === "destroyed" || st === "offline") return "no_radio";', "void st;", [GATE],
           also=[("return (r.spec.rangeM ?? 0) * sender.performanceOf(slot);", "return r.spec.rangeM ?? 0;", 1)],
           name_filter="radio\\.hp",
           expect="D1 radio.hp «gobierna [radio]» y D4 MODULE_STATE; el «cambia [modules]» sigue verde"),
    Mutant("Q7", "mine.hp: el estado de la bahía se calcula pero la destruida sigue sembrando", COMBAT,
           'if (st === "destroyed" || st === "offline") return "module_destroyed";', "void st;", [GATE],
           name_filter="mine\\.hp",
           expect="D1 mine.hp «gobierna [mines]» y D4 MODULE_STATE; el «cambia [modules]» sigue verde"),
    Mutant("F1", "power.*: sin no_energy; la falta de energía sólo consume una tirada extra del RNG combat", COMBAT,
           '  if (v.energyEU < cost) return "no_energy";\n', '  if (v.energyEU < cost) rng.next();\n', [GATE],
           also=[('  if (v.energyEU < (m.spec.perActionEU ?? 0)) return "no_energy";\n', "", 1)],
           name_filter="power\\.",
           expect="D1 power.* «gobierna [projectiles, mines]» (5 campos que en b96825e pasaban por el RNG) y D4"),
    Mutant("F2", "sensor.errorM: error fijo 2 m; errorM sólo decide cuántas tiradas del RNG se consumen", SENSORS,
           F2_OLD, F2_NEW, [GATE], name_filter="sensor\\.errorM",
           expect="D1 sensor.errorM «cambia/gobierna [sensors]» y D4 SENSOR_ERROR (vivo en b96825e)"),
    Mutant("F2R", "F2 contra el test de comportamiento del radar (fuera del gate)", SENSORS,
           F2_OLD, F2_NEW, [RADAR],
           expect="g1-radar-error: errorM = 0 no da la posición real; el error no escala con errorM"),
    Mutant("F3", "control: ammo.hp / utility.hp: los destruidos siguen absorbiendo daño de módulo", DAMAGE,
           '.filter((m) => m.hp > 0 && m.spec.category !== "armor")', '.filter((m) => m.spec.category !== "armor")',
           [GATE], name_filter="(ammo|utility)\\.hp",
           expect="D1 ammo.hp / utility.hp «gobierna [projectiles]» y D4 MODULE_SOAK (ya moría en b96825e)"),
    Mutant("F4", "ammo.rounds: la munición no limita; agotada, sólo consume una tirada extra del RNG combat", COMBAT,
           '  if (!ammo || ammo.ammo <= 0) return "no_ammo";\n',
           '  if (!ammo) return "no_ammo";\n  if (ammo.ammo <= 0) rng.next();\n', [GATE],
           name_filter="ammo\\.rounds",
           expect="D1 ammo.rounds «cambia/gobierna [projectiles]» y D4 AMMO_STOCK con el RNG neutro"),
    Mutant("F5", "sensor.errorM: el ruido del radar se anula con el MISMO consumo de tiradas (errorM se sigue informando)",
           SENSORS, F5_EX, F5_EX.replace("* err;", "* 0;"), [GATE],
           also=[(F5_EY, F5_EY.replace("* err;", "* 0;"), 1)], name_filter="sensor\\.errorM",
           expect="D1 sensor.errorM «cambia/gobierna [sensors]» y D4 SENSOR_ERROR"),
    Mutant("F5R", "F5 contra el test de comportamiento del radar (fuera del gate)", SENSORS,
           F5_EX, F5_EX.replace("* err;", "* 0;"), [RADAR],
           also=[(F5_EY, F5_EY.replace("* err;", "* 0;"), 1)],
           expect="g1-radar-error: con errorM > 0 la posición informada es la real"),
    Mutant("U1", "la sonda ignora el modo neutro: D1/D4 vuelven a evaluarse con el RNG del motor", PROBE,
           '  if (mode !== "neutral") return fn();\n', "  return fn();\n", [GATE], name_filter="D5",
           expect="D5: las tiradas extra sin usar cambian canales con el RNG «neutro»"),
    Mutant("U2", "la tirada neutra avanza con cada consumo (vuelve a depender del número de tiradas)", PROBE,
           "return neutralUint32(NEUTRAL_CLOCK.tick);", "return neutralUint32(NEUTRAL_CLOCK.tick++);", [GATE],
           name_filter="D5",
           expect="D5: las tiradas extra sin usar cambian canales con el RNG neutro"),
    Mutant("RH1", "power.*: sin no_energy; la falta de energía sólo gasta un id de entidad (entitySeq)", COMBAT,
           '  if (v.energyEU < cost) return "no_energy";\n', "", [GATE],
           also=[('  if (v.energyEU < (m.spec.perActionEU ?? 0)) return "no_energy";\n', "", 1)],
           others=[(BATTLE, FIRE_SEQ,
                    "if (v.energyEU < (v.modules.get(slot)?.spec.perActionEU ?? 0)) this.entitySeq++;\n        "
                    + FIRE_SEQ, 1),
                   (BATTLE, MINE_REJ, MINE_REJ + MINE_SPEND, 1)],
           name_filter="power\\.",
           expect="D1 power.* «gobierna [projectiles, mines]» y D4 ENERGY_LIMIT (vivo en 28f9b06: 52/52)"),
    Mutant("I1", "mine.power.perActionEU: la mina siembra sin energía; si falta, sólo gasta un id de entidad", COMBAT,
           '  if (v.energyEU < (m.spec.perActionEU ?? 0)) return "no_energy";\n', "", [GATE],
           others=[(BATTLE, MINE_REJ, MINE_REJ + MINE_SPEND, 1)],
           name_filter="mine\\.power\\.perActionEU",
           expect="D1 mine.power.perActionEU «gobierna [projectiles, mines]» y D4 ENERGY_LIMIT"),
    Mutant("W1", "la sonda vuelve a registrar el id crudo de cada proyectil", PROBE,
           '[labels.of("p", p.id, p.ownerId), p.position.x', "[p.id, p.position.x", [GATE], name_filter="D6",
           expect="D6: gastar ids de entidad cambia el canal projectiles"),
    Mutant("W2", "la sonda vuelve a registrar el id crudo de cada mina", PROBE,
           '[labels.of("m", m.id, m.ownerId), r6(m.position.x)', "[m.id, r6(m.position.x)", [GATE], name_filter="D6",
           expect="D6: gastar ids de entidad cambia el canal mines"),
]

if __name__ == "__main__":
    run("g1", MUTANTS, sys.argv)
