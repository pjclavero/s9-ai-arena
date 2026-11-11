# S9 AI Arena — Roadmap de hardening del motor y catálogo modular v2

## Objetivo

Dejar el motor preparado para la versión definitiva con:

```text
ENGINE_HARDENING=PASS
PUBLIC_PROJECTION_BOUNDARY=PASS
MODULE_CATALOG_V2=PASS
GENERIC_EFFECTS=PASS
GENERIC_DEPLOYABLES=PASS
READY_FOR_NEW_MODULES=YES
```

Todo lo existente hasta la versión definitiva se considera **pre-release**. No se exige compatibilidad hacia atrás con batallas, replays, IDs históricos, fixtures incompatibles ni formatos internos anteriores. Si una mejora de seguridad, arquitectura o mantenibilidad requiere un breaking change, se permite y se regeneran los datos de juego afectados.

## Regla de arquitectura

La separación objetivo es:

```text
SIMULATION STATE
        ↓
INTERNAL EXACT STATE
        ↓
PROJECTION LAYER
        ↓
VIEWER-SPECIFIC SANITIZED STATE
        ↓
battle UI / spectator / replay / broadcast
```

La simulación no debe exponer estado sensible directamente. La proyección debe depender de viewer, entidad observada, relación, política de visibilidad, estado de visibilidad y epoch/version de esa visibilidad.

La regla de extensibilidad será:

```text
NUEVA VARIANTE DE MECÁNICA EXISTENTE
= CATÁLOGO + TESTS

NUEVA MECÁNICA REAL
= UNA PRIMITIVA NUEVA DEL MOTOR

NUEVAS VARIANTES DE ESA PRIMITIVA
= CATÁLOGO + TESTS
```

El motor no debe conocer nombres concretos como “EMP Mine”, “Heavy Cannon” o “Smoke Launcher”; debe conocer conceptos genéricos como Projectile, Deployable, Trigger, Effect, Interference, Damage, Penetration, Sensor y Guidance.

---

## FASE 0 — Cerrar la tanda actual

Antes de esta reforma, cerrar y estabilizar:

- #257 UX
- #259 PRE-1 replay security
- #260 streaming blanco
- #253 FASE 0 visual

Gate:

```text
P0=0
P1=0
P2=0
CURRENT_RELEASE_CANDIDATE=STABLE
```

No mezclar el hardening del motor dentro de esos PR.

---

## FASE 1 — Capturar el contrato actual

Documentar y cubrir con tests de caracterización:

- SimulationState
- VehicleSpec
- ModuleSpec
- Projectile
- Mine
- sensores
- replay
- proyección pública

Gate:

```text
ENGINE_BASELINE_CAPTURED=PASS
```

---

## FASE 2 — Frontera interna/pública y aislamiento CROSS_VIEW

Consolidar la capa viewer-aware para que no pueda reutilizar proyecciones incompatibles entre:

- pre/post reveal
- viewer A / viewer B
- owner / anonymous
- team / outsider
- spectator / broadcast
- replay público / raw

La caché de proyección debe depender también del estado/version/epoch de visibilidad.

Gate:

```text
PUBLIC_PROJECTION_BOUNDARY=PASS
CROSS_VIEW_ISOLATION=PASS
```

---

## FASE 3 — #261 IDs y entidades ocultas

Separar explícitamente:

```text
INTERNAL_ENTITY_ID
PUBLIC_PROJECTED_ID
```

Evitar inferencias por secuencias, huecos, orden de creación o reutilización de mappings entre viewers.

Revisar como mínimo:

- vehículos
- proyectiles
- minas
- futuros deployables
- contactos de sensores
- replay
- spectator/broadcast

Mutantes mínimos:

- publicId = internalId
- reutilizar secuencia interna oculta
- exponer huecos por creación de entidades ocultas
- compartir mapping entre viewers incompatibles

Gate:

```text
#261=PASS
ENTITY_ID_ISOLATION=PASS
```

---

## FASE 4 — #263 daño y blindaje

Mantener internamente el cálculo exacto de daño/armadura, pero proyectar sólo lo permitido.

Separar:

```text
INTERNAL_DAMAGE_STATE
PUBLIC_DAMAGE_STATE
```

Preparar el modelo para futuras primitivas genéricas:

- penetration
- damageType
- armorInteraction

Sin necesidad de crear todavía nuevas municiones reales.

Gate:

```text
#263=PASS
ARMOR_INFORMATION_ISOLATION=PASS
```

---

## FASE 5 — #262 cinemática de torreta

Separar simulación física exacta de representación pública observable.

La simulación puede seguir usando turretRateRads/turretArcRad, pero la proyección no debe permitir identificar equipamiento privado por parámetros exactos si esa información no debe ser pública.

Gate:

```text
#262=PASS
TURRET_INFORMATION_ISOLATION=PASS
```

---

## FASE 6 — Eliminar hardcodes y auditar campos del catálogo

Revisar especialmente valores conocidos como:

- Projectile.ttlTicks = 90
- Mine.detectable = true

Y clasificar cada propiedad actual como:

```text
ACTIVE
VALIDATION_ONLY
FUTURE
REMOVE
```

Revisar además:

- weapon.rangeM
- weapon.turretArcRad
- radio.rangeM
- radio.encrypted
- movement.terrain
- power.peakEUs
- sensor.refreshEveryNDecisions
- utility.effect / magnitude / durationTicks

No dejar campos que parezcan funcionales pero sean ignorados silenciosamente.

Gate:

```text
CATALOG_FIELDS_AUDITED=PASS
NO_SILENT_FAKE_FIELDS=PASS
```

---

## FASE 7 — Module Catalog v2

Mantener el principio:

```text
MODULE = DATA
```

`resolveVehicle()` debe seguir siendo la frontera principal entre catálogo y simulación.

El catálogo debe poder expresar:

- identidad/version
- categoría
- masa/coste/tamaño
- hp
- energía
- cooldown
- cargas
- requisitos de montaje
- compatibilidades
- efectos
- metadatos de visibilidad
- metadatos visuales

Mantener como base las categorías existentes: chassis, movement, power, sensor, weapon, ammo, mine, armor, radio, utility.

Gate:

```text
MODULE_CATALOG_V2=PASS
```

---

## FASE 8 — Sistema genérico de efectos

Evitar clases/lógica específica por cada futuro módulo.

Crear una infraestructura `Effect` componible con conceptos como:

- type
- strength
- radius
- duration
- falloff
- targets
- channels
- stacking

Primitivas previstas:

- damage
- explosion
- penetration
- interference
- repair
- statusModifier
- sensorModifier
- communicationModifier

Una acción puede aplicar varios efectos.

Gate:

```text
GENERIC_EFFECTS=PASS
```

---

## FASE 9 — Interference / obscuration unificada

No implementar humo y jamming como motores separados.

Crear una primitiva común de interferencia capaz de afectar canales distintos:

- lidar
- optical (futuro)
- radar
- radio
- acoustic
- futuros sensores

Ejemplos de catálogo futuros:

```text
smoke.normal
  lidar: strong
  optical: strong
  radar: none
  radio: none

jammer.radio
  radio: strong
  radar: medium
  lidar: none
```

Gate:

```text
INTERFERENCE_SYSTEM=PASS
```

---

## FASE 10 — Deployables genéricos

Generalizar la mina actual a una infraestructura:

```text
DEPLOYABLE
  deployment
  trigger
  payload/effects
  lifetime
  visibility
  ownership
```

Triggers previstos:

- proximity
- contact
- timer
- remote
- event

No hace falta usar todos inmediatamente.

Esto debe permitir más adelante crear mediante catálogo:

- mina explosiva
- mina EMP
- sensor beacon
- emisor de interferencia
- humo
- jammer beacon
- decoy

Gate:

```text
GENERIC_DEPLOYABLES=PASS
```

---

## FASE 11 — Guidance genérico

Preparar Projectile para guidance sin crear todavía misiles productivos.

Modelo mínimo:

```text
guidance:
  none
  target
  waypoint
```

Parámetros genéricos posibles:

- turnRate
- acquisitionRange
- lockRequirements
- trackingError

Gate:

```text
PROJECTILE_GUIDANCE_READY=PASS
```

---

## FASE 12 — Penetración y tipos de daño

Preparar una capa extensible que separe:

```text
damage
penetration
armor
effects
```

Tipos futuros posibles:

- kinetic
- explosive
- thermal
- electronic

Evitar una simulación balística innecesariamente compleja. Priorizar determinismo, balance, claridad y testabilidad.

Gate:

```text
DAMAGE_MODEL_EXTENSIBLE=PASS
```

---

## FASE 13 — Sensores extensibles

Mantener los tipos actuales:

- lidar
- radar
- proximity
- acoustic

Asegurar que añadir un nuevo tipo requiera implementar su primitiva una sola vez; las variantes posteriores de alcance, error, rayos, consumo, etc. deben ser catálogo.

Gate:

```text
SENSOR_EXTENSION_MODEL=PASS
```

---

## FASE 14 — Utility funcional

Convertir `utility` en consumidor del sistema genérico de acciones/efectos, en lugar de una colección de casos hardcodeados.

Debe poder soportar después, por datos:

- repair kit
- interference emitter
- sensor beacon
- drone deployer
- otras utilidades compatibles con primitivas ya existentes

Gate:

```text
UTILITY_INFRASTRUCTURE=PASS
```

---

## FASE 15 — Replay y determinismo

Toda mecánica nueva debe preservar replay determinista.

Registrar o reconstruir de forma determinista:

- comandos
- transiciones de estado
- creación/destrucción de deployables
- creación/destrucción de efectos
- zonas de interferencia
- guidance
- RNG relevante

Resultado:

```text
same seed
+ same commands
+ same catalog
+ same engine version
= same result
```

No es obligatorio reproducir replays pre-release antiguos.

Gate:

```text
NEW_REPLAY_FORMAT=PASS
DETERMINISM=PASS
```

---

## FASE 16 — Limpieza de datos pre-release

Cuando el nuevo contrato esté listo, identificar datos incompatibles y eliminar únicamente lo necesario:

- batallas antiguas
- replays antiguos
- fixtures generados incompatibles
- datos de simulación obsoletos

Preservar cuando corresponda:

- usuarios
- cuentas
- permisos
- configuración
- secretos
- código de bots
- datos administrativos útiles

Gate:

```text
PRE_RELEASE_DATA_CLEANUP=PASS
```

---

## FASE 17 — Regresión completa

Crear datos nuevos y probar:

- loadout validation
- vehicle resolution
- batalla
- armas
- munición
- minas/deployables
- sensores
- radio
- armadura
- energía
- daño
- replay
- spectator
- public projection
- broadcast
- torneo
- respawn
- determinismo

Ejecutar también mutantes de seguridad, privacidad y extensibilidad.

Gate:

```text
ENGINE_REGRESSION=PASS
MODULE_REGRESSION=PASS
REPLAY_REGRESSION=PASS
SPECTATOR_REGRESSION=PASS
BROADCAST_REGRESSION=PASS
P0=0
P1=0
P2=0
```

---

## FASE 18 — Revisión independiente

Un revisor distinto debe intentar desde cero:

- filtrar información privada
- romper determinismo
- crear combinaciones inválidas
- forzar CROSS_VIEW
- reutilizar IDs internos
- saltarse catálogo/validator
- encontrar lógica específica de módulos concretos

Gate:

```text
INDEPENDENT_REVIEW=PASS
```

---

## FASE 19 — Declarar motor preparado

Estado esperado:

```text
#261=PASS
#262=PASS
#263=PASS

ENGINE_INFORMATION_ISOLATION=PASS
PUBLIC_PROJECTION_BOUNDARY=PASS
MODULE_CATALOG_V2=PASS

GENERIC_EFFECTS=PASS
INTERFERENCE_SYSTEM=PASS
GENERIC_DEPLOYABLES=PASS

PROJECTILE_GUIDANCE_READY=PASS
DAMAGE_MODEL_EXTENSIBLE=PASS
SENSOR_EXTENSION_MODEL=PASS
UTILITY_INFRASTRUCTURE=PASS

DETERMINISM=PASS
REPLAY_REGRESSION=PASS

READY_FOR_NEW_MODULES=YES
```

---

## Qué no hacer todavía

No diseñar todavía el catálogo definitivo de nuevas armas, municiones, minas, misiles, sensores, blindajes o utilities.

Se permiten únicamente fixtures/módulos mínimos de prueba para demostrar las primitivas.

El contenido y balance real llegará después.

---

## FASE 20 — Module Pack v2

Con `READY_FOR_NEW_MODULES=YES`, abrir una fase separada de contenido y balance.

Cada nuevo módulo debería requerir normalmente:

```text
JSON
+ tests
+ balance
+ visual
+ documentation
```

y no cambios en el núcleo del motor.
