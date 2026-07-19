# R13 · Calidad y operabilidad del motor (engine runtime quality)

> Documentación y plan. Verificado contra `origin/main` (worktree limpio). Bloque separado de
> R10/R11/R12/R14/R16. No toca VM108/VM104/runner/proxy/seguridad.

## 0. Auditoría de los tres fallos críticos — CERRADA por R13.0 (2026-07-19)

> **Corrección de la auditoría previa (#54):** aquella pasada leyó una **copia de trabajo stale**
> del motor y afirmó que el radio "seguía usando un `Map id:segundo`". **Era falso.** En
> `origin/main` el radio **ya usa un contador por vehículo** (`v.radioSentThisSecond` +
> `v.radioSecond`, reset por segundo — fix **ERR-ENG-06**), presente desde R2.7. Verificado en el
> worktree limpio. La tabla siguiente refleja el **estado real** y el candado de R13.0 que lo fija.

Revisado en `apps/arena-engine/src/sim/{battle,vehicle,sensors,combat}.ts` y `tests/*`.

| Fallo | Estado real en código | Antes | Candado R13.0 | Estado |
|---|---|---|---|---|
| **1. radio rate/fuga** | **YA CORRECTO.** Contador por vehículo `v.radioSentThisSecond`/`v.radioSecond` con reset por segundo (ERR-ENG-06): memoria O(1) por vehículo, **sin** `Map id:segundo` acumulado. Determinismo OK. | sin test de rate/reset ni de aislamiento entre batallas | `radio-regression.test.ts`: sin fuga entre batallas, dirigido vs broadcast, sin auto-recepción, **reset por segundo** y determinismo | **CERRADO** |
| **2. acústico** | **YA VIVO.** `sensors.ts` emite `sources` (bearing/kind/intensity, solo dirección, cap. 11); `battle.ts` empuja gunshot/engine/explosion con doble-buffer (ERR-ENG-01). | **test VACUO** (`if sources.length>0` en arena sin sonidos) | `acoustic-sensor-regression.test.ts`: disparo real ⇒ detección dentro de rango, silencio fuera, sin fuga de posición, determinismo | **CERRADO** |
| **3. ammo/loadout** | **YA CORRECTO.** `vehicle.ts` init `ammo: m.rounds ?? 0`; `respawn()` restaura `ammo/charges` desde `spec`. `combat.ts` `no_ammo` si `ammo<=0`. | solo test **negativo** (`ammo=0 ⇒ no_ammo`) | `ammo-loadout-regression.test.ts`: init desde loadout, **positivo** (dispara), consumo, límite y **respawn restaura** | **CERRADO** |

**Conclusión:** los tres fallos **ya estaban corregidos en el código** de `origin/main`; lo que
faltaba era el **blindaje con tests de regresión**, que R13.0 aporta. **Prueba de que los candados
muerden:** mutación del motor (quitar emisión de gunshot / init ammo a 0 / quitar el reset por
segundo) hace **fallar** el test correspondiente; al revertir, 15/15 en verde.

## 1. R13.0 — Engine Regression Locks · IMPLEMENTADO

Ver **`docs/ENGINE_REGRESSION_LOCKS.md`**. Tres ficheros de test (radio/acoustic/ammo), 15 casos,
**solo tests** (cero cambios de motor). Determinismo intacto (`finalStateHash` sin cambios; no se
tocó el formato de replay). **Riesgo: nulo** sobre producción (no cambia contrato ni seguridad).

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
