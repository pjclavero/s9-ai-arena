# R13 · Calidad y operabilidad del motor (engine runtime quality)

> Documentación y plan. **No implementa** nada por sí mismo. Verificado contra `main@e9438f9`.
> Bloque separado de R10/R11/R12/R14/R16. No toca VM108/VM104/runner/proxy/seguridad.

## 0. Auditoría de los tres fallos críticos (Equipo 2)

Revisado en `apps/arena-engine/src/sim/{battle,vehicle,sensors,combat}.ts` y
`apps/arena-engine/tests/*`.

| Fallo | Estado en código | Test existente | Documentado | Riesgo residual | Acción recomendada |
|---|---|---|---|---|---|
| **1. `radioSentThisSecond` con `Map`** | **Parcial.** Sigue usando `new Map<string,number>()` (`battle.ts:94`) con clave `"${id}:${floor(tick/TICK_HZ)}"` (`:286`,`:292`). **Nunca se limpia**: crece (nº vehículos × segundos) durante la batalla. Determinismo **OK**: acceso por clave, no por iteración. | No hay test de "el spam de radio no crece sin límite". | No. | Fuga acotada por batalla (GC al terminar); no rompe determinismo hoy, pero es frágil. | R13.0: sustituir el `Map` por **contador por vehículo acotado** (guardar `{segundo, cuenta}` por vehículo, reset al cambiar de segundo) + test de no-crecimiento. |
| **2. Sensor acústico muerto / test vacuo** | **Código VIVO.** `sensors.ts:179-188` lee `world.sounds`, filtra por rango y emite `sources` con `bearing/kind/intensity` (solo dirección, nunca posición, cap. 11). `battle.ts` empuja sonidos: gunshot (`:423`), engine (`:315`), explosion (`:483`,`:517`); se vacían cada ciclo (`:193`). | **VACUO.** `sensors-fog.test.ts:240-243`: `if (acoustic && acoustic.sources.length > 0) {…}` en `emptyArena()` sin disparos ⇒ el `if` es falso y **no se afirma nada**. | No. | **Regresión silenciosa**: si el acústico dejara de emitir, el test seguiría en verde. | R13.0: test **no vacuo** — provocar un disparo/explosión reales y **exigir** `sources.length > 0` con `bearing`; y verificar que un bot **sin** módulo acústico no recibe `acoustic`. |
| **3. Munición del loadout no propagada / `no_ammo`** | **ARREGLADO.** `vehicle.ts:134` inicializa `ammo: m.rounds ?? 0` y `charges: m.charges ?? 0`; respawn (`:293-294`) restaura `ammo/charges` desde `spec`. `combat.ts:184-187 ammoFor` localiza munición aceptada; `:156-157` devuelve `no_ammo` solo si `ammo<=0`. | **Parcial.** `combat.test.ts:191-192` cubre el **negativo** (`ammo=0 ⇒ no_ammo`). **Falta el positivo** (loadout con `rounds` dispara) y el de **respawn** (restaura munición). | No. | Sin lock del positivo, una regresión de propagación no la detecta la suite. | R13.0: test **positivo** (loadout con `rounds>0` ⇒ `canFire` OK y consume) + test de **respawn** que restaura munición. |

**Conclusión de auditoría:** de los tres, **solo ammo está arreglado en código**; **acoustic** funciona
pero su test es vacuo; **radio** sigue con `Map` sin acotar. **Ninguno de los tres está documentado**
ni tiene lock de regresión fuerte. → Esto justifica **R13.0** como PR inmediato tras #50/#51/#52.

> **No se declara ningún fallo "cerrado".** ammo tiene arreglo pero le falta lock positivo; acoustic
> y radio no están cerrados.

## 1. R13.0 — Engine Regression Locks

Ver documento dedicado: **`docs/ENGINE_REGRESSION_LOCKS.md`**. Es el **siguiente PR recomendado**.
Fija con tests los tres fallos + invariantes de determinismo/replay. **Riesgo: bajo** (tests + arreglo
acotado de radio). No cambia el contrato ni la seguridad.

## 2. R13.1 — Inspector de estado + slow motion

- **`--inspect`**: arranca un **endpoint HTTP read-only** que expone un *snapshot seguro* del estado
  (tick, vehículos, hp, poses agregadas) — **sin secretos**, sin comandos de bots crudos, sin tokens.
- Snapshot serializado desde una copia; **no** referencia mutable al estado vivo.
- **`--speed 0.1`**: escala el **reloj de ejecución/render** (para depurar visualmente), **no** el
  `TICK_DT` lógico: el tick sigue siendo determinista; solo cambia cada cuánto tiempo real se ejecuta.
- **Riesgo: medio** (nueva superficie HTTP). Gateado por flag, bind local, off por defecto.

## 3. R13.2 — Métricas Prometheus

Endpoint `/metrics` (formato Prometheus) en los servicios de motor/orquestación. Métricas propuestas:

```
arena_ticks_total                  (counter)
arena_tick_duration_ms             (histogram)
arena_ticks_per_second             (gauge)
arena_bot_decision_duration_ms     (histogram, por bot)
arena_bot_errors_total             (counter, por bot/tipo)
arena_replay_write_errors_total    (counter)
arena_battle_state                 (gauge/enum: prepared/running/finished/...)
arena_active_battles               (gauge)
```

- **Sin** cardinalidad explosiva (no etiquetar por batalla individual sin límite).
- **Riesgo: bajo.** Solo lectura; no toca determinismo.

## 4. R13.5 — Rapier upgrade evaluation

**No actualizar Rapier directamente.** Evaluación en **rama separada**:

- generar **golden replays** con el motor actual;
- reproducir con Rapier y **comparar `finalStateHash`** bit a bit;
- **benchmark** de rendimiento; **checksum físico** por tick;
- plan de **rollback**;
- **si el hash cambia ⇒ es un cambio de versión física** (rulesetVersion/engineVersion), no un
  parche transparente: exige re-emitir golden replays y versionar.
- **Riesgo: alto** (determinismo físico). Requiere su propio dictamen.

## 5. Posterior por riesgo

| Tema | Requisito previo | Riesgo | Notas |
|---|---|---|---|
| **save/load de estado de batalla** | snapshot estable + compatibilidad de versión (engine/ruleset) | medio | reanudar debe reproducir el mismo hash; versionar el formato. |
| **latencia simulada / pérdida de paquetes** | modelo de red del ProtocolServer | medio | útil para robustez de bots/red; no debe alterar el tick lógico determinista. |
| **workers paralelos con sharding** | R13.2 (métricas) + R13.0 (locks) | **alto** | riesgo de determinismo; va **después** de métricas y regression locks. |

## Definición de "hecho" de R13 (por sub-bloque)

- **R13.0**: locks de los 3 fallos en verde + replay sigue verificable + CI verde. (Ver doc dedicado.)
- **R13.1/R13.2**: flag off por defecto, sin secretos, sin cambiar determinismo, tests de humo.
- **R13.5**: informe de evaluación con comparación de hash; **no** merge al motor.
- save/load/latencia/sharding: solo diseño hasta que R13.0 y R13.2 estén en main.
