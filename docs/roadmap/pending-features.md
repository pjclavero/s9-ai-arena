# Funciones pendientes — S9 AI Arena

## Resumen

Este documento recoge lo que **falta por construir, terminar o activar** después de RC8
`b254e3d` (revisión 2026-11-10). Lo roto se registra como incidencia/deuda; lo que está sólo en una
rama o PR no se presenta como funcionalidad de `main`.

Categorías:

- **PARCIAL:** existe una implementación útil, pero falta cierre funcional/operativo.
- **PENDIENTE:** no existe todavía.
- **EN DISEÑO:** trabajo activo fuera de `main`, sin considerarlo disponible.
- **DESCARTADA:** decisión explícita de no construirlo.

## Parciales

| Función | Qué existe en RC8 | Qué falta |
|---|---|---|
| Streaming RTMPS | UI de Administración → Streaming, credenciales selladas, relay RTMP, ingesta principal/respaldo, presets, record mode y publicación real a YouTube | cerrar #256: una batalla viva llegó a YouTube con imagen blanca; añadir gate/regresión de contenido visual válido |
| Espectador público | rutas/capability y visor público | activación operativa según gates y política |
| Replays públicos | capability y rutas públicas | permanecen desactivados; antes de activarlos debe existir proyección pública saneada y gobernanza del replay crudo |
| Observabilidad | métricas y configuración de observabilidad/alertas | completar despliegue y validación operativa de alertas |
| Cuenta | login, roles, TOTP en autenticación y operaciones backend | UX completa de recuperación, gestión 2FA y sesiones |
| Administración operativa web | roles, auditoría, streaming y estado | ampliar backup/restore/readiness/drift donde proceda |
| Torneos | formatos y ejecución base | cerrar limitaciones puntuales conocidas, incluidas combinaciones de reglas/modos |
| Equipamiento | catálogo, validación, persistencia y motor | seguir cerrando campos del catálogo que aún no tengan efecto o representación |
| UX Bots/Equipos/Batallas | funcionalidad completa usable en RC8 | rediseño #255: navegación sin scroll, visibilidad agrupada, bulk public de equipo, directo+retransmisión y layout ancho |

## En diseño / desarrollo fuera de main

### Sistema visual componible de bots — PR #253

Base: `mejoras-visuales`.

Estado:

```text
FASE 0 — Descubrimiento y contrato visual: IN_PROGRESS
FASE 1 — Core visual:                 NOT_STARTED
```

La FASE 0 incluye:

- inventario real de chasis/módulos;
- matriz componente → representación;
- mounts;
- ADR de formato/versionado/coordenadas;
- privacidad/fog-of-war;
- fugas directas y derivadas;
- composición dependiente del observador;
- determinismo histórico.

No debe pasar a FASE 1 hasta `VISUAL_CONTRACT_READY=PASS` tras revisión independiente.

### Política de replays públicos

Decisión de producto/seguridad:

```text
PUBLIC_REPLAY → sanitized competition projection
RAW_REPLAY    → restricted
```

La capability pública apagada en producción es una defensa operativa, no la solución arquitectónica.

## Pendientes

| Función | Estado |
|---|---|
| Matchmaking general | no implementado |
| prepare-battle como puente específico de matchmaking | no implementado como feature independiente |
| Auto-run configurable de torneos/batallas desde UI | no cerrado como producto |
| Gestión completa de sesiones desde la web | pendiente |
| SDK .NET completo | pendiente |
| SDK Java completo | pendiente |
| Sonido avanzado del visor | pendiente |
| Texturas/sombreado visual posteriores | pendientes dentro del roadmap visual, no RC8 |

## Descartadas por decisión

| Función | Decisión |
|---|---|
| WebRTC para espectadores | no se implementa mientras el fan-out WS satisfaga la necesidad |
| Sharding intra-batalla | rechazado; el escalado es inter-batalla |
| Calor/recarga de armas como mecánica general | fuera del modelo fundacional actual |
| Actualizar Rapier directamente sin golden/evaluación | prohibido por política de determinismo |

## Completadas y ya fuera de pendientes

RC8 ya contiene, entre otras:

- recorrido real de bot → build/sandbox → publicación → batalla;
- ejecución con código real del bot;
- visor en directo y replay web;
- editor de mapas con persistencia;
- equipos;
- ranking;
- streaming administrado desde web;
- relay RTMP con secreto fuera del argv de FFmpeg;
- ingesta principal/respaldo;
- backup/restore verificado en despliegue RC8.

## Reglas vigentes

- Una feature experimental se activa mediante su gate.
- No declarar DONE lo que sólo está diseñado.
- No desarrollar mejoras visuales directamente sobre `main`.
- Un bloque funcional por PR, con tests y revisión.
- Replays/broadcast/visuales deben respetar permisos y evitar fugas por inferencia, no sólo campos directos.

## Documentación relacionada

- [Estado actual](current-status.md)
- [Problemas conocidos](known-issues.md)
- [Deuda técnica](technical-debt.md)
- [Streaming](../operations/streaming.md)
- [Histórico](../history/status/)
