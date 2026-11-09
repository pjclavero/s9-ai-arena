# VISUAL_COMPONENT_INVENTORY — Inventario de componentes con posible representación visual

**Proyecto:** visuales componibles de bots ([MASTER-PLAN](MASTER-PLAN.md)) · **Fase:** FASE 0 (descubrimiento y contrato visual)
**Estado:** borrador del AUTHOR, pendiente de revisión independiente.
**Base de la rama:** `mejoras-visuales` @ `983d2f5` (2026-11-09).

Este documento lista **todo** lo que existe hoy en S9 AI Arena y podría tener representación visual. Todo sale del
repositorio; cuando un dato no existe en el código, se dice («NO EXISTE EN EL REPO») en vez de inventarlo.

## 1. Fuentes (código real)

| Qué | Dónde |
| --- | --- |
| Catálogo de módulos (31 definiciones) | `packages/module-catalog/data/*.json`, cargado con `loadCatalog()` (`packages/module-catalog/loadCatalog.ts`) |
| Forma del catálogo y categorías | `packages/module-catalog/schema/module.schema.json`, `packages/module-catalog/types.ts` |
| Efecto real de cada propiedad en la batalla | `packages/module-catalog/effect-status.ts` (ACTIVE / PARTIAL / FUTURE) |
| Estado de vehículo y módulos en batalla | `apps/arena-engine/src/sim/vehicle.ts` |
| Daño, disparo, munición, minas | `apps/arena-engine/src/sim/combat.ts`, `apps/arena-engine/src/sim/battle.ts` |
| Sensores, observación, radio | `apps/arena-engine/src/sim/sensors.ts` |
| Estados de módulo y umbrales | `packages/game-rules/constants.ts` (`MODULE_STATES`, `MODULE_STATE_THRESHOLDS`), `packages/game-rules/index.ts` (`stateFromHealth`) |
| Snapshot público (espectador, replay, broadcast) | `Battle.publicSnapshot()` en `apps/arena-engine/src/sim/battle.ts` |
| Replay (cabecera con `participants[].spec`) | `apps/arena-engine/src/replay.ts`; nómina del visor en `apps/api/src/routes/replays.ts` |
| Nómina en directo (`init.meta.roster`) | `apps/tournament-worker/src/engine-executor.ts` |
| Visor actual (Phaser, atlas procedural) | `apps/web/src/viewer/*` (`atlas-geometry.ts`, `art-direction.ts`, `damage-visuals.ts`, `effects.ts`, `PhaserViewer.ts`) |
| Broadcast | `apps/web/src/pages/BroadcastPage.tsx` (reutiliza el visor) y `apps/streamer/src/ffmpeg.ts` (Chromium 1920×1080 capturado) |
| Ficha y editor de bot | `apps/web/src/pages/BotDetailPage.tsx`, `apps/web/src/pages/LoadoutEditor.tsx` (hoy sin ninguna representación gráfica del bot) |
| Nombres de ranuras y categorías | `apps/web/src/help/names.ts` |

## 2. Leyenda de campos

- **DOMAIN_ID**: id versionado del catálogo (`id@version`, inmutable según `module.schema.json`). Los elementos que no son
  módulos del catálogo (proyectil, mina desplegada, bandera…) usan el prefijo `runtime.`.
- **CATEGORY**: categoría real del catálogo (`chassis`, `movement`, `power`, `sensor`, `weapon`, `ammo`, `mine`, `armor`,
  `radio`, `utility`) o `runtime`.
- **SIZE**: `size` del catálogo (S/M/L/XL). Los chasis no lo declaran (lo dice el propio schema).
- **MASS**: `massKg` del catálogo, en kg.
- **CURRENT_GAME_EFFECT**: lo que el motor hace HOY con ese componente (según `effect-status.ts` y el código de `sim/`).
- **VISUAL_RELEVANCE**: `HIGH` / `MEDIUM` / `LOW` / `NONE`. **`NONE` = marcado explícitamente como no visual** sobre el vehículo.
- **PROPOSED_VISUAL_KIND**: tipo de representación propuesta (no es un asset; sólo intención).
- **VISIBLE_EXTERNALLY**: `YES` / `NO` / `MAYBE` — si un observador podría verlo físicamente en el vehículo.
- **DYNAMIC_STATE**: `YES` si su aspecto puede cambiar durante la batalla con datos que existen hoy.
- **HISTORICAL_SNAPSHOT_REQUIRED**: `YES` si un replay debe resolver el aspecto con el equipamiento de esa batalla y no con el actual.

## 3. Componentes del catálogo

| DOMAIN_ID | NAME | CATEGORY | SIZE | MASS | FUNCTION | CURRENT_GAME_EFFECT | VISUAL_RELEVANCE | PROPOSED_VISUAL_KIND | VISIBLE_EXTERNALLY | DYNAMIC_STATE | HISTORICAL_SNAPSHOT_REQUIRED | NOTES |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `chassis.light@1` | Chasis ligero | chassis | N/A (los chasis no declaran size) | 700 | Casco base; 10 ranuras | hullHp 180, radiusM 1.2 (círculo de colisión), maxLoadKg 1200 (sólo validación) | HIGH | silueta de casco «scout» + mounts | YES | YES | YES | Sin `mine_bay` ni `sensor_b`. Con el catálogo de hoy no admite **ningún blindaje** ni las orugas ni el cañón (no caben por tamaño; matriz §9.1 y §12.1): un ligero nunca muestra placas ni orugas. Visor actual: frame `body-scout` 2.6×1.8 m (atlas-geometry.ts). |
| `chassis.light@2` | Chasis ligero (v2, balance) | chassis | N/A (los chasis no declaran size) | 700 | Igual que @1 con más casco | hullHp 280, radiusM 1.2 | HIGH | misma silueta que @1 | YES | YES | YES | Mismas ranuras que @1: la versión cambia el balance, no la forma. Tampoco admite blindaje ni orugas. |
| `chassis.medium@1` | Chasis medio | chassis | N/A (los chasis no declaran size) | 1400 | Casco polivalente; 11 ranuras | hullHp 300, radiusM 1.6 | HIGH | silueta de casco «gunner» + mounts | YES | YES | YES | Tiene `mine_bay` (mina o utility). Visor actual: `body-gunner` 3.2×2.2 m. |
| `chassis.medium@2` | Chasis medio (v2, balance) | chassis | N/A (los chasis no declaran size) | 1400 | Igual que @1 con más casco | hullHp 350, radiusM 1.6 | HIGH | misma silueta que @1 | YES | YES | YES | Mismas ranuras que @1. |
| `chassis.heavy@1` | Chasis pesado | chassis | N/A (los chasis no declaran size) | 2600 | Casco de asedio; 12 ranuras | hullHp 480, radiusM 2 | HIGH | silueta de casco «heavy» + mounts | YES | YES | YES | Único con `sensor_b` (S). Visor actual: `body-heavy` 3.8×2.8 m. |
| `weapon.cannon@1` | Cañón de 60 mm | weapon | L | 380 | Arma de torreta, daño alto | damage 45, cooldownTicks 30, projectileSpeedMs 120, spread 0.01, turretRateRads 1; acepta ammo.ap/ammo.he. `rangeM` y `turretArcRad` son FUTURE | HIGH | torreta + cañón largo | YES | YES | YES | size L: no cabe en el chasis ligero (turret_main M). maxPerVehicle 1. |
| `weapon.mg@1` | Ametralladora | weapon | M | 120 | Arma de torreta, cadencia alta | damage 12, cooldownTicks 6, projectileSpeedMs 200, spread 0.05, turretRateRads 2.2; acepta ammo.standard | HIGH | torreta + cañón corto/fino | YES | YES | YES | `turretArcRad` 2π (FUTURE). Única arma que cabe en el ligero: allí su presencia la identifica (matriz §12.1). |
| `weapon.mg@2` | Ametralladora (v2, balance) | weapon | M | 120 | Igual que @1 rebalanceada | damage 18, cooldownTicks 5, perActionEU 2.5 | HIGH | misma forma que @1 | YES | YES | YES | La versión cambia el balance, no la forma. |
| `armor.steel_front@1` | Blindaje de acero frontal | armor | L | 420 | Reduce daño del sector frontal | reduction 0.35 mientras su HP de sector > 0 | MEDIUM | placa frontal, acabado «acero» | YES | NO | YES | DYNAMIC_STATE NO: el HP de sector existe pero NO es público y el `state` público del módulo no cambia con el daño (ver §6, H-01). |
| `armor.steel_left@1` | Blindaje de acero lateral izquierdo | armor | M | 280 | Reduce daño del sector izquierdo | reduction 0.25 | MEDIUM | placa lateral (izquierda) | YES | NO | YES | Simétrico de steel_right (mirror). |
| `armor.steel_right@1` | Blindaje de acero lateral derecho | armor | M | 280 | Reduce daño del sector derecho | reduction 0.25 | MEDIUM | placa lateral (derecha) | YES | NO | YES | Simétrico de steel_left. |
| `armor.steel_rear@1` | Blindaje de acero trasero | armor | M | 260 | Reduce daño del sector trasero | reduction 0.2 | MEDIUM | placa trasera | YES | NO | YES | |
| `armor.composite_front@1` | Blindaje compuesto frontal | armor | L | 220 | Reduce daño del sector frontal | reduction 0.28 | MEDIUM | placa frontal, acabado «compuesto» | YES | NO | YES | Material distinto del acero: el acabado es lo único que los diferencia a simple vista. |
| `armor.composite_left@1` | Blindaje compuesto lateral izquierdo | armor | M | 150 | Reduce daño del sector izquierdo | reduction 0.2 | MEDIUM | placa lateral compuesta (izquierda) | YES | NO | YES | |
| `armor.composite_right@1` | Blindaje compuesto lateral derecho | armor | M | 150 | Reduce daño del sector derecho | reduction 0.2 | MEDIUM | placa lateral compuesta (derecha) | YES | NO | YES | |
| `armor.composite_rear@1` | Blindaje compuesto trasero | armor | M | 140 | Reduce daño del sector trasero | reduction 0.16 | MEDIUM | placa trasera compuesta | YES | NO | YES | |
| `movement.tracks@1` | Orugas | movement | L | 400 | Propulsión | maxSpeedMs 9, accel 6, turnRate 1.2, ratedLoadKg 2600; `terrain` FUTURE | MEDIUM | par de orugas laterales | YES | YES | YES | Estado público del módulo `drive` (dañado/destruido) ya existe. |
| `movement.wheels@1` | Ruedas todoterreno | movement | M | 200 | Propulsión | maxSpeedMs 13, accel 9, turnRate 1.8, ratedLoadKg 1600; `terrain` FUTURE | MEDIUM | ruedas laterales | YES | YES | YES | Única tracción que cabe en el ligero: allí su presencia la identifica (matriz §12.1). |
| `sensor.proximity@1` | Detector de proximidad | sensor | S | 20 | Dirección de vehículos y minas detectables a ≤15 m | rangeM 15, sin fov (omnidireccional); único sensor que revela minas | LOW | anillo/banda de emisores pequeños | MAYBE | YES | YES | Ver contrato de sensores en la matriz. |
| `sensor.lidar_front@1` | Lidar frontal | sensor | S | 35 | Rayos en cono frontal | rangeM 45, fovRad 1.5708, rays 16; orientado al RUMBO DEL CASCO (sensors.ts) | MEDIUM | caja con lente al frente del casco | YES | YES | YES | |
| `sensor.lidar360@1` | Lidar 360 | sensor | M | 60 | Rayos en 360° | rangeM 40, fovRad 6.2832, rays 48, maxPerVehicle 1 | MEDIUM | cúpula/cilindro superior | YES | YES | YES | |
| `sensor.radar@1` | Radar básico | sensor | M | 50 | Contactos con error de posición | rangeM 50, errorM 2, sin fov (omnidireccional con línea de visión) | MEDIUM | antena/plato sobre mástil | YES | YES | YES | |
| `sensor.acoustic@1` | Escucha acústica | sensor | S | 15 | Sólo dirección de sonidos (disparo, motor, explosión) | rangeM 60, pasivo, sin fov | LOW | par de micrófonos pequeños | MAYBE | YES | YES | Pasivo: no debe tener animación de «escucha» (ver matriz §7). |
| `radio.short@1` | Radio corta | radio | S | 20 | Mensajes de equipo (32 B, 2/s) | maxMessageBytes/maxMessagesPerSecond ACTIVE; `rangeM` 80 FUTURE (`radioReaches` no se llama) | MEDIUM | antena de látigo | YES | YES | YES | Única radio del catálogo: si la ranura `radio_a` aparece en el snapshot, se sabe cuál es (PUBLIC por inferencia, matriz §12.1). Que transmita NO es público (sin evento). |
| `power.battery@1` | Batería | power | M | 150 | Almacén de energía | capacityEU 500, generationEUs 8 | NONE | sin representación en el vehículo (interno) | NO | NO | YES | Sólo texto/icono en ficha. Estado energético = SELF_ONLY. |
| `power.generator@1` | Generador básico | power | M | 130 | Generación de energía | capacityEU 150, generationEUs 22 | NONE | sin representación en el vehículo (interno) | NO | NO | YES | |
| `power.generator@2` | Generador básico (v2, balance) | power | M | 130 | Generación de energía | capacityEU 150, generationEUs 30 | NONE | sin representación en el vehículo (interno) | NO | NO | YES | |
| `ammo.standard@1` | Munición estándar | ammo | S | 50 | Munición de ametralladora | rounds 300, damageMultiplier 1, sin explosión | LOW | ninguna en el casco; posible variante de proyectil en el futuro | NO | NO | YES | En el loadout canónico es propiedad del arma (`entry.ammo`) y `resolveVehicle` la materializa en `ammo_main`. Munición restante = SELF_ONLY. En el ligero el tipo se infiere (única munición de la única arma que cabe; matriz §12.1). |
| `ammo.ap@1` | Munición perforante | ammo | M | 80 | Munición de cañón | rounds 40, damageMultiplier 1.2, sin explosión | LOW | ninguna en el casco; posible variante de proyectil | NO | NO | YES | |
| `ammo.he@1` | Munición explosiva | ammo | M | 90 | Munición de cañón | rounds 30, damageMultiplier 0.9, explosionRadiusM 5 | LOW | ninguna en el casco; posible variante de proyectil/impacto | NO | NO | YES | La explosión de impacto HE NO genera evento público hoy (sólo sonido interno). |
| `mine.explosive@1` | Mina explosiva | mine | M | 120 | Despliega minas (3 cargas) | charges 3, damage 90, triggerRadiusM 2.5, explosionRadiusM 6, armDelayTicks 30, cooldownTicks 90, lifetimeTicks 5400 | LOW | compuerta de bahía trasera (cerrada) | MAYBE | NO | YES | Cargas restantes = SELF_ONLY. Que la bahía lleva minas es PUBLIC por inferencia: es el único módulo que admite `mine_bay` (matriz §12.1, H-04). La mina desplegada es `runtime.mine_deployed`. |

## 4. Elementos de batalla que no son módulos (runtime)

| DOMAIN_ID | NAME | CATEGORY | SIZE | MASS | FUNCTION | CURRENT_GAME_EFFECT | VISUAL_RELEVANCE | PROPOSED_VISUAL_KIND | VISIBLE_EXTERNALLY | DYNAMIC_STATE | HISTORICAL_SNAPSHOT_REQUIRED | NOTES |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `runtime.turret` | Torreta | runtime | N/A (no es módulo) | N/A (no es módulo) | Soporte giratorio del arma | `Vehicle.turretHeading` (UNA por vehículo); gira a `turretRateRads` del mejor arma operativa | HIGH | base de torreta por arquetipo + arma | YES | YES | YES | Hoy: frames `turret-scout/gunner/heavy` + `barrel` en el atlas. |
| `runtime.projectile` | Proyectil | runtime | N/A (no es módulo) | N/A (no es módulo) | Disparo en vuelo | TTL 90 ticks (combat.ts); en el snapshot público sólo `id` y `position` | HIGH | punto/trazadora | YES | YES | NO | El snapshot NO dice qué arma ni qué munición lo disparó. |
| `runtime.muzzle_flash` | Fogonazo | runtime | N/A (no es módulo) | N/A (no es módulo) | Efecto de disparo | No existe en el motor: el visor lo deduce de un proyectil nuevo (effects.ts) | MEDIUM | destello en la boca | YES | YES | NO | Boca = `radiusM + 0.3` m a lo largo de `turretHeading` (battle.ts). |
| `runtime.mine_deployed` | Mina desplegada | runtime | N/A (no es módulo) | N/A (no es módulo) | Mina en el suelo | Se arma tras armDelay; explota por radio; NO va en el snapshot público | LOW | marcador de mina | NO | YES | NO | Sólo el dueño recibe `mine_deployed` (evento privado). |
| `runtime.explosion` | Explosión | runtime | N/A (no es módulo) | N/A (no es módulo) | Destrucción o mina | Eventos públicos `vehicle_destroyed` y `mine_triggered` | MEDIUM | secuencia explosion-0/1/2 | YES | YES | NO | Ya existe en el visor (art-direction.ts, effects.ts). |
| `runtime.smoke` | Humo de casco | runtime | N/A (no es módulo) | N/A (no es módulo) | Indicador de daño | Derivado de `hullHp/hullHpMax` público (damage-visuals.ts, humo bajo 60 %) | MEDIUM | partículas de humo | YES | YES | NO | |
| `runtime.wreck` | Vehículo destruido | runtime | N/A (no es módulo) | N/A (no es módulo) | Vehículo sin casco | `alive=false` en el snapshot; respawn según ruleset | HIGH | casco atenuado/quemado | YES | YES | YES | Hoy: alfa 0.25 (PhaserViewer.ts). |
| `runtime.flag` | Bandera | runtime | N/A (no es módulo) | N/A (no es módulo) | Objetivo CTF | `carryingFlag` público + eventos `flag_*` | HIGH | bandera / bandera portada | YES | YES | NO | Ya existe frame `flag`. |
| `runtime.juggernaut_marker` | Marca de juggernaut | runtime | N/A (no es módulo) | N/A (no es módulo) | Objetivo del modo juggernaut | `juggernaut` público en el snapshot | MEDIUM | marcador sobre el vehículo | YES | YES | NO | |
| `runtime.team_color` | Color de equipo | runtime | N/A (no es módulo) | N/A (no es módulo) | Identidad de bando | `resolveTeamColors` (packages/game-rules/art-direction.ts), determinista | HIGH | tinte/paleta | YES | NO | YES | Depende del CONJUNTO de equipos presentes: el replay debe resolverlo con los equipos de esa batalla. |
| `runtime.bot_label` | Nombre del bot | runtime | N/A (no es módulo) | N/A (no es módulo) | Identificación | Nómina (`roster.name`); el replay lo resuelve con la tabla `bots` ACTUAL | MEDIUM | etiqueta de texto | YES | NO | YES | Hoy el nombre de un replay viejo cambia si se renombra el bot (ver ADR-VIS-002). |

## 5. Lo que NO existe en el repo (no se inventa)

- **Categoría `utility`**: existe en el schema y en `types.ts` (`effect: smoke | repair | jammer | drone`) pero **no hay ningún
  módulo** `utility.*` en `data/`. Todas sus propiedades son FUTURE en `effect-status.ts`. No hay filas que inventariar.
- **Arma secundaria**: ningún chasis ofrece `turret_secondary` ni `ammo_secondary`; sólo aparecen como nombres en
  `apps/web/src/help/names.ts`. Hoy cada vehículo monta como mucho UN arma.
- **Accesorios / módulos especiales**: no existen como categoría ni como módulo.
- **Coordenadas de montaje**: el schema admite `slots[].offsetM`, pero **ningún** chasis lo declara.
- **Tamaño físico de los módulos**: no existe; `size` (S/M/L/XL) es volumen de ranura (sólo validación, PARTIAL).
- **Dimensiones del casco**: el motor sólo conoce `radiusM` (colisión circular, `physics.ts`); las medidas 2.6×1.8 / 3.2×2.2 /
  3.8×2.8 m son decisiones del atlas del visor, no del motor.
- **Licencia/origen de assets**: no hay assets de imagen; el visor dibuja todo con Canvas 2D en tiempo de ejecución.

## 6. Hallazgos que afectan a la representación

- **H-01 · El blindaje no «se rompe» en público.** `applyDamage` descuenta del HP de sector (`v.armor[sector].hp`) y excluye
  los módulos de blindaje del sorteo de daño a módulos, así que el `state` público de un `armor_*` sólo puede ser
  `operational` u `offline`. El indicador `armorBroken` del HUD (`damage-visuals.ts`) depende de ese estado y, por daño,
  no se activa nunca. Además, apagar un blindaje (`offline`) no le quita la protección en `applyDamage`. Es un hecho del
  motor que esta fase **sólo documenta**.
- **H-02 · La nómina en directo sólo trae el chasis.** `init.meta.roster` = `{id, botId, team, chassis, name}`; el snapshot
  público lleva `modules: [{slot, state}]` sin `moduleId`. Para pintar arma/sensores en directo haría falta publicar
  identidades de módulo (decisión de producto, ver matriz §12/§14).
- **H-03 · El replay sí guarda el equipamiento.** La cabecera del replay lleva `participants[].spec` (con
  `chassisId` y `modules[].moduleId` versionados): el aspecto histórico es reconstruible sin consultar el loadout actual.
- **H-04 · Las ranuras ocupadas son públicas, y a veces dicen qué módulo hay.** El snapshot público lista sólo las
  ranuras **con módulo** (`modules: [{slot, state}]`), y la nómina publica el chasis. Cruzado con el catálogo y con las
  reglas del validador, eso revela no sólo que una ranura va ocupada, sino **qué módulo** lleva cuando sólo hay un
  candidato: la mina (`mine_bay`, porque `utility` no tiene módulos), la radio (`radio_a`) y, en el ligero, la tracción
  (`drive`: ruedas), el arma (`turret_main`: ametralladora) y su munición. La presencia de munición y de energía es
  siempre pública. La tabla de encaje la calcula un test sobre el catálogo real (matriz §12.1); la decisión sobre esta
  fuga ya existente es D-07 (matriz §14). Esta fase no toca el motor.
- **H-05 · El fichero de replay crudo lleva más que el equipamiento.** Ver matriz §14: semilla, comandos (con el
  contenido de la radio y el despliegue de minas) y re-simulación; las clases de fog of war valen para las vistas
  renderizadas, no para ese fichero (PRE-1, gestionado aparte).
