# ADR-020 · Spawns seguros para 4v4: el motor pasa a 0.3.0

**Estado:** aceptado (2026-10-29) · **Ámbito:** `apps/arena-engine` (`sim/battle.ts`, `sim/modes.ts`)

## Contexto

Para jugar 4v4 (`team_deathmatch`, máximo 8 participantes) se midió el motor real sobre
`mvp-arena-01` pasado por `toEngineMap` (test `apps/arena-engine/tests/spawn-4v4.test.ts`).
El mapa trae **2 spawns por bando**. Con el motor 0.2.0:

| Pregunta | Medido |
|---|---|
| ¿Nacen superpuestos? | Sí. Reparto cíclico `pool[idx % pool.length]`: veh_1/veh_5 y veh_3/veh_7 (y sus homólogos azules) nacen con los centros **coincidentes** (hueco −3,2 m con gunner, −4,0 m con heavy). |
| ¿La física los separa? | Sí, a empujones: Rapier corrige la penetración por posición durante ~30 ticks (1 s) y los deja **tocándose** (hueco −0,001 m, 8 pares de contacto) hasta que se mueven. La dirección del empujón la elige el solver (en este mapa, ±y). |
| ¿Daño, impulsos, atascos? | Sin daño (el motor no tiene daño por colisión) y sin velocidad residual, pero 1 s de desplazamiento involuntario y vehículos pegados al aliado al arrancar. |
| ¿Fuera de límites? | En este mapa no (spawns a 10 m del borde), pero el empujón no mira muros: en un mapa con el spawn junto a un muro el solver empuja contra él. |
| ¿El orden de creación da ventaja? | Pequeña: el de id menor ocupa el spawn base y el compañero coincidente sale empujado. |
| Bandos con etiqueta fuera del mapa (torneos A/B) | **Grave**: `own.length === 0` ⇒ pool = todos los spawns, y A y B ciclan por el **mismo** pool. 1v1 A/B: los dos rivales en `spawns[0]`. 4v4 A/B: cada bando repartido por los dos lados, encima de un rival. |
| Respawn (`modes.ts`) | `pool[hashId % pool.length]` sin mirar ocupación: se puede reaparecer encima de un vehículo vivo (o de un resto, que sigue siendo collider). |

## Decisión

1. **Sin tocar mapas publicados.** Los spawns del mapa se usan primero y en su orden. Agotados,
   se generan **posiciones auxiliares** alrededor de cada spawn base: rejilla en el marco del
   spawn (heading), sólo lateral y hacia atrás —nunca por delante: ningún auxiliar nace más
   cerca del rival que su spawn base—, paso `2·radioMáx + 1 m`, hasta 4 anillos. Un auxiliar se
   acepta sólo si está dentro del mapa con margen, a ≥ radio + 1 m de muros (rectángulo orientado),
   destructibles y zonas de daño, y no solapa a ningún vehículo colocado ni a un spawn del mapa aún
   libre. Sin hueco: el reparto cíclico de 0.2.0 (mapa saturado; no ocurre en los publicados).
2. **Grupos de spawns** (`resolveSpawnGroups`): un bando con etiqueta del mapa usa la suya; los
   desconocidos, en orden alfabético, se reparten cíclicamente entre los grupos que nadie reclama
   (en orden de aparición en el mapa). A/B sobre red/blue ⇒ A→red, B→blue.
3. **Respawn**: mismo punto de partida que 0.2.0 (`hashId % pool`), pero se salta cualquier punto
   que solape a otro vehículo con cuerpo (vivo o resto); después, auxiliares. Dos reapariciones en
   el mismo tick ven la posición de la anterior.
4. `engine.version` pasa de `0.2.0` a **`0.3.0`** (regla de ADR-019): las batallas A/B de torneo,
   cualquier bando con más jugadores que spawns y los respawns sobre punto ocupado **ya eran
   grabables** en producción y ahora simulan distinto. `physics`, `protocol` y `rulesSchema` no
   cambian.

## Qué NO cambia (comprobado)

- 1v1 y 2v2 red/blue nacen exactamente donde antes. Hashes fijados con el motor de `e902b0a` en
  `spawn-4v4.test.ts` (1v1 HunterBot en `mvp-arena-01` real y en arena abierta con muertes y
  respawn): idénticos. Los golden existentes (`replay-golden`, `determinism`) siguen verdes sin
  regenerar.
- La verificación de un replay 0.2.0 da `engine_version_mismatch` (no «manipulado»), igual que
  0.1.0 con ADR-019; la tabla de consumidores de la versión de ADR-019 sigue vigente.

## Alternativas descartadas

- **Añadir spawns a los mapas**: prohibido (mapas publicados con checksum); y no arregla mapas de
  usuarios.
- **Anillo completo alrededor del spawn**: coloca auxiliares por delante del spawn base ⇒ ventaja
  por orden de creación.
- **Dejar que Rapier los separe**: 1 s de empujones, dirección arbitraria, sin garantía frente a
  muros.
- **Subir versión sólo para A/B** (multi-versión): es la multi-versión encubierta que ADR-019 ya
  descartó.

## Consecuencias

- En A/B el bando A juega en el lado del primer grupo del mapa. `swapMapSides` (`match.ts`) sigue
  sin intercambiar lados con etiquetas A/B (no coinciden con las del mapa); el scheduler ya alterna
  A/B por partida. Pendiente si se quiere swap por rondas con A/B.
- Un bot que deduzca su lado buscando su etiqueta en `map.spawns` del WELCOME no la encuentra con
  A/B (ya ocurría en 0.2.0).
