# Presupuesto de recursos (D-OP-32)

## Resumen

La instalación de producción corre en una máquina virtual de **6 vCPU** y **6,84 GB de RAM**, sobre un
anfitrión de 28 hilos y 32 GB. **Esos límites no se amplían** (decisión D-OP-32): el sistema tiene que
funcionar dentro de ellos con la emisión a YouTube en 1080p30, batallas con contenedores reales, el
worker acotado y nada abandonado (ni contenedores, ni navegadores, ni ficheros temporales).

Este documento fija el presupuesto de cada servicio, el escenario de pico simultáneo y la concurrencia
máxima segura del worker. La fuente de verdad versionada es
[`infrastructure/resource-budget.yaml`](../../infrastructure/resource-budget.yaml); el test
[`infrastructure/tests/resource-budget.test.ts`](../../infrastructure/tests/resource-budget.test.ts) la
cruza con `infrastructure/docker-compose.yml` y con los techos del contenedor de bot, y se pone rojo si
el compose y el presupuesto se separan o si el escenario deja de caber.

**Tres niveles de cifra, siempre separados:**

1. **Medido** (con fuente y fecha): lo observado en producción. Nunca se rellena con una estimación.
2. **Escenario** = pico medido × **margen de seguridad explícito (×1,25)**. Con él se calcula si el
   escenario cabe, y debe dejar **al menos 1 GiB de RAM disponible** (criterio del operador: un margen de
   unos cientos de MiB no se acepta para dar por estable una 4v4 con emisión).
3. **Máximo teórico** = techo de cgroup (`mem_limit`, `cpus`). Es el peor caso documentado; **no** se
   suma como si fuera consumo (ningún servicio lo alcanza a la vez), pero se comprueba aparte.

Resultado: con los picos **medidos** más el margen, una 4v4 con emisión deja **≈ 2,5 GiB disponibles**
(umbral exigido: 1 GiB). La emisión 1080p30 con AVX2 **sigue sin medir**: su cifra es la estimación del
laboratorio sin AVX2 y está marcada como pendiente. El peor caso teórico parcial (bots y streamer en su
techo de cgroup) cabe en la VM; la suma de **todos** los techos a la vez no cabe y se documenta como
riesgo contenido por los límites de cada contenedor.

## Índice

- [Estado de cada afirmación](#estado-de-cada-afirmación)
- [Límites físicos, reserva y margen](#límites-físicos-reserva-y-margen)
- [Tabla por servicio](#tabla-por-servicio)
- [Sobreasignación](#sobreasignación)
- [Escenario de pico simultáneo](#escenario-de-pico-simultáneo)
- [Concurrencia máxima segura del worker](#concurrencia-máxima-segura-del-worker)
- [Qué no cabe y riesgos](#qué-no-cabe-y-riesgos)
- [Pruebas y mutantes](#pruebas-y-mutantes)
- [Ausencia de recursos abandonados](#ausencia-de-recursos-abandonados)
- [Plan de medición (no ejecutado)](#plan-de-medición-no-ejecutado)
- [Criterios de aceptación](#criterios-de-aceptación)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Estado de cada afirmación

| Afirmación | Fase |
|---|---|
| Reposo, pico y CPU de cada servicio con una 4v4 TDM y dos 1v1 (sin emisión), 2026-11-23 | **medido** en producción |
| Bots: 19-36 MiB de pico y ≤ 1,4 % de CPU por contenedor; CPU mediana 0,010 y máx. 0,021 en 70 batallas (2026-11-22) | **medido** |
| tournament-worker con una 4v4: 252 MiB de pico, 155 % de CPU transitorio (5 periodos estrangulados de 1891) | **medido** |
| VM con una 4v4: 1617 MiB usados de media, 1656 de pico, 5122 MiB mínimos disponibles | **medido** |
| Límites actuales de cada contenedor (`NanoCpus`, `Memory`) | **medido** (`docker inspect`) |
| Emisión 1080p30: 2,2-2,6 CPU medias, RSS de 0,45 a 0,8 GiB | **medido sólo en laboratorio sin AVX2**; **con AVX2: PENDIENTE DE MEDIR** |
| Varias batallas simultáneas con contenedores reales; un build de bot real | **no medido** |
| Nuevos límites de `docker-compose.yml` | implementado en el PR (borrador); no integrado, no desplegado |

## Límites físicos, reserva y margen

| Concepto | Valor | Origen |
|---|---|---|
| vCPU de la VM | 6 (tipo de CPU `host`, con AVX2) | D-OP-32 |
| RAM de la VM | 6,84 GB = 6523 MiB (se usa la cifra más estricta; el kernel ve ~6778 MiB) | D-OP-32 |
| Reserva de CPU para SO y Docker | 0,5 vCPU | estimada; reposo medido ≈ 0,02 |
| Reserva de RAM para SO, Docker y caché | 768 MiB | medido: ≈ 0,5 GiB fuera de los contenedores |
| **Margen mínimo exigido** | **≥ 1024 MiB de RAM disponible** tras sumar el escenario y la reserva | criterio del operador |
| Margen de seguridad sobre el pico medido | ×1,25 por servicio; bot 64 MiB (×1,8 sobre 36); +160 MiB por batalla extra (+122 medidos × 1,25) | explícito en el YAML |

## Tabla por servicio

«Medido» = producción, 2026-11-23, con una 4v4 TDM sin emisión (reposo y pico de `memory.peak`).
«Escenario» = pico medido × 1,25 (o estimación declarada). «Techo» = límite de cgroup, el máximo teórico.
Los límites actuales suman **16,75 GiB**; los propuestos, 8,25 GiB.

| Servicio | RAM reposo medida (MiB) | RAM pico medida (MiB) | RAM escenario (MiB) | CPU reposo medida | Límite actual (CPU / RAM) | Límite propuesto = techo (CPU / RAM) | Justificación |
|---|---|---|---|---|---|---|---|
| gateway | 6 | 18 | 24 | 0 % | 0,5 / 256 MiB | 0,5 / 128 MiB | pico muy por debajo del techo |
| web | 8 | 25 | 32 | 0,2 % | 1,0 / 512 MiB | 0,5 / 256 MiB | estáticos |
| api | 125 | 207 | 260 | 0,5 % | 2,0 / 1 GiB | 2,0 / 768 MiB | CPU intacta |
| arena-engine | 101 | 123 | 154 | 0,6 % | 4,0 / 2 GiB | 1,0 / 512 MiB | el motor corre en el worker; este servicio atiende la ruta alternativa por HTTP |
| tournament-worker | 111 | **252** (4v4) | 315 | 0,4 % (155 % transitorio) | 2,0 / 1 GiB | **sin cambio** | límite y tope de heap: PR #329 |
| bot-manager | 87 | 104 | 130 | 0,4 % | 2,0 / 2 GiB | 1,0 / 512 MiB | los builds corren en otro servicio |
| bot-build-worker | 84 | 136 (reposo; un build real no medido) | 256 (estimado) | 0,1 % | 2,0 / 2 GiB | 1,0 / 1 GiB | un build a la vez |
| map-service | 70 | 95 | 119 | 0,5 % | 1,0 / 512 MiB | 0,5 / 256 MiB | |
| replay-service | 77 | 103 | 129 | 0 % | 1,0 / 512 MiB | **sin cambio** | los replays incrementales cambian su perfil: se mide antes de tocar |
| queue (Redis) | 11 | 30 | 38 | 0,5 % | 1,0 / 512 MiB | 0,5 / 384 MiB | `maxmemory` 256 MiB + reescritura del AOF |
| postgres | 66 | 83 | 104 | 1,0 % | 2,0 / 2 GiB | 2,0 / 1 GiB | base de 13 MB; techo ≈ 10× el escenario |
| backup | 23 | 81 | 102 | 0 % | 1,0 / 512 MiB | **sin cambio** | restic crece con el repositorio |
| streamer | 90 parado | 103 parado; **emitiendo con AVX2: PENDIENTE DE MEDIR** | 820 (estimación de laboratorio sin AVX2: 2,2-2,6 CPU, 0,45-0,8 GiB) | 0,2 % parado | 4,0 / 4 GiB | 3,0 / 1,5 GiB | techo = la VM entera antes (D-OP-26/29); 1,5 GiB = 1,9× la estimación |
| contenedor de bot | — | **19-36** | 64 (techo 256) | ≤ 1,4 % | 0,5 / 256 MiB / 64 PIDs | **sin cambio** (contrato) | el techo lo fija el código del bot-manager |

Fuera del escenario: `bot-runtime-template` (plantilla del perfil `bots`) y los 8 servicios del perfil
`observability` (3,6 GiB de límites en total).

Notas:

- Los límites de memoria de Compose no fijan `memswap_limit`: Docker permite hasta 2× la memoria en swap
  (`MemorySwap` = 2 × `Memory`). La VM de producción no tiene swap, así que hoy no actúa; los contenedores
  de bot sí fijan `MemorySwap = Memory`.

## Sobreasignación

| | Antes | Ahora |
|---|---|---|
| Suma de `mem_limit` de los 13 servicios en marcha | 16,75 GiB (2,63× la RAM) | 8,25 GiB (1,30× la RAM) |
| Suma de `cpus` de los 13 servicios + 9 contenedores (8 bots + 1 sandbox de build) a su techo | 28,0 (4,7× los vCPU) | 20,5 (3,4× los vCPU) |

Un límite no es una reserva: sólo se hace valer cuando el contenedor lo alcanza. Que la suma de techos
supere la RAM es deliberado (nadie alcanza su techo a la vez), pero con 2,63× ningún límite impedía agotar
la VM. El test fija el tope (`overcommit` en el YAML).

## Escenario de pico simultáneo

Emisión 1080p30 (estimada, sin AVX2) + batallas + 1 build de bot (sandbox a su techo de 256 MiB, no medido)
+ resto de servicios, con las cifras de **escenario** (pico medido × margen), la reserva de 768 MiB y 0,5 vCPU.

| Configuración | RAM usada (de 6523 MiB) | RAM disponible (mín. 1024) | CPU media (de 6) | CPU con pico transitorio del worker |
|---|---|---|---|---|
| 4v4 × 1 con emisión | 4019 | **2504** | 4,58 | 5,52 |
| 3v3 × 1 con emisión | 3891 | 2632 | 4,48 | 5,43 |
| 2v2 × 2 con emisión | 4179 | 2344 | 4,76 | 5,52 |
| 1v1 × 2 con emisión | 3923 | 2600 | 4,52 | 5,20 |
| 4v4 × 1 sin emisión | 3289 | 3234 | 1,98 | 2,92 |

El modelo admite hasta 2 batallas 4v4 simultáneas con emisión (RAM disponible 1832 MiB; CPU con pico
transitorio 5,87 de 6) y no admite 3; lo **declarado** es 1 porque sólo se ha medido una batalla a la vez
y la emisión con AVX2 no está medida.

**Peor caso teórico** (bots y streamer en su techo de cgroup, el resto en su cifra de escenario): 4v4 con
emisión = 1663 (resto) + 1536 (streamer) + 8 × 256 (bots) + 256 (sandbox) + 768 (reserva) = **6271 MiB de
6523**: cabe, con 252 MiB de holgura. Sólo se puede afirmar porque cada contenedor tiene límite propio
(el bot nace con `Memory` = `MemorySwap` = 256 MiB y el kernel mata a ese contenedor, no al host).

**Suma de todos los techos a la vez** (13 servicios + 8 bots + sandbox + reserva = 11 520 MiB): **no cabe**.
Es un riesgo documentado (RB-R1), no un caso garantizado: lo contienen el límite por contenedor, el OOM
aislado en el cgroup de cada contenedor y, para el streamer, `oom_score_adj` (en el PR #327, aún sin
integrar).

## Concurrencia máxima segura del worker

Defecto: **1** (PR #320). El presupuesto fija el máximo seguro a declarar si el operador configura un
número explícito en `TOURNAMENT_WORKER_CONCURRENCY` (el test exige «declarado ≤ lo que cabe», con margen
de RAM y con el pico transitorio de CPU):

| Tipo | Bots | Con emisión: máx. declarado | Sin emisión: máx. declarado |
|---|---|---|---|
| 1v1 | 2 | 2 | 3 |
| 2v2 | 4 | 2 | 2 |
| 3v3 | 6 | 1 | 1 |
| 4v4 | 8 | 1 | 1 |

**Validado hoy: 1 batalla a la vez** (las mediciones son de una batalla). Todo valor > 1 es teórico hasta
medir dos simultáneas con contenedores reales (fase E del plan). 3v3 y 4v4 se quedan en 1: el incidente de
heap de la CTF 4v4 (#329) y la emisión sin medir con AVX2. Ojo: `auto` (PR #320) calcula con los límites
del cgroup **del worker**, no de los bots; no se recomienda en producción sin medir.

## Qué no cabe y riesgos

| ID | Riesgo | Efecto | Mitigación |
|---|---|---|---|
| RB-R1 | Todos los techos a la vez (11,5 GiB) no caben en 6,5 GiB | un servicio o bot desbocado agota la VM antes que su vecino | límite por contenedor (`MemorySwap` = `Memory` en bots), OOM aislado en el cgroup, `oom_score_adj` del streamer (#327), margen ≥ 1 GiB en el escenario medido |
| RB-R2 | CPU de bots hostiles (hasta 4 CPU de techo) + emisión (3) > 6 vCPU | la emisión pierde fotogramas | `cpu_shares` del streamer (#327); medir fase D |
| RB-R3 | El perfil `observability` (3,6 GiB de límites) no cabe junto al escenario | no se puede activar en la misma VM | mantenerlo fuera o recortarlo (decisión del operador) |
| RB-R4 | Ruta alternativa API → arena-engine ejecuta batallas fuera de la concurrencia del worker | consumo no acotado por el presupuesto | verificar si está activa en producción; si lo está, contarla |
| RB-R5 | Sin `memswap_limit`, `MemorySwap` = 2 × `Memory` | con swap en la VM, un desbocado paginaría | fijar `memswap_limit` = `mem_limit` (decisión) |
| RB-R6 | Streamer emitiendo con AVX2 y varias batallas simultáneas sin medir | el escenario usa estimaciones para esos dos puntos | fases B, D y E del plan |
| RB-R7 | Pico transitorio de CPU del worker (155 %) al abrir o cerrar una batalla | 5 periodos estrangulados de 1891 en una 4v4 | no solapar con un build; alerta de estrangulamiento |

## Pruebas y mutantes

| Qué | Dónde | Mutantes (script) |
|---|---|---|
| Presupuesto cuadra con el compose; escenario medido + margen con ≥ 1 GiB libre; peor caso teórico parcial dentro de la VM (RB-1…RB-14) | `infrastructure/tests/resource-budget.test.ts` | `scripts/mutants-resource-budget.sh` |
| Liberación en 4v4: éxito, fallo, interrupción y bot que ignora TERM (RR-1…RR-4) | `apps/tournament-worker/src/mf-battle-teardown.test.ts` (amplía el existente) | `scripts/mutants-resource-budget.sh` |
| Streamer: reinicio, reintentos y paradas repetidas sin procesos huérfanos (SR-1…SR-3) | `apps/streamer/src/xvfb-on-demand.test.ts` (amplía el existente) | `scripts/mutants-resource-budget.sh` |

Se reutilizan el teardown único de la batalla (`battle-resources.ts`), el reaper, el ledger de
contenedores y los procesos reales de `streamer-real.test.ts`; no se duplica ninguno.

## Ausencia de recursos abandonados

Criterio de aceptación D-OP-32: tras una batalla terminada con éxito, con fallo o interrumpida no queda
**ningún contenedor de bot, ningún recurso registrado en el teardown, ningún puerto abierto del host de la
batalla ni fichero temporal del worker**; y del streamer no quedan Chromium ni ffmpeg al parar, reiniciar o
reintentar. Redes y volúmenes: el worker **no crea ninguna red ni volumen por batalla** (los bots van a la
red compartida `arena`, con `/tmp` en tmpfs y sin montajes); el test lo exige sobre la especificación de
cada lanzamiento, de modo que un cambio que introdujera un volumen por batalla pondría el test en rojo y
obligaría a añadir su limpieza.

## Plan de medición (no ejecutado)

Lo ejecuta sólo el laboratorio, con el guardián de producción en OK antes de cada fase, `nice -n 19
ionice -c3`, `flock` y una sola ejecución pesada. Script preparado y de sólo lectura:
`scripts/ops/measure-resource-scenario.sh <fase> [muestras] [intervalo]`.

| Fase | Carga | Se mide | Aceptación |
|---|---|---|---|
| A | stack en reposo | línea base | coincide con la tabla |
| B | streamer solo, 1080p30, CPU `host` con AVX2 | CPU media y pico, RSS, fotogramas perdidos, estrangulamiento | CPU < 3, RSS < 1 GiB, perdidos < 1 % |
| C | 1v1 con contenedores reales | RAM y CPU reales de 2 bots, del worker y de dockerd | bot < 256 MiB; worker < 450 MiB |
| D | 4v4 sola (ya medida sin emisión) y luego con la emisión | CPU total, margen de RAM libre, PSI, fotogramas perdidos | margen ≥ 1 GiB, PSI < 10 %, 0 estrangulamiento crítico |
| E | dos batallas simultáneas (1v1 y 2v2, luego 4v4) con y sin emisión | RAM y CPU con concurrencia 2 | margen ≥ 1 GiB; sólo entonces se sube `validated_simultaneous` |

Con los resultados se sustituyen los valores `estimated` del YAML por `measured` y se ajusta la
concurrencia declarada.

## Criterios de aceptación

Para dar V1 por cerrada (D-OP-32):

1. `resource-budget.test.ts` en verde: cada servicio declara `cpus` y memoria, el YAML coincide con el
   compose y el escenario cabe en 6 vCPU y 6,84 GB con la reserva del sistema.
2. Pruebas de liberación en verde (4v4 y streamer) con su mutante calibrado.
3. Medición del laboratorio de las fases B, C y D con el resultado dentro de la tabla de aceptación.
4. Producción verificada tras el despliegue: 0 contenedores de bot, 0 Chromium/ffmpeg huérfanos con la
   plataforma en reposo y `docker inspect` con los límites propuestos.

## Documentación relacionada

- [worker-concurrency.md](worker-concurrency.md) · concurrencia del worker.
- [streaming.md](streaming.md) · emisión y límites del streamer.
- [docker.md](docker.md) · servicios, perfiles y volúmenes.
- [observability.md](observability.md) · métricas del worker y del streamer.
- [../roadmap/v1-roadmap.md](../roadmap/v1-roadmap.md) · contrato de cierre de V1.

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Suma de límites actuales 16,75 GiB | RUNTIME_VERIFIED (2026-11-22) | `docker inspect` de los 13 contenedores |
| Reposo y picos de la tabla | RUNTIME_VERIFIED (2026-11-22) | `docker stats` y `memory.peak` del cgroup, 21 muestras |
| Bots: CPU media 0,010 (mediana), 0,021 (máx.) | DATA_VERIFIED | `participants.cpu_ms` de 70 batallas con contenedores, cota inferior |
| 4v4 TDM sin emisión: VM 1617 MiB de media, 1656 de pico, 5122 MiB disponibles mínimos; worker 252 MiB y 155 % de CPU; bots 19-36 MiB | RUNTIME_VERIFIED (2026-11-23) | medición en producción, sólo lectura, sin emisión |
| El escenario cabe con los límites propuestos | TEST (en el PR) | `infrastructure/tests/resource-budget.test.ts` |
| Liberación 4v4 y streamer | TEST (en el PR) | `mf-battle-teardown.test.ts`, `xvfb-on-demand.test.ts` |
| CPU y RAM del streamer emitiendo con AVX2; dos batallas simultáneas; un build real | NO MEDIDO | plan de medición |
