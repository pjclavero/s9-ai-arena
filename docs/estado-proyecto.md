# Estado del proyecto S9 AI Arena

> Última actualización: 2026-07-16, verificado ejecutando las suites reales en ia-server (VM 102).
> Este documento existe para entender de un vistazo qué hay hecho DE VERDAD (verificado con
> ejecuciones reales) y qué falta, siguiendo el dosier `docs/Dosier_tareas_S9_AI_Arena.md`.

## Dónde vive cada cosa

| Qué | Dónde |
|---|---|
| Dosier de tareas (12 equipos E1–E12) | `docs/Dosier_tareas_S9_AI_Arena.md` |
| Contratos (esquemas protocolo, módulos, mapas, OpenAPI) | `packages/protocol/`, `packages/module-catalog/`, `packages/map-schema/`, `apps/api/openapi.yaml` |
| Motor de simulación | `apps/arena-engine/` |
| Catálogo de módulos y validador de loadouts | `packages/module-catalog/` |
| Mapas (pipeline Tiled, validador, servicio, procedural) | `apps/map-service/`, `maps/`, `tests/maps-broken/` |
| Protocolo servidor + SDKs | `apps/arena-engine/src/protocol-server.ts`, `sdks/python/`, `sdks/javascript/`, `example-bots/` |
| Entregas por equipo | `docs/entrega-E1.md` … `docs/entrega-E5.md` |
| Copia local de trabajo | `~/s9-ai-arena` en ia-server (VM 102, 192.168.1.157) |
| Repo remoto | `github.com/pjclavero/s9-ai-arena` (público) |

## Estado de despliegue (2026-07-16)

**No hay nada desplegado: es solo repositorio.** No hay contenedores del proyecto ni
procesos Node del arena corriendo en ia-server. El `docker-compose.yml` de la raíz
(arena-server/arena-viewer/bots) es de un prototipo previo a este dosier, NO el stack
E10 del capítulo 6 (que iría en `infrastructure/` y aún no existe).

**Limitación de entorno relevante:** en ia-server el usuario `ia02` no pertenece al grupo
`docker` y no hay `sudo`, así que no se puede construir ni lanzar contenedores desde esta
sesión. Afecta a la verificación real de E6 (sandbox) y E10 (Compose/CI). El Node local es
v20.19.2 (ver nota de zstd más abajo).

## Estado por equipo (verificado con ejecuciones reales, no con lo que dicen los docs)

| Equipo | Tareas del dosier | Código presente | Tests ejecutados | Resultado real | Notas |
|---|---|---|---|---|---|
| E1 Contratos | T1.1–T1.4 | `packages/protocol`, `packages/module-catalog`, `packages/map-schema`, `apps/api/openapi.yaml` | `node packages/protocol/scripts/validate.js` y `node packages/module-catalog/scripts/validate-catalog.js` | **Ambos "TODO CORRECTO"** (19+22 y 6+11+casos de mapa) | Fusión E1+E2 documentada en `FUSION.md` |
| E2 Motor | T2.1–T2.6 | `apps/arena-engine/` | Incluido en `npm test` | **Verde** (determinismo, física, golden, replays) | 1 test de tamaño de replay falla por ENTORNO: `zstdCompressSync` no existe en Node 20 (requiere ≥22.15). No es un bug del código. |
| E3 Módulos | T3.1–T3.4 | `packages/module-catalog/` (datos, validador, resolver, bench) | Incluido en `npm test` + validador CLI | **Verde** | fixtures.ts del motor cableado al catálogo real |
| E4 Mapas | T4.1–T4.4 | `apps/map-service/`, `maps/`, `tests/maps-broken/` | Incluido en `npm test` | **Verde** | Import Tiled, validador, servicio, procedural |
| E5 Protocolo+SDKs | T5.1–T5.4 | protocol-server + `sdks/python` + `sdks/javascript` + `example-bots/` | `npm test` + `pytest` en `sdks/python` | **Verde**: SDK Python 45/45 (60 s); JS/protocolo en vitest | El test flaky de T5.1 (comparaba 2 ejecuciones en vivo) se reescribió como autoconsistencia vía replay — ver `docs/entrega-E5.md` |
| E6 Seguridad | T6.1–T6.4 | — | — | **Sin empezar** | Siguiente en la cadena (E5 hecho; imágenes base de E10 pendientes de reconciliación) |
| E7 Plataforma | T7.x | — | — | Sin empezar | Depende de E6 (pipeline builds) |
| E8 Visor/Replays | T8.x | — | — | Sin empezar | Depende de E7 |
| E9 Torneos | T9.x | — | — | Sin empezar | Depende de E7+E6 |
| E10 DevOps | T10.1–T10.4 | — | — | Sin empezar | DoD exige Docker/CI reales: no verificable por completo en ia-server tal como está (sin grupo docker) |
| E11 Streaming | T11.x | — | — | Sin empezar | Depende de E8+E10 |
| E12 QA | T12.x | — | — | Sin empezar | Transversal, desde M1 |

### Cifras de la última verificación completa (2026-07-16, ia-server, Node v20.19.2)

- `npm test` (línea base al clonar): **309 pasan, 2 fallan, 3 skipped** (314). Los 2 fallos:
  1. Flaky de E5 (`protocol-server.test.ts:306`) — **resuelto**: el test estaba mal planteado,
     comparaba los hashes de dos ejecuciones EN VIVO de la misma semilla, cosa que el jitter
     real de red/SO no garantiza (un comando llega a tiempo en una ejecución y tarde en otra,
     y eso es comportamiento correcto). Se reescribió para verificar AUTOCONSISTENCIA: una
     sola ejecución en vivo con fuzzing debe reproducirse exactamente en replay con
     `verify()` de `replay.ts` (mecanismo de E2 reutilizado, no reimplementado).
  2. `replay-golden.test.ts` tamaño de replay — fallo de ENTORNO (Node 20 sin
     `zstdCompressSync`); pasa en Node ≥ 22.15.
- Validadores E1: ambos "TODO CORRECTO".
- SDK Python: `pytest` 45/45 en 60,8 s (necesita `pip install -e ".[dev]"` en `sdks/python`).

## Hallazgos / deudas conocidas

- **Node 20 vs 22**: el repo asume Node ≥ 22.15 para el test de compresión zstd de replays.
  Decidir: subir Node en ia-server o declarar `engines` en package.json.
- **Docker inaccesible para `ia02`**: añadir el usuario al grupo `docker` (o dar acceso
  equivalente) antes de E6/E10 si se quiere verificación real y no solo por inspección.
