# Roadmap de V1 0.5.0

## Resumen

Clasificación de **todas** las funcionalidades conocidas en cuatro cajones: **V1 0.5.0** (lo que
entra en la versión), **OLA 2** (endurecimiento y residuos que no bloquean V1), **versión futura** y
**defectos y exclusiones** (lo que existe pero falla, o lo que se deja fuera a propósito). Cada fila
enlaza su código, sus tests y, cuando existen, su issue o su PR.

Este documento clasifica; no mide el estado de despliegue. Para saber qué está implementado,
integrado, probado, validado en laboratorio, desplegado y verificado en producción, lee
[current-status.md](current-status.md). Los defectos con identificador viven en
[technical-debt.md](technical-debt.md); los síntomas en [known-issues.md](known-issues.md).

Base: `main` en `80f4952` (2026-11-20). Referencias de PR e issues: `https://github.com/pjclavero/s9-ai-arena/pull/<n>` y `…/issues/<n>`.

## Índice

- [Cómo se clasifica](#cómo-se-clasifica)
- [V1 0.5.0 — en main](#v1-050--en-main)
- [V1 0.5.0 — en PR pendiente de merge](#v1-050--en-pr-pendiente-de-merge)
- [OLA 2](#ola-2)
- [Versión futura](#versión-futura)
- [Defectos y exclusiones de V1](#defectos-y-exclusiones-de-v1)
- [Streaming V2 y Broadcast Manager](#streaming-v2-y-broadcast-manager)
- [Verificación](#verificación)

## Contrato operativo de cierre V1 — actualización 2026-11-22

> **Fuente y vigencia:** decisiones del operador y reportes de agentes del 22-11-2026; el estado por PR se debe volver a contrastar con GitHub antes de actuar. Esta sección es el **tablero de trabajo del cierre**, no una afirmación de que sus tareas estén integradas, desplegadas o verificadas. Las tablas históricas inferiores describen principalmente la revisión del 20-11 y deben reconciliarse al terminar los PR.

### Decisión de alcance: cerrar primero lo existente (22-11-2026)

**Mandato del operador: congelación funcional para V1.** Antes de ampliar nada, terminar lo que ya existe y conseguir que funcione de manera fiable con el hardware disponible. **Después de publicar y verificar V1**, retomar mejoras a medio implementar y nuevas funcionalidades; a continuación acometer la optimización general de consumos con mediciones. No añadir nuevos frentes que retrasen la salida.

**Límites físicos no ampliables en este ciclo:** hipervisor Proxmox con 28 CPU lógicas/núcleos reportados y 32 GB RAM; VM108 con 6 vCPU tipo `host` y **6,84 GB RAM**. No planear compras ni ampliaciones. El sistema debe operar dentro de esos límites, incluyendo emisión YouTube 1080p30 y batallas simultáneas dentro de la concurrencia realmente validada.

**Orden de ejecución obligatorio:**

1. **Cerrar V1 con el producto actual:** corregir defectos que impiden funcionar (worker/CTF, replays que agotan RAM, datos privados, backup/restore, flujo de cuentas, estabilidad del streaming), terminar los PR ya abiertos que formen parte del alcance de salida y verificar que la administración ordinaria necesaria es operable desde la web. Los mínimos técnicos indispensables para estabilidad y espacio (almacenamiento incremental, cuotas, limpieza, exportación/borrado comprometidos) **sí forman parte de cerrar lo existente**, no son una ampliación del producto.
2. **Validar y publicar V1:** pruebas reales y completas del alcance anunciado, reinicios, streaming simultáneo 1080p30, recuperación, limpieza de residuos de pruebas, documentación; despliegue con autorización explícita. Modos y formatos no validados se **ocultan y rechazan en web/API** y se documentan como excluidos, en vez de prometer que funcionan.
3. **Después de V1:** finalizar características parcialmente desarrolladas o aplazadas (incluidos extras visuales, formatos nuevos, Broadcast Manager, matchmaking, SDK adicionales, nuevas piezas y sensores), sólo tras priorización.
4. **Optimización general posterior:** perfilado global, reducción sistemática de CPU/RAM/disco y mejora de rendimiento. **Excepción:** fugas, OOM, residuos, falta de limpieza, cuotas, límites de recursos y consumos que bloqueen el uso fiable **deben corregirse ahora** como estabilidad de V1.

**Disciplina de recursos para pruebas y runtime:** una prueba pesada cada vez cuando corresponda, límites de memoria/CPU/duración, procesos y contenedores liberados siempre al salir (también por error), limpiar temporales y navegadores, medir consumo antes/durante/después y no confundir swap ocupada con presión activa. No bloquear globalmente por una cifra aislada sin diagnóstico. No borrar datos persistentes ni operar sobre producción sin permiso.

**Seguimiento:** todo requisito nuevo se clasifica como (a) imprescindible para que funcione V1 o (b) mejora posterior; el coordinador no abre PR de nuevas prestaciones V1 sin demostrar que bloquean el contrato de salida. La lista de 12 áreas más abajo es **inventario de aceptación**, no una orden de construir funciones adicionales que no sean necesarias para operar la V1 existente.

### Criterio de lanzamiento

- **V1 0.5.0 no se declara cerrada** hasta que los bloques obligatorios de abajo estén probados de punta a punta, documentados, integrados en `main`, desplegados en una ventana autorizada y verificados en VM108.
- **Administración operativa desde la web:** después de la instalación inicial, un administrador debe gestionar el juego y sus servicios normales desde la web. No depender de SSH, Docker CLI ni SQL para operaciones corrientes. Proxmox y recuperación excepcional del SO quedan fuera del panel.
- **Datos previos a V1 son de desarrollo:** no se exige compatibilidad con formatos antiguos de replay; sí se exige preservar configuración, credenciales, secretos y posibilidad de restaurar una copia válida antes de cualquier limpieza. Ningún borrado real está autorizado por esta entrada.
- **Separar estados:** propuesta / en desarrollo / PR / integrado / probado / validado en laboratorio / desplegado / verificado. No llamar «hecho» a un PR que aún no se haya validado y desplegado.

### Avances comunicados (pendientes de cierre funcional)

| Área | Estado reportado el 22-11 | Evidencia / falta |
|---|---|---|
| VM108: 6 vCPU, CPU `host` con AVX2 y reinicio | **Verificado por agente** | 13/13 servicios healthy, API/web, BD y worker arrancan; código desplegado sigue en `8f380eb`; smoke funcional pospuesto por `prodguard=PRESSURE`. Informe local `~/s9-release-0.5/vm108-reinicio/INFORME-ANTES-DESPUES.md` |
| CTF afectadas por OOM | **Contenidas, defecto P0 abierto** | Cuatro `failed/infrastructure`, cuatro jobs `needs_review`, cero batallas activas; mantener bloqueo de nuevas CTF hasta corregir y probar |
| Integración previa | **Reportada en main** | #309, #314, #313, #316, #315, #311, #312, #317, #318, #320; HEAD reportado `7397964`. Confirmar HEAD y CI antes de seguir |
| Streamer #327 | **PR en curso, no desplegado** | `cpus: 3.0`, prioridad baja; pendiente CI y medir YouTube real 1080p30 con batallas simultáneas |
| #323 organizer docs | **CI pendiente de resolver** | Fallo intermitente informado en build-images del streamer; verificar CI antes de merge |

### Obligatorio antes de declarar V1 cerrada

| ID | Bloque | Criterios de aceptación | Estado de trabajo |
|---|---|---|---|
| V1-01 | **Worker y CTF P0** | Reintentos acotados, leases vencidas saneadas, no duplicar trabajos, limpieza de bot containers, límites de memoria/concurrencia; CTF 4v4 larga hasta límite técnico sin OOM ni bucles; ninguna victoria/Elo ficticios por fallo | **En desarrollo / no validado** |
| V1-02 | **Replay incremental integral** | Captura a disco con búfer RAM acotado, compresión, integridad, manejo de interrupción y errores; API, estadísticas y visor sin cargar enteramente replays enormes; pruebas deterministas, exportables y reproducción real | **Diseño completado; implementación pendiente** |
| V1-03 | **Cuotas y mantenimiento del disco** | Volumen configurable, cuotas, espacio de reserva, rotación de logs/temporales, retención y limpieza programada desde web, simulación antes de borrar, alertas y protección contra disco lleno a mitad de partida | **Pendiente** |
| V1-04 | **Gestión web de replays** | Listar, visualizar tamaño/uso, reproducir, descargar/exportar portable, proteger y borrar con autorización, confirmación y auditoría; borrar replay no borra resultados competitivos por accidente | **Pendiente** |
| V1-05 | **Administración completa desde web** | Usuarios, roles y recuperación; batallas y jobs bloqueados; concurrencia y límites; backups/verificación/restore; streaming y credenciales; almacenamiento, retención, limpieza, diagnósticos y alertas. API administrativa sin shell arbitrario; pruebas E2E de navegador | **Parcial; matriz funcional por verificar** |
| V1-06 | **Streaming V1 y espectador** | Resolver imagen blanca YouTube (#256), emisión **real** a 1080p30 sin pérdida significativa de frames en carga compatible con VM108 de 6 vCPU; probar #327 con 3 CPU y bajo prioridad; control web, protección de credenciales, recuperación y señal de fallo; gate de acceso público sólo si habilitado | **Parcial; prueba real pendiente** |
| V1-07 | **Juego y torneos incluidos en V1** | Recorrido jugador y admin, build sandbox, equipos 2v2/3v3/4v4, modos publicados, torneo round-robin/eliminación/suizo y Elo verificados; casos de bye 0 puntos, fallos y cancelación. Liga/doble eliminación: E2E si se ofrecen como V1, de lo contrario ocultar/excluir explícitamente. CTF/zona en torneos fuera de V1 y rechazados en API y web | **Parcial; B3, bye y validaciones pendientes** |
| V1-08 | **Seguridad y cuentas** | Resolver filtraciones de privados (#322 error 409 y otras expuestas), permisos `organizer`, permisos de ejecución, recuperación de cuentas usable desde web (B5/#319), sesiones y 2FA según alcance explícito; revisar imágenes con HIGH/CRITICAL y privilegios/secrets/red de bots | **Parcial; P1 conocidos abiertos por verificar** |
| V1-09 | **Backup, restauración y observabilidad** | Backup/restore verificables del nuevo replay, sin filtro erróneo para oficiales antiguos mientras existan; configurar y operar desde web, snapshot recuperable, alertas efectivas de backup, worker, disco, API y streamer; verificar reinicio limpio y drift/runtime | **Parcial; #321/#324 y alertas por verificar** |
| V1-10 | **Instalación y recuperación** | Instalación desde cero, primer admin sin SQL (#319), credenciales, configuración inicial del servicio, persistencia tras reinicio, smoke, rollback, backup restaurable; no requiere consola en operación ordinaria | **Parcial** |
| V1-11 | **Limpieza pre-release** | Inventario read-only de replays, batallas/torneos de prueba, backups antiguos, logs, temporales, caché/imágenes/volúmenes Docker; informe de tamaños/riesgos; ejecución sólo tras autorización; reset competitivo coherente y restauración mínima preservada | **Inventario y plan pendientes, borrado NO autorizado** |
| V1-12 | **Documentación, CI y contrato de salida** | Unificar README, manual de jugador, administración, operaciones, seguridad, roadmap, estado y exclusiones; tests unitarios/integración/navegador y CI de `main` verdes; despliegue final con verificación real y matriz de evidencias | **Pendiente de cierre** |

### Integración y dependencias de PR

| Referencia | Trabajo | Pendiente conocido / condición |
|---|---|---|
| **P0 worker** | Reintentos, leases, memoria, contenedores | PR correctivo, revisión independiente y pruebas; no exponer CTF hasta validación |
| **Bloqueo temporal CTF** | Impedir nuevas CTF de práctica en API y web | Mantener hasta que P0 y replay incremental estén verificados |
| **#319 / B5** | Bootstrap admin, contraseñas y recuperación | Test de reset con contraseña corta, mutantes y recuperación usable |
| **#321** | Backup/restauración de replays | Comprobar corrección del filtro de oficiales >180 días y adaptar al formato nuevo sin trabajo duplicado |
| **#322 / B4** | Presupuesto y munición | Cerrar P1 del error 409 (no filtrar bot privado de terceros), revalidar mutantes |
| **#323** | Documentación de organizer | Revalidar CI |
| **#324** | Avisos del nightly | Completar evidencia de laboratorio |
| **#327** | Streamer 3 CPU | CI y mediciones de 1080p30 real sin afectar a worker/API |
| **#328** | Bye justo | Prettier, comprobar regresiones y CI; 0 puntos en suizo y sin Elo/victoria |
| **B3** | Excluir modos no jugables de torneos V1 | Rechazo tanto API como web, sin anunciar CTF/zona en torneos |
| **#326** | Sensores, bandera/portador y hardware | **Futuro, no bloquea V1** |

### Orden de ejecución y puertas

1. Recuperar margen del hipervisor; repetir `prodguard` y terminar smoke de VM108. Sin pruebas de carga bajo `PRESSURE`.
2. Corregir P0 del worker y contener CTF en API y web.
3. Implementar escritura y lectura incremental de replays; validar límites de memoria y disco, reintentos, recuperación y CTF 4v4.
4. Añadir cuotas, programación de retención desde **Administración → Configuración**, exportación, borrado, backups y limpieza segura.
5. Cerrar P1 de seguridad, cuentas, panel de administración y PR existentes; integrar secuencialmente con CI y revisión.
6. Medir emisión real 1080p30 con partidas en paralelo; resolver el defecto de imagen y validar prioridad del streamer.
7. Probar flujos completos desde navegador, simulacros backup/restore, apagado/reinicio y alertas.
8. Inventariar/autorizar limpieza de datos de desarrollo y backups redundantes; reset previo a V1; documentar qué se conserva.
9. Desplegar la nueva versión **sólo con autorización del operador**, verificar y publicar matriz de aceptación V1.

### Después de V1 (no bloquea cierre)

Streaming V2/Broadcast Manager, matchmaking/prepare-battle/auto-run, SDK .NET/Java, nuevas piezas/armas/sensores/chasis/energía, fases visuales R16.4–R16.8 y mejoras avanzadas de torneos no ofertadas en V1. Una función sin validación E2E no puede anunciarse como disponible.

### Seguimiento

Mantener esta sección actualizada por cada PR integrado y por cada prueba relevante, con fecha, commit, CI, evidencia, estado de despliegue y bloqueantes. Antes de publicar V1, reconciliar las secciones históricas de este archivo, `current-status.md`, `pending-features.md` y `known-issues.md`; no mantener dos «fuentes únicas» contradictorias.

## Cómo se clasifica

| Cajón | Criterio |
|---|---|
| **V1 0.5.0** | Funciona de punta a punta con una prueba citada: «CI» = CI obligatoria de `main` (navegador y contenedores reales); «lab» = ciclo completo con API, base de datos y motor reales, pero con bots simulados en proceso. |
| **OLA 2** | Endurecimiento y residuos de la plataforma. La OLA 2 del motor ya está integrada (motor 0.5.0, [ADR-024](../adr/ADR-024-motor-0-5-0-ola2.md)); aquí van sus P3 abiertos y lo que depende de ella. No bloquea V1. |
| **Versión futura** | No existe en el código de `main` o existe sólo como diseño. |
| **Defecto / exclusión** | Existe y falla, o se deja fuera de V1 por decisión del operador (D-OP-2) y **no se anuncia como funcional**. |

## V1 0.5.0 — en main

| Funcionalidad | Código | Tests y pruebas | Referencias |
|---|---|---|---|
| Registro, inicio de sesión, refresh rotatorio, roles, auditoría | `apps/api/src/routes/auth.ts` | `rbac-matrix.test.ts`, `conformance.test.ts`; recorrido en CI | — |
| Crear bot, versionar (inmutable), clonar, diff, historial | `apps/api/src/routes/bots.ts` | `tests/browser/specs/versioning.spec.ts`; CI | — |
| Editor de loadout y validación (presupuesto, masa, energía, arma↔munición) | `packages/module-catalog`; catálogo generado `docs/user/equipment-catalog.md` | `equipment-doc.test.ts`, `apps/tournament-worker/src/elig-execution.test.ts` | — |
| Build en sandbox real y publicación de versiones | `apps/bot-manager`, proxy de Docker | `functional-e2e / golden` y `docker-e2e` (CI) | — |
| Elegibilidad de versiones (publicada ≠ elegible) | `apps/api/src/services/version-eligibility.ts` | `battle-selector-explains-ineligible-bot.spec.ts` | — |
| Visibilidad de bot y de código; publicación masiva del equipo | `apps/api/src/routes/bots.ts`, `teams.ts` | `ux255-bots-equipos-batallas.spec.ts`, `vis-broadcast.spec.ts` | — |
| Equipos (crear, miembros por correo, bots de equipo) | `apps/api/src/routes/teams.ts` | `tests/browser/specs/teams.spec.ts` | — |
| Batallas de práctica 1v1 y por equipos hasta 4v4 | `apps/api/src/routes/battles.ts` | `team-battle-4v4.spec.ts` y recorrido (CI) | — |
| Reglas de batalla (presets, personalizado, clásico; copia inmutable) | `packages/game-rules` | `rules-040-api.test.ts`, `rules-battles.spec.ts` | [ADR-021](../adr/ADR-021-reglas-de-batalla-presets-y-copia.md) |
| Motor determinista 0.5.0 y replays v2 verificables | `apps/arena-engine` | `apps/arena-engine/tests`, `regression-battles` (CI) | [ADR-024](../adr/ADR-024-motor-0-5-0-ola2.md) |
| Visor en directo y reproductor de replays (zoom, minimapa, móvil) | `apps/web` | `viewer.spec.ts`, `replay.spec.ts` (CI) | — |
| Política única de acceso a replays y batallas (`404` uniforme) | `apps/api/src/replay-access.ts`, `battle-access.ts` | tests de acceso | — |
| Torneos todos contra todos, eliminación simple y suizo, de punta a punta | `apps/tournament-worker/src` (`scheduler.ts`, `results.ts`) | `tournament-e2e.test.ts`, `tournament-lifecycle-failed.test.ts`; ciclo completo en lab: PR #317 | [#317](https://github.com/pjclavero/s9-ai-arena/pull/317) |
| **Torneos Team Deathmatch por equipos 2v2, 3v3 y 4v4** (inscripción de equipos completos, consentimiento de dueños, selección en la web) | `apps/api/src/routes/tournaments.ts`, `apps/web/src/pages/TournamentsPage.tsx` | `team-enrollment.test.ts`, `team4v4-runner.test.ts`; ciclo completo en lab: PR #317 | #287, #290, #309 (mergeado), [#310](https://github.com/pjclavero/s9-ai-arena/issues/310) (endurecer la API) |
| Cancelar torneo; cerrar o cancelar sólo su dueño o el staff; mínimo de 2 inscritos | `apps/api/src/services/tournament-access.ts` | `tournament-cancel.test.ts`, `tournament-action-ownership.test.ts` | #288, #289, #291 |
| Una batalla `failed` ya no bloquea el cierre del torneo | `apps/tournament-worker/src/results.ts` (`settleMatch`) | `tournament-lifecycle-failed.test.ts` | #299, #301 |
| Ranking Elo por modo y temporada; V-D-E por enfrentamientos | `apps/tournament-worker/src/ratings.ts`, `season.ts`, `standings.ts` | `ratings.test.ts`, `standings-season.test.ts` | — |
| Mapas: importar, generar, editor visual, publicar | `apps/map-service` (como librería), `apps/api/src/routes/maps.ts` | `map-editor.spec.ts`, `maps.spec.ts` | — |
| Centro de Ayuda y onboarding | Ayuda generada desde `docs/user` | `eq3-help-center.spec.ts`, `onboarding.spec.ts` | — |
| Copias restic, restauración y verificación | `infrastructure/backup` | `e2e-backup-sftp`, `e2e-restore-sftp-bootstrap` (CI) | — |
| Export e import portable de bots y equipos | `scripts/portable/portable.mjs` | `portable-roundtrip.test.ts` | #300 |
| `init-secrets.sh` sin seguimiento de enlaces y `S9_SECRETS_ADOPT` | `infrastructure/scripts/init-secrets.sh` | `infrastructure/tests/init-secrets-nofollow.test.ts` | #169 |
| Ajustes de runtime del acceso público (la fila de base de datos manda; el entorno sólo la siembra) | `apps/api/src/runtime-settings.ts`, `routes/runtime-settings.ts` | `mg-runtime-settings.test.ts`, `mg-runtime-failclosed.test.ts` | migración 021 |
| Espectador y replays públicos (capacidades, **apagadas por defecto**) | `apps/api/src/public-spectate.ts`, `public-replays.ts` | `vis-broadcast.spec.ts` | activarlas es decisión del operador |
| Administración de streaming y relé RTMPS con credenciales selladas (sin YouTube real) | `apps/streamer/src`, `apps/api/src/routes/streaming.ts`, `apps/web/src/pages/BroadcastPage.tsx` | `eq5b-streaming-admin.spec.ts`, `streamer-real.test.ts`, `r3-relay-break.test.ts` | [ADR-023](../adr/ADR-023-streaming-rele-rtmp-y-credenciales-selladas.md), #274, #278, #279, #282, #284 |
| OLA 2 del motor integrada (daño, alcance real, HE contra muro, rearme) | `apps/arena-engine/src` | `g1-he-wall-los.test.ts`, `packages/module-catalog/range-characterization.test.ts` | #272, #273, #276, #280, #281, #285, #293, #294 |

## V1 0.5.0 — en PR pendiente de merge

Sin merge no hay V1 con estas piezas. Ninguna está en `main` hoy.

| Funcionalidad | PR | Estado a 2026-11-20 |
|---|---|---|
| Cambio de contraseña del usuario autenticado (API y «Mi cuenta») | [#315](https://github.com/pjclavero/s9-ai-arena/pull/315) | borrador, revisión CONFORME; falta autorización de merge |
| `GET /bots?ownerId` valida UUID (400 en vez de 500) | [#313](https://github.com/pjclavero/s9-ai-arena/pull/313) (cierra #305) | borrador, CONFORME |
| `listBots` completa la página | [#316](https://github.com/pjclavero/s9-ai-arena/pull/316) (TD-068) | borrador, CONFORME con observaciones |
| `nightly` con userns y ffmpeg reales | [#314](https://github.com/pjclavero/s9-ai-arena/pull/314) (TD-019) | borrador, CONFORME |
| Acotar el rol `organizer` a sus torneos | [#311](https://github.com/pjclavero/s9-ai-arena/pull/311) y docs [#312](https://github.com/pjclavero/s9-ai-arena/pull/312) (issue #306) | borrador, CONFORME con observaciones; **decisión del operador pendiente** sobre el alcance |
| Pruebas E2E de ciclo completo de torneos (RR, eliminación, suizo, TDM) con 17 mutantes | [#317](https://github.com/pjclavero/s9-ai-arena/pull/317) | borrador, CONFORME con observaciones; sólo tests |
| `SECURITY.md` y `CHANGELOG.md` | [#307](https://github.com/pjclavero/s9-ai-arena/pull/307) | borrador |
| Rescate de la deuda de init-secrets y diagnóstico del nightly | [#308](https://github.com/pjclavero/s9-ai-arena/pull/308) | borrador |
| Reset competitivo previo a la 0.5 | [#295](https://github.com/pjclavero/s9-ai-arena/pull/295) | borrador (operación) |

## OLA 2

| Funcionalidad | Código y pruebas | Referencias |
|---|---|---|
| Residuos de la OLA 2 del motor: autodaño del tirador con fuego amigo ON pegado a un muro, muros finos | `docs/technical/engine.md` (G1.5) | P3-5, P3-6 |
| Campos del catálogo sin efecto en el motor | `packages/module-catalog/effect-status.ts` | TD-016, #232, #233 |
| Desempate por enfrentamientos directos no transitivo | `apps/tournament-worker/src/results.ts` | TD-069, TD-073 |
| Doble eliminación y liga: ciclo completo con el motor | sólo `apps/tournament-worker/src/formats.test.ts` (generador) | TD-015 |
| Torneos con 13 participantes y byes de punta a punta | sólo unitarios | #317 |
| Carga y concurrencia del worker, pruebas dependientes del reloj | `apps/tournament-worker/src/load-config.ts` | #297 |
| Vigilancia del nightly (hasta que entre #314 sigue en rojo) | `.github/workflows/nightly.yml` | TD-019, #314 |
| Hardening antes de abrir a terceros | `docs/roadmap/technical-debt.md` | TD-031, TD-033, TD-041, TD-043 |
| Reproducir una batalla en vivo por semilla; revisar cuándo se revela la semilla | — | TD-038, #264 |
| Filtración por inferencia en la proyección pública del motor (identidad de entidades, torreta, blindaje) | `packages/projection` | #261, #262, #263 |
| Rendimiento de memoria | — | #185 |
| Endurecer la creación de torneos por equipos sin reglas | `apps/api/src/routes/tournaments.ts` | #310 |
| Observaciones P3 del streaming administrado | `apps/streamer`, `apps/web` | #241, #252, #254 |
| Pruebas de la ejecución por contenedores: ruido conocido de `container-proxy-e2e` (sonda R8) | `tests/browser` | — |

## Versión futura

| Funcionalidad | Estado real en main | Referencias |
|---|---|---|
| **Streaming V2 y Broadcast Manager** (`StreamSession`, `BroadcastItem`, `BroadcastQueue`, control de retención por batalla, pestañas de Retransmisión) | **Sólo diseño**: ni los tipos ni las tablas existen en `main`. Ver la [sección propia](#streaming-v2-y-broadcast-manager) | [#275](https://github.com/pjclavero/s9-ai-arena/pull/275) (MS-1, borrador) |
| Emisión a YouTube real, retención de MP4, alerta si cae el streamer, E2E en CI | La cadena local está probada; la real no | TD-066, #256, #252 |
| Matchmaking, `prepare-battle`, auto-run de torneos | No existe (`git grep` vacío en `apps`, `packages`, `infrastructure`) | diseños archivados en `docs/history/disenos` |
| Pantallas de 2FA y de sesiones; recuperación de contraseña con canal de entrega | La API existe; el token de recuperación se descarta (`routes/auth.ts`) | TD-012; el cambio de contraseña llega con #315 |
| Borrado de mapas, versiones de mapa y bots; cesión de capitanía | No hay operaciones | TD-042 |
| Pantallas de clasificación por equipos, historial de rating y elegir temporada | `getTeamStandings` y `getBotRatingHistory` sin consumidor web | — |
| Campeón del torneo en la API (`championBotId` / `championTeamId`) | `champion_bot_id` sólo en base de datos y nulo en equipos | observación V1C-D02 |
| Fases visuales R16.4–R16.8 (sonido, texturas, niebla y sombreado, shaders, CDN) | R16.1–R16.3 hechas | `docs/roadmap/pending-features.md` |
| Catálogo de armas y útiles (comando `utility`) | El catálogo no trae piezas de utilidad | `equipment-catalog.md`, #233 |
| Administración web de backup, restore, readiness y drift | Sólo por CLI | TD-023 |
| SDK .NET y SDK Java | Sólo `README.md` | `sdks/dotnet`, `sdks/java` |
| WebRTC para espectadores | Descartado | [ADR-R14](../adr/ADR-R14-webrtc.md) |
| Retirar o convertir en autoridad `map-service` y `arena-engine` como servicios | Sin consumidor | TD-017, TD-039 |

## Defectos y exclusiones de V1

| ID | Qué | Gravedad | Evidencia | Referencias |
|---|---|---|---|---|
| EX-1 | **Torneos de captura de bandera (CTF): fuera de V1, no se anuncian como funcionales.** `POST /tournaments` los acepta con reglas clásicas (sólo el preset CTF se rechaza); la única batalla falla al arrancar y el torneo termina sin campeón | P2 | `v1-tournament-ctf-zone.e2e.test.ts` (PR #317), `apps/api/src/services/battle-rules.ts` | TD-070, D-OP-2 |
| EX-2 | **Torneos de control de zona: fuera de V1.** Igual que CTF; el mapa por defecto no tiene zonas | P2 | mismo test | TD-070, D-OP-2 |
| EX-3 | La web ofrece CTF y control de zona al crear un torneo (selector con los cuatro modos) | P2 | `apps/web/src/pages/TournamentsPage.tsx` | propuesta: quitarlos del selector y rechazarlos en la API (cambia el contrato, decisión del operador) |
| DEF-1 | El rol `organizer` es staff global de visibilidad: ve todas las batallas, el diagnóstico de cualquier bot y nombres de bots privados | P1 | `apps/api/src/battle-access.ts`, `replay-access.ts`; `it.fails` en `review-244-final.test.ts` | [#306](https://github.com/pjclavero/s9-ai-arena/issues/306), PR #311 y #312; **pendiente decisión de alcance** |
| DEF-2 | `GET /bots?ownerId=<no UUID>` devuelve 500 | P3 | `apps/api/src/routes/bots.ts` | [#305](https://github.com/pjclavero/s9-ai-arena/issues/305), PR #313 |
| DEF-3 | `DELETE /auth/sessions` respondía 500 | P3 | — | PR #313 |
| DEF-4 | Ningún usuario puede cambiar ni recuperar su contraseña | P1 | `apps/api/src/routes/auth.ts` | TD-012, PR #315 (cambio, no recuperación) |
| DEF-5 | `listBots` devuelve páginas más cortas que `limit` y el cursor podía exponer ids privados | P3 | `apps/api/src/routes/bots.ts` | TD-068, PR #316 |
| DEF-6 | El filtro `result=aborted` de replays no incluye `technical_limit` | P3 | `apps/api/src/services/replay-list.ts` | TD-071 |
| DEF-7 | `nightly` en rojo; `smoke.sh` comprueba rutas que no existen | P2 | `.github/workflows/nightly.yml`, `infrastructure/scripts/smoke.sh` | TD-019, TD-020, PR #314 |
| DEF-8 | La tabla por equipos cuenta el bye como victoria y la clasificación de temporada no | pregunta de producto | `apps/tournament-worker/src/results.ts` | PR #317 (documentado como contrato) |
| DEF-9 | La emisión a YouTube sale con imagen blanca aunque el streamer publica | P2 | issue abierta | [#256](https://github.com/pjclavero/s9-ai-arena/issues/256) |
| DEF-10 | La API revela por la respuesta si un bot existe (`enterTournament` 400 frente a 403) | P3 | issue abierta | #247 |

## Streaming V2 y Broadcast Manager

Comprobado contra `main` (`80f4952`) antes de clasificarlos como futuros:

- **Existe y se queda en V1 (Streaming V1):** el servicio `apps/streamer` (Chromium sin cabeza,
  FFmpeg y relé RTMP interno con clave sellada), la ruta `apps/api/src/routes/streaming.ts`
  (administración de la emisión y sus credenciales), la página `/broadcast` con su director
  (`apps/web/src/pages/BroadcastPage.tsx`, línea temporal pública retrasada, #284), el espectador
  con retardo (#282) y el tap de diagnóstico de la señal enviada (#279). Pruebas:
  `streamer-real.test.ts`, `eq5b-streaming-admin.spec.ts`, `r3-relay-break.test.ts`,
  `r4-relay-break.test.ts`, `streaming-ux-failover.test.ts`. Diseño vigente:
  [streaming.md](../operations/streaming.md) y
  [streaming-architecture.md](../technical/streaming-architecture.md).
- **No existe (Streaming V2 y Broadcast Manager):** `git grep` de `StreamSession`,
  `BroadcastQueue` y `battle_broadcast_controls` en `apps`, `packages` e `infrastructure` no da
  resultados. El PR [#275](https://github.com/pjclavero/s9-ai-arena/pull/275) (MS-1) es **sólo
  diseño** (borrador, sin código ni cambios en el streamer) y deja los PR MS-2…MS-8 por abrir y cuatro
  decisiones abiertas (pre-roll con ticket firmado, modo de inicio por defecto, torneo serial con
  concurrencia mayor que uno, batalla retenida al abandonar su emisión).
- **Conclusión:** Streaming V2 y el Broadcast Manager son **versión futura**. Lo que está en `main`
  es Streaming V1, dentro de V1 pero **sin prueba contra YouTube real** y con un defecto abierto
  (#256, imagen blanca).

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Streaming V2 y Broadcast Manager no existen en `main` | CODE_VERIFIED (2026-11-20, `80f4952`) | `git grep -n "StreamSession\|BroadcastQueue\|battle_broadcast_controls" -- apps packages infrastructure` (vacío) |
| El PR #275 es sólo diseño y sigue en borrador | RUNTIME_VERIFIED (GitHub) | `gh pr view 275` |
| Los PR #307, #308, #311–#317 y #295 están abiertos y en borrador | RUNTIME_VERIFIED (GitHub, 2026-11-20) | `gh pr list --state all` |
| `POST /tournaments` acepta CTF y zona con reglas clásicas | TEST (en el PR #317, abierto) | `v1-tournament-ctf-zone.e2e.test.ts`; `apps/api/src/services/battle-rules.ts` |
| La política `failed` cierra el torneo | CODE_VERIFIED | `apps/tournament-worker/src/results.ts` (`settleMatch`); `tournament-lifecycle-failed.test.ts` |
| Contrato OpenAPI 0.25.0 con 106 operaciones, motor 0.5.0, migraciones 001–022 | CODE_VERIFIED | `apps/api/openapi.yaml`, `packages/game-rules/rules-doc.ts`, `apps/api/src/db/migrations.ts` |
