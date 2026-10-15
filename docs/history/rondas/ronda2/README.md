# Ronda 2 — registro de ejecución

Historial legible del avance de la [Ronda 2 del dosier](../Dosier_tareas_S9_AI_Arena.md#15-ronda-2--remediación-integración-evolución-y-retirada-de-v1).
Cada apartado se implementa, se verifica, se documenta en `reportes/` y se commitea+empuja por separado.

Ramas de trabajo: `ronda2/r-p0-bloqueantes` → `ronda2/entrypoints-servicios` (PR #17) →
ramas `ronda2/rX.Y-*` por tarea (PR #18–#31) → **`integration/ronda2-ronda3`** (integración conjunta).

**Leyenda:** ✅ hecho y verificado · 🔜 en curso · ⏳ pendiente.

## Banda R-P0 · Errores bloqueantes

| Tarea | Descripción | Estado | Issue | Reporte | Commit/PR |
|---|---|---|---|---|---|
| R1.1 | Munición: `resolveVehicle` propaga `entry.ammo` | ✅ Hecho | #15 | [R1.1-municion.md](reportes/R1.1-municion.md) | `8935c45` |
| R1.2 | Sensor acústico muerto + test vacuo | ✅ Hecho | — | [R1.2-sensor-acustico.md](reportes/R1.2-sensor-acustico.md) | `e1fa327` |
| R1.3 | Publicar `sensor.acoustic`/`sensor.proximity` en catálogo | ✅ Hecho | — | [R1.3-sensores-catalogo.md](reportes/R1.3-sensores-catalogo.md) | `67e2c04` |
| R1.9 | `zone_control` jugable + King of the Hill | ✅ Hecho | — | [R1.9-zone-control-koth.md](reportes/R1.9-zone-control-koth.md) | `a8652fd` |
| R1.4 | Secreto JWT: fallar cerrado + leer por archivo | ✅ Hecho y verificado (Linux) | #14 rel. | [R1.4-secreto-jwt.md](reportes/R1.4-secreto-jwt.md) | `7e23a39` |
| R1.5 | Sandbox: fallar cerrado sin runner | ✅ Hecho y verificado (Linux) | #9 rel. | [R1.5-sandbox-fail-closed.md](reportes/R1.5-sandbox-fail-closed.md) | `80acf8d` |
| R1.6 | CI del sandbox: no pasar en verde sin probar | ✅ Hecho y verificado (Linux) | — | [R1.6-ci-sandbox.md](reportes/R1.6-ci-sandbox.md) | `a75da48` |
| R6.1 | Construir los runtimes, fijar digests reales y **probar el sandbox de verdad** | ✅ Hecho y verificado (Docker real) | — | [R6.1-runtimes-digests.md](reportes/R6.1-runtimes-digests.md) | `c1e9a2b`+ |
| R1.7 | Retirar el montaje de `docker.sock` | ✅ Hecho y verificado (sin Docker; ruta viva → R-DEPLOY) | — | [R1.7-docker-sock.md](reportes/R1.7-docker-sock.md) | PR #19 |
| R1.8 | Rate-limit y bloqueo de login tras proxy | ✅ Hecho y verificado (Linux) | — | [R1.8-rate-limit-proxy.md](reportes/R1.8-rate-limit-proxy.md) | PR #18 |

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

## Banda R-P1 · Integración, robustez y CI honesta

| Tarea | Descripción | Estado | Issue | Reporte | Commit/PR |
|---|---|---|---|---|---|
| R2.8 | Paridad de SDK: CLI `arena-sim` en JS (deuda de E5) | ✅ Hecho | — | [R2.8-cli-arena-sim-js.md](reportes/R2.8-cli-arena-sim-js.md) | PR #20 |
| R2.7 | Hash de estado y lint de determinismo completos (ERR-ENG-02/04/05/06/07) | ✅ Hecho y verificado (Linux) | — | [R2.7-determinismo.md](reportes/R2.7-determinismo.md) | PR #21 |
| R2.1 | Tipos en verde (ERR-GES-02/03) + CI bloqueante: tsc sin `continue-on-error`, prettier real, cobertura como artefacto | ✅ Hecho | #11 rel. | [R2.1-tipos-ci.md](reportes/R2.1-tipos-ci.md) | PR #22 |
| R2.2 | Semáforo 🟢/🟡/🔴 en la CI (ERR-GES-05): staging omitido = AMARILLO (nunca verde), seguridad en rojo bloquea, gate testeable (`ci-gate.mjs`) + check-run neutral | ✅ Hecho (lógica verificada con tests; run real pendiente del PR) | — | [R2.2-semaforo-ci.md](reportes/R2.2-semaforo-ci.md) | PR #24 |
| R2.3 | Suite ejecutable en Windows: split `test:pure`/`test:db` + fallback `DATABASE_URL` (ERR-GES-04) | ✅ Hecho y verificado (Linux, ambos modos de BD) | — | [R2.3-split-suite.md](reportes/R2.3-split-suite.md) | PR #23 |
| R2.4 | Análisis estático por AST real (Python `ast` + acorn, fail-closed) y auth endurecida: reauth fuerte para 2FA, familias de refresh tokens con detección de reutilización, vida absoluta, anti-enumeración con hash señuelo (ERR-SEC-06/07/08/11) | ✅ Hecho y verificado (Linux, +28 tests) | — | [R2.4-ast-auth.md](reportes/R2.4-ast-auth.md) | PR #25 |
| R2.5 | Encolar builds (worker + tabla `jobs`), firma verificable desde secreto y rate-limit compartido (ERR-SEC-12/15/14) | ✅ Hecho y verificado (Linux, 726/1/3) | — | [R2.5-colas-firma.md](reportes/R2.5-colas-firma.md) | PR #26 |
| R2.6 | Saneado de subidas y cabeceras (ERR-SEC-09/10/16): paquete con esquema ajv estricto, Content-Disposition RFC 6266/5987, ticket de espectador fuera de la URL + wss en prod, HSTS al gateway; SERVICE_ENTRY de la API ya resuelto en la rama base (`5dba8de`) | ✅ Hecho y verificado (Linux; arranque del contenedor pendiente de R-DEPLOY) | — | [R2.6-subidas-cabeceras.md](reportes/R2.6-subidas-cabeceras.md) | PR #27 |

> **R2.1 · 2026-07-17 (VM108, Node 20).** `npx tsc --noEmit` da **0 errores** en el tsconfig raíz
> (antes 267: ~238 falsos de JSX de `apps/web` + 29 genuinos) y **0** en `apps/web` (proyecto
> propio con jsx). El paso de tipos de la CI ya **rompe** ante un error (demostrado en local con
> un error deliberado); "Formato" ejecuta `prettier --check` de verdad (ámbito: solo código
> TS/JS, sin `arena-engine` hasta que se fusione R2.7) y las unitarias publican cobertura V8
> como artefacto. Suite: **706 ✓ / 1 ✗ (zstd Node 20, preexistente) / 3 skip** — 0 fallos nuevos.
>
> **R2.7 · nota sobre golden:** el hash canónico incorpora la huella del solver, lo que
> invalidaba el hash almacenado de `combat_result.json`. Regenerado **deliberadamente** con
> `UPDATE_GOLDEN=1`; el diff es una línea (`finalStateHash`), con `winner`/`ticks`/`score`
> idénticos y las trazas físicas (`chase`, `head_on`, `slalom_wall`) intactas. En la rama de
> integración se regeneró una segunda vez tras juntar R2.7 (huella del solver) con R3.8 (campo
> `jug`): el hash combinado solo es calculable con ambos integrados; `winner`/`ticks`/`score`
> siguen intactos.

## Banda R-P2 · Producto: visor, panel y modos

| Tarea | Descripción | Estado | Issue | Reporte | Commit/PR |
|---|---|---|---|---|---|
| R3.1 | El replay interpola como el directo (ERR-VIS-01): reloj de reproducción explícito, `pushSnapshot` por snapshot y `resetTo` solo tras seek | ✅ Hecho (visual en navegador pendiente) | — | [R3.1-replay-interpolado.md](reportes/R3.1-replay-interpolado.md) | PR #28 |
| R3.2 | Interpolación sobre delta de ticks + delay-buffer, balística local, niebla tras interpolar (fundido+histéresis), cámara amortiguada con interacción, transporte con backoff+jitter/watchdog, SwiftShader en streamer (ERR-VIS-06/07/08) | ✅ Hecho (visual en navegador pendiente) | — | [R3.2-interp-camara.md](reportes/R3.2-interp-camara.md) | PR #31 |
| R3.7 | Panel: torneos (crear/seguir/cuadro), batallas e historial con enlaces bot→batalla→replay, sesión persistente (cookie httpOnly + interceptor 401), editor de loadout con revisión vigente, error boundary y a11y (ERR-VIS-02/03/04/10) | ✅ Hecho (E2E visual con navegador pendiente) | — | [R3.7-panel.md](reportes/R3.7-panel.md) | PR #29 |
| R3.8 | Modos baratos: LMS + nivel match (`rng.fork`), Domination, Juggernaut, registro por metadatos (MEJ-modos) | ✅ Hecho y verificado | — | [R3.8-modos-baratos.md](reportes/R3.8-modos-baratos.md) | PR #30 |

Pendientes de R-P2: **R3.3** (rendimiento del front y medición), **R3.4–R3.6** (arte, efectos, HUD).

Línea base del área de motor+catálogo al abrir la rama: **188 tests verdes** (`npx vitest run packages/module-catalog apps/arena-engine`).

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

## Propuesta (no ejecutada): registro por tarea en vez de tabla compartida

Casi todos los conflictos de merge de la Ronda 2 se concentraron en las tablas de este README:
cada PR añade su fila en la misma zona del fichero. Propuesta para la siguiente ronda:

```
docs/ronda2/registro/
├── R2.1.md   (una ficha corta por tarea: estado, PR, reporte, verificación)
├── R2.2.md
└── …
```

El README pasaría a ser un índice (o a generarse con un script a partir de `registro/`),
de modo que dos PRs nunca editen la misma línea. No se aplica ahora para no ampliar el
alcance de la integración; queda como propuesta técnica.
