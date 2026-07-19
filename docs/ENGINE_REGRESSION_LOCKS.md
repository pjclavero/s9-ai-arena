# R13.0 · Engine Regression Locks

> **Siguiente PR de código recomendado** tras #50/#51/#52. Fija con tests los tres fallos críticos
> auditados y los invariantes de determinismo/replay. **Riesgo bajo.** No toca contrato, seguridad,
> VM108/VM104/runner/proxy. Verificado contra `main@e9438f9`.

## Objetivo

Convertir la auditoría (ver `docs/R13_ENGINE_RUNTIME_QUALITY.md §0`) en **candados**: tests que
fallen si cualquiera de los tres fallos reaparece, más el arreglo acotado del contador de radio.

## Tests concretos (candados)

1. **Radio — el spam no crece sin límite.** En una batalla larga (p. ej. 60 s simulados), un bot que
   emite radio cada tick no debe hacer crecer sin cota la estructura interna. Criterio observable:
   memoria/estructura de radio **O(nº vehículos)**, no O(ticks). Requiere el arreglo (contador por
   vehículo con `{segundo, cuenta}`, reset al cambiar de segundo).
2. **Determinismo — mismo seed ⇒ mismo `finalStateHash`.** Dos ejecuciones idénticas producen el
   mismo hash final (candado ya existente en `determinism.test.ts`; reforzar cobertura si aplica).
3. **Acoustic detecta disparo/explosión real.** Provocar un `gunshot`/`explosion` dentro de rango y
   **exigir** `sensors.acoustic[0].sources.length > 0` con `bearing`. (Sustituye al test vacuo de
   `sensors-fog.test.ts:240`.)
4. **Acoustic no revela coordenadas absolutas.** Cada `source` tiene `bearing`/`kind`/`intensity` y
   **nunca** `position`/`distanceM`/`entityId` (cap. 11).
5. **Bots sin sensor acústico no reciben `acoustic`.** Un loadout sin módulo acústico ⇒ `sensors.acoustic`
   ausente aunque haya sonidos.
6. **Loadout con munición permite disparar.** Loadout con `rounds>0` ⇒ `canFire` OK y la munición se
   **consume** (positivo que hoy falta).
7. **Loadout sin munición devuelve `no_ammo`.** (Ya cubierto en `combat.test.ts:191`; conservar.)
8. **Respawn restaura munición.** Tras `respawn()`, `ammo/charges` vuelven al valor del `spec`.
9. **Replay sigue verificable.** El replay de una batalla con los cambios reproduce el mismo hash
   (candado ya existente en `replay-golden.test.ts`; no debe romperse).

## Criterios de aceptación

- Los 9 candados en **verde**.
- El candado 1 falla **antes** del arreglo del `Map` y pasa **después** (demuestra el arreglo).
- El candado 3 falla contra un motor con acústico "muerto" (demuestra que no es vacuo).
- El candado 6 falla si se rompe la propagación `rounds → ammo`.
- `replay-golden` y `determinism` **siguen** verdes (sin regresión de hash).

## Ficheros probables

| Fichero | Cambio |
|---|---|
| `apps/arena-engine/src/sim/battle.ts` | contador de radio por vehículo (sustituir `Map` global) |
| `apps/arena-engine/tests/regression-locks.test.ts` | **nuevo**: candados 1,3,4,5,6,8 |
| `apps/arena-engine/tests/sensors-fog.test.ts` | reforzar el test acústico (quitar el `if` vacuo) |
| `apps/arena-engine/tests/combat.test.ts` | añadir positivo de munición + respawn |
| `docs/R13_ENGINE_RUNTIME_QUALITY.md` | marcar candados como implementados al mergear |

## Comandos (adaptados al repo)

```bash
npm run lint          # lint de determinismo (apps/arena-engine/scripts/lint-determinism.mjs)
npm run typecheck     # tsc --noEmit && tsc --noEmit -p apps/web
npm test              # vitest run
npm run format        # prettier --write .  (o revisar con --check)
```

## Riesgos

- **Bajo.** El único cambio de producción es el contador de radio, acotado y determinista. Debe
  mantenerse el orden de entrega de radio (misma cola, mismos `deliverAtTick`) para no alterar el hash.
- Regresión de hash: mitigada por los candados 2 y 9 (deben seguir verdes).

## Definición de done

Los 9 candados en verde, sin regresión de `determinism`/`replay-golden`, CI verde, y §0 de
`R13_ENGINE_RUNTIME_QUALITY.md` actualizado para reflejar radio "cerrado" y acoustic "test reforzado".
