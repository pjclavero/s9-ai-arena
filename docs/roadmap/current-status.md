# Estado actual — S9 AI Arena

## Resumen

Esta es la **fuente única del estado actual del proyecto**. Distingue siempre entre:

- lo que contiene `main`;
- lo que corre en producción;
- trabajo abierto en ramas/PR que todavía NO forma parte de `main`.

```text
MAIN_SHA:        b254e3dac1ab25f39f9b4565b3349aa66a9f3963
PRODUCCION_SHA:  b254e3dac1ab25f39f9b4565b3349aa66a9f3963
RELEASE:         RC8
REVISADO:        2026-11-10
MAIN_VS_PROD:    alineados en RC8
MIGRACIONES:     hasta 020 desplegada y verificada en RC8
```

El despliegue RC8 pasó sus gates de predeploy y postdeploy: CI de `main`, backup previo, restore real
aislado de PostgreSQL, snapshot, procedencia de imágenes, migración 020, salud del stack, prueba de
ingesta principal, grabación local, reinicio del streamer, aislamiento de secretos y backup posterior.

La primera prueba real de YouTube confirmó que el relay llega a `publishing`, pero una batalla en vivo
se mostró **completamente blanca**. Ese defecto está abierto en
[#256](https://github.com/pjclavero/s9-ai-arena/issues/256) y tiene prioridad de producción.

La revisión UX de Bots/Equipos/Batallas está abierta en
[#255](https://github.com/pjclavero/s9-ai-arena/issues/255).

El rediseño visual componible de bots se desarrolla fuera de `main`, sobre `mejoras-visuales`. Su FASE 0
(contrato/inventario visual, PR #253) sigue **IN_PROGRESS** y no debe confundirse con funcionalidad ya
integrada.

## Código y despliegue

| Plano | Estado |
|---|---|
| `main` | RC8 `b254e3d`, rama protegida |
| Producción VM108 | RC8 `b254e3d` |
| Base de datos | migración 020 aplicada y verificada durante el despliegue |
| Backup/restore | backup previo y posterior PASS; restore real aislado PASS |
| Snapshot/rollback | snapshot previo PASS; rollback preparado durante despliegue |
| Streaming | cadena RTMPS desplegada; bug visual #256 abierto |
| UX Bots/Equipos/Batallas | comportamiento vigente en RC8; rediseño #255 abierto |
| Mejoras visuales de bots | rama/PR independiente; FASE 0, no integrada |

## Estado funcional

| Área | Estado actual |
|---|---|
| Motor de simulación | **FUNCIONA** |
| Cuentas, login y roles | **FUNCIONA**, con funciones de cuenta todavía parciales |
| Bots: creación, código, versiones y publicación | **FUNCIONA** |
| Equipamiento/loadouts | **FUNCIONA**; catálogo actual de 5 chasis y 31 módulos |
| Build/sandbox | **FUNCIONA** |
| Batallas | **FUNCIONA** con código real de las versiones publicadas |
| Torneos/ranking | **FUNCIONA**, con limitaciones puntuales conocidas |
| Mapas | **FUNCIONA** |
| Visor en directo | **FUNCIONA** en la web |
| Replays | **FUNCIONA** con política de acceso; replays públicos desactivados en producción |
| Streaming externo | **PARCIAL**: conexión/publicación RTMPS real confirmada; vídeo blanco en vivo #256 |
| Backup/restore | **FUNCIONA** y fue verificado en el despliegue RC8 |
| Observabilidad/operación web | **PARCIAL** |

## Incidencias prioritarias abiertas

### #256 — Streaming: vídeo blanco en batalla viva

Durante una sesión real de YouTube:

- el streamer arrancó;
- FFmpeg produjo vídeo;
- el relay llegó a `publishing`;
- YouTube recibió la señal;
- la imagen mostrada fue blanca.

Las grabaciones locales buenas de RC8 usadas durante el despliegue correspondían a otra batalla y no
ejercían exactamente el mismo camino visual de una batalla viva con canvas WebGL. La investigación debe
localizar la primera etapa donde aparece el blanco:

```text
Broadcast DOM
→ Phaser/WebGL
→ Chromium
→ Xvfb
→ FFmpeg
→ FLV/relay
→ YouTube
```

No se considera cerrado hasta tener causa raíz, corrección y regresión automática de frame blanco.

### #255 — UX Bots / Equipos / Batallas

Hallazgos confirmados en el código RC8:

- `BotsPage` mantiene navegación larga por anclas/`scrollIntoView`;
- convive con otro patrón de pestañas en `BotDetailPage`;
- visibilidad de bot y visibilidad de código aparecen separadas;
- Equipos no ofrece publicación masiva de bots administrables;
- `Ver en directo` y `Retransmitir` aparecen como flujos separados;
- el layout general de escritorio sigue limitado por un `main` de 960 px.

El objetivo del PR no es añadir otra capa de navegación, sino consolidar una sola experiencia.

## Seguridad y privacidad vigentes

- El código de usuario sigue aislado en sandbox.
- La clave RTMPS no debe aparecer en logs, API, `docker inspect`, `ps` ni Git.
- La credencial de emisión utilizada en pruebas anteriores debe considerarse comprometida y rotarse antes de
  nuevas pruebas reales.
- Los replays públicos están desactivados actualmente en producción.
- La política decidida para el futuro es que un replay público consuma una **proyección saneada de
  competición**; el replay crudo queda restringido a usuarios autorizados.
- En visualización/broadcast/replay no basta con ocultar campos directos: también deben revisarse fugas por
  inferencia y por reutilización de caches entre perfiles de observador.

## Trabajo visual en curso

Proyecto: representación visual componible de bots.

```text
BASE_BRANCH:     mejoras-visuales
ACTIVE_PR:       #253
CURRENT_PHASE:   FASE 0 — Descubrimiento y contrato visual
STATE:           IN_PROGRESS
PHASE_1:         NOT_STARTED
```

La FASE 0 inventaría componentes reales, mounts, privacidad/fog-of-war, ADR y estrategia de render. La
revisión independiente ha encontrado defectos de contrato que se están corrigiendo antes de permitir
`VISUAL_CONTRACT_READY=PASS`.

No debe marcarse como funcionalidad disponible en RC8.

## Capacidades públicas

| Capacidad | Estado |
|---|---|
| Espectador público | implementado detrás de capability/gates |
| Replays públicos | capability existente; **desactivada actualmente en producción** |
| Broadcast público de torneos | usa proyección saneada de competición |
| Replay crudo público | **NO permitido por política** |

## Próximas prioridades

1. Cerrar #256 con diagnóstico completo y regresión automática.
2. Cerrar #255 con una única navegación coherente y tests responsive/RBAC.
3. Terminar y volver a revisar FASE 0 visual antes de empezar FASE 1.
4. Rotar la credencial de YouTube antes de otra prueba real.
5. Mantener roadmap/known-issues/pending-features sincronizados con cada merge relevante.

## Documentación relacionada

- [Problemas conocidos](known-issues.md)
- [Funciones pendientes](pending-features.md)
- [Deuda técnica](technical-debt.md)
- [Operación de streaming](../operations/streaming.md)
- [Arquitectura](../overview/architecture.md)
- [Guía del jugador](../user/index.md)
- [Histórico](../history/status/)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| `main` = `b254e3d` | CODE_VERIFIED | GitHub, rama `main`, 2026-11-10 |
| producción = RC8 `b254e3d` | OPERATOR_VERIFIED | informe de despliegue RC8 |
| migración 020 / backup / restore / snapshot / health | OPERATOR_VERIFIED | gates del despliegue RC8 |
| #255 y #256 abiertos | CODE_VERIFIED | GitHub Issues |
| mejoras visuales no integradas en `main` | CODE_VERIFIED | ramas `mejoras-visuales*` / PR #253 |
| replays públicos desactivados en producción | RUNTIME_VERIFIED por operador | comprobación de configuración 2026-11-10 |
