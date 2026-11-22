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

Resultado, en una frase: **con los límites propuestos el escenario cabe en 6 vCPU y 6,84 GB tomando los
bots a su techo de memoria**, pero con poco margen de RAM (≈150 MiB en la peor combinación, una 4v4 con
emisión) y **sin garantía de CPU frente a bots hostiles** (que pueden llegar a su techo de 0,5 CPU). Lo
que no está medido con contenedores reales está marcado como estimado y se deja como plan de medición
para el laboratorio.

## Índice

- [Estado de cada afirmación](#estado-de-cada-afirmación)
- [Límites físicos y reserva](#límites-físicos-y-reserva)
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
| Reposo y pico observado de cada servicio (21 muestras en ~8 min, sin batallas ni emisión) | medido en producción, sólo lectura |
| Límites actuales de cada contenedor (`NanoCpus`, `Memory`) | medido (`docker inspect`) |
| CPU media de los bots (170 bots, 70 batallas con contenedores) | medido (`participants.cpu_ms`, cota inferior, bots de ejemplo) |
| Emisión 1080p30: 2,2-2,6 CPU medias, RSS 0,45-0,8 GiB | medido en producción con CPU sin AVX2; **con AVX2, pendiente de medir** |
| Coste del motor por batalla (1v1…4v4) | medido en proceso, sin contenedores (informe del PR #320) |
| RAM de un bot real en una batalla, CPU del worker con contenedores reales | **estimado**: plan de medición |
| Nuevos límites de `docker-compose.yml` | implementado en el PR (borrador); no integrado, no desplegado |

## Límites físicos y reserva

| Concepto | Valor | Origen |
|---|---|---|
| vCPU de la VM | 6 (tipo de CPU `host`, con AVX2) | D-OP-32 |
| RAM de la VM | 6,84 GB = 6523 MiB (se usa la cifra más estricta; el kernel ve ~6778 MiB) | D-OP-32 |
| Reserva de CPU para SO y Docker | 0,5 vCPU | estimada; reposo medido ≈ 0,02 |
| Reserva de RAM para SO, Docker y caché | 1024 MiB | medido: el uso fuera de los contenedores ronda 0,5 GiB (kernel, dockerd, containerd, systemd); se duplica por los picos de dockerd al crear contenedores de bot |

## Tabla por servicio

Medido el 22-11-2026 en producción, con la plataforma en reposo (sin batallas, emisión parada).
«Pico medido» es el máximo de `memory.peak` del cgroup desde el arranque del contenedor. «Pico esperado»
es lo que se suma en el escenario. Límite actual = `docker inspect` de producción (coincide con el
compose de `main`). La suma de los límites actuales es **16,75 GiB**.

| Servicio | RAM reposo (MiB) | RAM pico medido (MiB) | RAM pico esperado (MiB) | CPU reposo (media) | CPU esperada | Límite actual (CPU / RAM) | Límite propuesto (CPU / RAM) | Justificación |
|---|---|---|---|---|---|---|---|---|
| gateway | 6 | 18 | 32 | 0,00 % | 0,05 | 0,5 / 256 MiB | 0,5 / 128 MiB | pico muy por debajo del límite (14×) |
| web | 8 | 25 | 32 | 0,2 % | 0,02 | 1,0 / 512 MiB | 0,5 / 256 MiB | servidor de estáticos |
| api | 101 | 207 | 300 | 0,03 % | 0,2 | 2,0 / 1 GiB | 2,0 / 768 MiB | CPU intacta; RAM con 2,5× sobre el pico esperado |
| arena-engine | 81 | 123 | 128 | 0,2 % (máx. 3,3 %) | 0,05 | 4,0 / 2 GiB | 1,0 / 512 MiB | el motor del worker corre en proceso; este servicio atiende la ruta alternativa por HTTP; una 4v4 ocupa ≈ 232 MiB |
| tournament-worker | 92 | 130 | 600 | 0,19 % | 0,05 | 2,0 / 1 GiB | **2,0 / 1 GiB (sin cambio)** | límite y tope de heap los fija el PR #329; 1 batalla 4v4 ≈ 92 + 232 + búferes |
| bot-manager | 69 | 104 | 128 | 0,00 % | 0,05 | 2,0 / 2 GiB | 1,0 / 512 MiB | control y proxy de Docker; los builds corren en otro servicio |
| bot-build-worker | 84 | 136 | 256 | 0,08 % | 0,15 | 2,0 / 2 GiB | 1,0 / 1 GiB | un build a la vez; su sandbox es un contenedor aparte con el techo del bot |
| map-service | 70 | 95 | 128 | 0,5 % | 0,02 | 1,0 / 512 MiB | 0,5 / 256 MiB | |
| replay-service | 77 | 103 | 192 | 0,00 % | 0,05 | 1,0 / 512 MiB | **1,0 / 512 MiB (sin cambio)** | los replays incrementales (PR de replays) cambian su perfil: no se toca hasta medirlos |
| queue (Redis) | 11 | 30 | 48 | 0,48 % | 0,05 | 1,0 / 512 MiB | 0,5 / 384 MiB | `maxmemory` 256 MiB + reescritura del AOF |
| postgres | 47 | 77 | 256 | 0,28 % | 0,2 | 2,0 / 2 GiB | 2,0 / 1 GiB | base de datos de 13 MB; 1 GiB cubre 4× el pico esperado |
| backup | 23 | 81 | 128 | 0,00 % | 0,15 | 1,0 / 512 MiB | **1,0 / 512 MiB (sin cambio)** | restic sube de RAM con el tamaño del repositorio: se mantiene |
| streamer | 39 | 103 en reposo; 450-820 emitiendo | 820 | 0,1 % reposo; 2,2-2,6 emitiendo (sin AVX2) | 2,6 | 4,0 / 4 GiB | 3,0 / 1,5 GiB | 4 CPU = el techo era la VM entera (D-OP-26/29); 1,5 GiB = 1,9× el RSS máximo medido; se mantienen `pids` 512 y `shm_size` |
| contenedor de bot (por bot) | — | no medido | 256 (techo) | 0,010 mediana, 0,021 máx. medidos | 0,05 (planificación) | 0,5 / 256 MiB / 64 PIDs (`DEFAULT_LIMITS`) | **sin cambio** (contrato del producto) | techo = código del bot-manager; el proxy de Docker exige límites y rechaza más de 4× estos valores |

Fuera del escenario (no se arrancan en producción hoy y mantienen su límite): `bot-runtime-template`
(plantilla del perfil `bots`), y los 8 servicios del perfil `observability` (Prometheus, Alertmanager,
Grafana, Loki, Promtail, cAdvisor, node-exporter, postgres-exporter; 3,6 GiB de límites en total).

Notas:

- Las 21 muestras se tomaron con la
  producción sin batallas y sin emisión (guardián de producción en OK antes de empezar).
- Los límites de memoria de Compose no fijan `memswap_limit`: Docker permite hasta 2× la memoria en swap
  (`MemorySwap` = 2 × `Memory` en `docker inspect`). La VM de producción no tiene swap, así que hoy no
  actúa; los contenedores de bot sí fijan `MemorySwap = Memory`. Ver las decisiones del informe.
- La CPU del streamer con AVX2 **no está medida** (la medición histórica es con la CPU virtual `kvm64`).

## Sobreasignación

| | Antes | Ahora |
|---|---|---|
| Suma de `mem_limit` de los 13 servicios en marcha | 16,75 GiB (2,63× la RAM) | 8,25 GiB (1,30× la RAM) |
| Suma de `cpus` de los 13 servicios + 9 contenedores (8 bots + 1 sandbox de build) a su techo | 28,0 (4,7× los vCPU) | 20,5 (3,4× los vCPU) |

Un límite no es una reserva: el kernel sólo lo hace valer cuando el contenedor lo alcanza. La suma de
techos de RAM se mantiene por encima de la memoria física a propósito (los servicios no alcanzan su pico a
la vez), pero un 1,3× deja que un único contenedor desbocado se contenga con su OOM de cgroup antes de que
el kernel mate al azar. Con 2,63× un conjunto de contenedores podía agotar la VM sin que ningún límite
saltara. El test fija el tope (`overcommit` en el YAML) para que crezca sólo a conciencia.

## Escenario de pico simultáneo

Emisión 1080p30 + batallas con contenedores reales + 1 build de bot + el resto de servicios, con la
**memoria de los bots a su techo** (256 MiB cada uno, el peor caso que permite el código) y la CPU
esperada (bots a 0,05 CPU, 2,4× el máximo medido).

| Configuración | RAM (de 6523 MiB) | CPU (de 6) | ¿Cabe? |
|---|---|---|---|
| 4v4 × 1 con emisión | 6376 (margen 147) | 5,19 (margen 0,81) | sí, con margen estrecho de RAM |
| 3v3 × 1 con emisión | 5864 | 5,09 | sí |
| 2v2 × 1 con emisión | 5352 | 4,99 | sí |
| 1v1 × 2 con emisión | 5602 | 5,14 | sí |
| 4v4 × 1 sin emisión | 5595 | 2,59 | sí |
| 4v4 × 2 con emisión | 8674 | — | **no** |

Composición del caso crítico (4v4 con emisión): servicios en marcha 3048 MiB (streamer 820) + 8 bots × 256
= 2048 + sandbox de build 256 + reserva 1024 = 6376 MiB. CPU: servicios 3,64 (streamer 2,6) + motor 0,15 +
8 bots × 0,05 + sandbox de build 0,5 + reserva 0,5 = 5,19.

**Lo que NO garantiza este cálculo:**

- **CPU en el peor caso.** Un bot hostil puede usar hasta su techo (0,5). Ocho bots hostiles = 4 CPU, más
  la emisión (techo 3): 7 de 6 disponibles. La defensa es la prioridad relativa (`cpu_shares` del streamer
  en el PR #327: bajo contención, el streamer cede) y el techo de cada contenedor; la emisión puede perder
  fotogramas antes que la plataforma dejar de responder. Es una **política** a validar con medición.
- **RAM de bots reales.** Se toma el techo de 256 MiB. Si un bot real usa menos (lo esperable), el margen
  crece; si el runtime del lenguaje es mayor, el kernel mata al bot, no al host.
- **CPU del streamer con AVX2** (2,6 con `kvm64`): puede bajar, no está medido.

## Concurrencia máxima segura del worker

Defecto: **1** (PR #320). El presupuesto fija el máximo seguro a declarar si el operador configura un
número explícito en `TOURNAMENT_WORKER_CONCURRENCY` (el test exige «declarado ≤ lo que cabe»):

| Tipo | Bots | Con emisión: máx. declarado (cabe hasta) | Sin emisión: máx. declarado (cabe hasta) |
|---|---|---|---|
| 1v1 | 2 | 2 (3) | 3 (4) |
| 2v2 | 4 | 1 (1) | 2 (2) |
| 3v3 | 6 | 1 (1) | 1 (1) |
| 4v4 | 8 | 1 (1) | 1 (1) |

«Cabe hasta» es el resultado del modelo con los bots a su techo de memoria; lo declarado queda por debajo
en 1v1 hasta medir con contenedores reales. La concurrencia es **por tipo de batalla**; una mezcla de
tipos se limita por el coste del conjunto y nunca por encima de 1 si hay una 3v3 o 4v4 con emisión. Con
CTF 4v4 el tope de heap del worker (PR #329) y la prórroga acotada son condición para esta cifra.

Ojo: `auto` (PR #320) calcula con los límites del cgroup **del worker**, no de los bots (que son
hermanos del worker, fuera de su cgroup); por eso no se recomienda para producción sin medir.

## Qué no cabe y riesgos

| ID | Riesgo | Efecto | Mitigación |
|---|---|---|---|
| RB-R1 | 4v4 con emisión deja ≈ 150 MiB de margen con los bots a su techo | un pico extra (backup + build + 4v4) puede forzar OOM de algún contenedor, no del host | concurrencia 1 con emisión; que el backup y los builds no coincidan con una 4v4 emitida (operación); medir la RAM real de un bot |
| RB-R2 | CPU de bots hostiles + emisión > 6 vCPU | la emisión pierde fotogramas; la plataforma responde por `cpu_shares` | PR #327 (`cpu_shares`); alerta de fotogramas perdidos |
| RB-R3 | el perfil `observability` (3,6 GiB de límites) no cabe junto al escenario | no se puede arrancar en la misma VM sin recortar | mantenerlo fuera de la VM de producción o decidir un recorte (decisión del operador) |
| RB-R4 | ruta alternativa API → arena-engine ejecuta batallas por fuera de la concurrencia del worker | consumo no acotado por el presupuesto del worker | verificar si está activa en producción; si lo está, contarla en el cálculo |
| RB-R5 | sin `memswap_limit` en Compose, `MemorySwap` = 2 × `Memory` | con swap en la VM un contenedor desbocado paginaría | fijar `memswap_limit` = `mem_limit` (decisión del operador) |

## Pruebas y mutantes

| Qué | Dónde | Mutantes (script) |
|---|---|---|
| Presupuesto cuadra con el compose y el escenario cabe (RB-1…RB-12) | `infrastructure/tests/resource-budget.test.ts` | `scripts/mutants-resource-budget.sh` |
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
| D | 4v4 (8 bots) sola y luego con la emisión | RAM de 8 bots, CPU total, margen de RAM libre, PSI | margen ≥ 500 MiB, PSI < 10 %, 0 estrangulamiento crítico |

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
| El escenario cabe con los límites propuestos | TEST (en el PR) | `infrastructure/tests/resource-budget.test.ts` |
| Liberación 4v4 y streamer | TEST (en el PR) | `mf-battle-teardown.test.ts`, `xvfb-on-demand.test.ts` |
| CPU del streamer con AVX2, RAM de un bot real | NO MEDIDO | plan de medición |
