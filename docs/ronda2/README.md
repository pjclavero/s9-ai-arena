# Ronda 2 — registro de ejecución

Historial legible del avance de la [Ronda 2 del dosier](../Dosier_tareas_S9_AI_Arena.md#15-ronda-2--remediación-integración-evolución-y-retirada-de-v1).
Cada apartado se implementa, se verifica, se documenta en `reportes/` y se commitea+empuja por separado.

Rama de trabajo: `ronda2/r-p0-bloqueantes`.

## Banda R-P0 · Errores bloqueantes

| Tarea | Descripción | Estado | Issue | Reporte | Commit |
|---|---|---|---|---|---|
| R1.1 | Munición: `resolveVehicle` propaga `entry.ammo` | ✅ Hecho | #15 | [R1.1-municion.md](reportes/R1.1-municion.md) | `8935c45` |
| R1.2 | Sensor acústico muerto + test vacuo | ✅ Hecho | — | [R1.2-sensor-acustico.md](reportes/R1.2-sensor-acustico.md) | `e1fa327` |
| R1.3 | Publicar `sensor.acoustic`/`sensor.proximity` en catálogo | ✅ Hecho | — | [R1.3-sensores-catalogo.md](reportes/R1.3-sensores-catalogo.md) | `67e2c04` |
| R1.9 | `zone_control` jugable + King of the Hill | ✅ Hecho | — | [R1.9-zone-control-koth.md](reportes/R1.9-zone-control-koth.md) | `a8652fd` |
| R1.4 | Secreto JWT: fallar cerrado + leer por archivo | ✅ Hecho y verificado (Linux) | #14 rel. | [R1.4-secreto-jwt.md](reportes/R1.4-secreto-jwt.md) | `7e23a39` |
| R1.5 | Sandbox: fallar cerrado sin runner | ✅ Hecho y verificado (Linux) | #9 rel. | [R1.5-sandbox-fail-closed.md](reportes/R1.5-sandbox-fail-closed.md) | `80acf8d` |
| R1.6 | CI del sandbox: no pasar en verde sin probar | ✅ Hecho y verificado (Linux) | — | [R1.6-ci-sandbox.md](reportes/R1.6-ci-sandbox.md) | `a75da48` |
| R6.1 | Construir los runtimes, fijar digests reales y **probar el sandbox de verdad** | ✅ Hecho y verificado (Docker real) | — | [R6.1-runtimes-digests.md](reportes/R6.1-runtimes-digests.md) | `c1e9a2b`+ |
| R1.7 | Retirar el montaje de `docker.sock` | ⏸️ Pendiente (pausa) | — | — | — |
| R1.8 | Rate-limit y bloqueo de login tras proxy | ⏸️ Pendiente (pausa) | — | — | — |

> **Verificación en Linux · 2026-07-17 (VM108).** La verificación de **R1.4 y R1.5** que quedaba
> diferida a Linux está **hecha**: los tests que usan PostgreSQL embebido (ERR-GES-04) no se podían
> ejecutar en Windows y aquí sí corren.
>
> - Suite completa: **702 pasan · 0 fallan · 3 skipped** (74 ficheros). Node 22.23.1, usuario no root.
>   La referencia histórica en Linux era 646/1/3, donde el fallo era el `zstd` de Node<22.15: con
>   Node ≥ 22.15 ya no aparece.
> - R1.5: `apps/bot-manager/tests/pipeline.test.ts` **14/14** y, sobre todo,
>   `apps/api/src/e6-integration.test.ts` **4/4** — el guardián de regresión de ERR-SEC-03
>   ("SIN sandbox → RECHAZA") queda verificado **a nivel de API**, que era lo que faltaba.
> - R1.4: `apps/api/src/auth` + `public-api.test.ts` **33/33**. `tsc` sin errores en los ficheros de
>   R1.5 (`pipeline.ts`, `e6-bot-manager.ts`, `app.ts`) ni TS2367.
> - `compose-scan.test.ts` **5/5** (en Windows fallaba por `spawnSync npx ENOENT`); relevante para R1.7.
>
> **Hallazgo:** R1.5 dejó en rojo dos tests E2E que en Windows no llegaban a ejecutarse
> (`tests/e2e/mvp-success.e2e.test.ts` paso 2 y `tests/gamedays/gameday-m3.test.ts` GD-7): ejercían el
> camino feliz sin cablear el sandbox en proceso. Corregido en `b8b6cbb` cableando el sandbox de
> `e6-integration`, sin relajar ninguna aserción — de hecho `mvp-success` esperaba las etapas del
> sandbox en `skipped` con la versión `validated`, que era justo el agujero ERR-SEC-03; ahora exige
> `passed`.
>
> Quedan de R-P0: **R1.6, R1.7 y R1.8**. El sub-lote de motor (R1.1, R1.2, R1.3, R1.9) sigue cerrado.

**Leyenda:** ✅ hecho y verificado · 🔜 en curso · ⏳ pendiente.

Línea base del área de motor+catálogo al abrir la rama: **188 tests verdes** (`npx vitest run packages/module-catalog apps/arena-engine`).

## Banda R2 · Endurecimiento (Ronda 2)

| Tarea | Descripción | Estado | Issue | Reporte | Commit |
|---|---|---|---|---|---|
| R2.4 | Análisis estático por AST real (Python `ast` + acorn, fail-closed) y auth endurecida: reauth fuerte para 2FA, familias de refresh tokens con detección de reutilización, vida absoluta, anti-enumeración con hash señuelo (ERR-SEC-06/07/08/11) | ✅ Hecho y verificado (Linux, +28 tests) | — | [R2.4-ast-auth.md](reportes/R2.4-ast-auth.md) | rama `ronda2/r2.4-ast-auth` (PR draft) |

## R6.1 · la suite de escape ya se ha ejecutado VIVA (2026-07-17)

**Resuelto lo que la nota de R1.6 daba por bloqueado.** La suite de escape se ha ejecutado
contra el sandbox real por primera vez: **7/7 vectores contenidos con prueba**, leyendo la
imagen de `runtimes/DIGESTS.lock` y descargándola de GHCR. El `digests-gate` se abre solo.

Por el camino aparecieron cuatro defectos reales que solo se ven construyendo y ejecutando:
**dependency confusion** en los dos runtimes (el SDK propio se pedía a PyPI/npmjs, donde el
nombre está libre), el **sandbox no arrancaba** (seccomp sin las syscalls que `runc init`
necesita en Docker 29 → los 7 vectores salían `NO PROBADO`), la suite **no ejecutaba el bot**
(`python python /bot.py`), y el **CI del sandbox no podía funcionar** ni con digests reales
(`docker build -t` sobre una referencia por digest). Detalle y contadores en el
[reporte de R6.1](reportes/R6.1-runtimes-digests.md).

Suite completa tras R6.1: **707 pasan · 0 fallan · 3 skipped** (eran 702/0/3; +5 tests de
regresión nuevos).

## R1.6 · nota sobre la ejecución viva (2026-07-17, ya superada por R6.1)

El harness y el CI ya no pueden dar verde sin probar, y eso está verificado. Lo que **no** se
ha podido ejecutar es la suite de escape **contra el sandbox real**, y no por R1.6: el runtime
de Python **no es construible** hoy. Se intentó en VM108 con Docker y un registry local — el
`FROM python@sha256:0000…` no resuelve (se obtuvo el digest real y el build avanzó), pero
`pip install --require-hashes` falla porque `runtimes/python/allowed-requirements.lock` tiene
hashes placeholder, como el propio fichero admite. Es **R6.1** íntegro, y es más trabajo del que
sugiere su enunciado: hay que generar el lock con hashes reales, construir las dos imágenes y
fijar sus digests. Mientras tanto, el gate deja los jobs en *skipped* y la suite dice la verdad.
