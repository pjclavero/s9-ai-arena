# R17 · Instalación y readiness

> Estado: rebanada 1 (motor + modelo de configuración + asistente de primer arranque),
> ejecutable y con mutaciones. No toca producción ni el rollout en curso.

## Por qué existe

Un despliegue puede *parecer* listo y no estarlo. Todas las confusiones que ataca
R17 se han observado de verdad en este proyecto:

| Confusión                              | Fallo real observado                                                                  | Comprobación                    |
| -------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| HEALTHY != READY                       | Contenedor `healthy` cuya única tarea (copia nocturna) fallaba todas las noches         | `backup.last_run_succeeded`     |
| BACKED_UP != RECOVERY_VERIFIED         | Existía copia; nadie había restaurado nunca                                             | `backup.restore_drill`          |
| IMAGE TAG != DEPLOYED VERSION          | Imagen etiquetada con un commit y construida desde otro; image ID borrada del daemon    | `security.deployed_version`     |
| SECRET EXISTS != SECRET MOUNTED        | El fichero existía en el host; el contenedor no lo montaba                              | `security.secret_mounted`       |
| STORAGE EXISTS != STORAGE WRITABLE     | Volumen `root:root`, proceso uid 1000, diez días de ingestas perdidas en silencio       | `storage.writable`              |
| EMPTY != ERROR                         | 0 filas leídas como "correcto y vacío" sin saber si la consulta llegó a ejecutarse      | `diagnostics.db_canary`         |
| COMMAND EXIT 0 != BEHAVIOR EXERCISED   | `UPDATE 0` sobre tabla vacía leído como "aceptado": no se probó nada                    | `requireEffect` (transversal)   |

## Piezas

- `packages/readiness/config.ts` — **modelo de configuración**: qué es obligatorio,
  qué tiene defecto seguro, qué es una puerta (apagada por defecto) y qué es secreto
  (se prefiere `*_FILE` montado en `/run/secrets/<secret-name>`; nunca argv).
- `packages/readiness/engine.ts` — **motor**. Tres estados: `verified`, `failed`,
  `not_exercised`. **`not_exercised` no es aprobado**; una excepción de sonda tampoco
  es un "skip". `requireEffect()` convierte efecto nulo (0 bytes, 0 filas) en
  `not_exercised` aunque el comando saliera con 0.
- `packages/readiness/checks.ts` — **catálogo**. Cada comprobación declara `proves` y
  `doesNotProve` (obligatorio; hay test que lo exige).
- `packages/readiness/mutations.ts` — **escenario nominal + 21 mutaciones** que
  reproducen los fallos reales. El test exige que toda comprobación tenga al menos una
  mutación y que todas la saquen de `verified`: *una comprobación que no puede ponerse
  roja no es una comprobación*.
- `packages/readiness/probes-local.ts` — **sondas honestas**: sólo la escritura en el
  directorio de datos se puede ejercer sin infraestructura; el resto devuelve
  `not_exercised` con motivo. Preferimos un `NOT_READY` honesto a un `READY` no probado.
- `packages/readiness/first-run.ts` — **asistente de primer arranque**: pasos derivados
  del modelo y del informe; nunca marca hecho por omisión (`unknown` bloquea).
- `packages/readiness/report.ts` — informe en texto; recuento completo de estados y
  jamás imprime valores secretos (hay test).

## Uso

```bash
npx tsx scripts/readiness.ts             # informe real (sondas locales honestas)
npx tsx scripts/readiness.ts --selftest  # autodiagnóstico del motor (escenario sintético)
npx vitest run packages/readiness        # suite: contrato, motor y mutaciones
```

Código de salida 0 sólo con veredicto `READY` **y** configuración válida.

## Puertas

`S9_ENABLE_REAL_BATTLE_RUNS` y `S9_PUBLIC_SPECTATE_ENABLED` están **apagadas por
defecto** y marcadas como **bloqueadas por decisión del operador** en este despliegue:
encenderlas es un *error* de configuración, no un aviso. Además, la comprobación de
puerta no se cree al entorno: si no puede preguntarle al runtime, queda `not_exercised`.

## Lo que R17 todavía NO hace

- Las sondas reales (docker/psql/restic) no están implementadas: hoy devuelven
  `not_exercised` con motivo. Es deliberado, y es la siguiente rebanada.
- El motor no arranca ni repara nada: informa con evidencia.
- Ninguna pieza toca producción.
