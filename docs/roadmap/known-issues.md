# Problemas conocidos — S9 AI Arena

## Resumen

Síntomas que puede ver hoy un **usuario** o un **operador**, con su causa resumida y la entrada de
deuda que los sigue. La causa técnica completa está en [technical-debt.md](technical-debt.md).

Producción no ha cambiado desde la auditoría (base de runtime `27f70bb`): todo lo de la columna
«Producción» sigue ocurriendo allí. La columna «Integración» dice qué pasa con el código del cierre
funcional (`integration/functional-closure`, verificado en aislado el 2026-10-18), que se verá en
producción cuando se fusione y despliegue ([current-status.md](current-status.md#blocked)).

## Índice

- [Usuario web](#usuario-web)
- [Operador](#operador)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Usuario web

| Síntoma en producción | Causa resumida | Integración | Deuda |
|---|---|---|---|
| Al enviar un bot a validación, la versión queda `rejected` con «sandbox no verificado» | falta el sandbox de ejecución en el build | **resuelto**: el bot llega a `published` por el sandbox real. El rechazo espurio bajo carga («arranque > 5000 ms») queda **resuelto** en la integración PRC: la lentitud de la plataforma ya no cuenta contra el bot | [TD-001](technical-debt.md#td-001), [TD-034](technical-debt.md#td-034) |
| «Nueva batalla» muestra `rulesetId desconocido` | la web pedía rulesets que no están en la BD | **resuelto** (rulesets de la API) | [TD-003](technical-debt.md#td-003) |
| El resultado de una batalla no depende del código del bot | todas las batallas las jugaba un stub | **resuelto**: la juega el código publicado de cada bot | [TD-002](technical-debt.md#td-002) |
| El replay se queda con el lienzo vacío y «tick 0/N» | escena usada antes de que arranque Phaser | **resuelto** | [TD-009](technical-debt.md#td-009) |
| El visor en directo se queda en «conectando…» | arranque de Phaser; el worker no verificaba tickets; URL del WebSocket de desarrollo | **resuelto** (visor en directo con batalla viva) | [TD-009](technical-debt.md#td-009), [TD-028](technical-debt.md#td-028), [TD-044](technical-debt.md#td-044) |
| `#/replays` falla cuando se accede por HTTPS | redirección 301 a http | **resuelto** | [TD-014](technical-debt.md#td-014) |
| Cualquiera, sin cuenta, puede descargar el replay de una batalla privada | el gateway enrutaba `/replays*` al replay-service sin autenticación | **resuelto** en la integración PRC: sólo staff, participantes y su equipo; públicos sólo con la capability y todos los bots `public` | [TD-004](technical-debt.md#td-004) |
| El editor de mapas pierde lo editado con F5 | el editor sólo trabajaba en el cliente | **resuelto** (guardar, reabrir, publicar) | [TD-010](technical-debt.md#td-010) |
| No se puede asignar un bot a un equipo desde la web | faltaba la UI de gestión | **resuelto** | [TD-011](technical-debt.md#td-011) |
| Una ruta inexistente muestra «Mis bots»; «Cargando…» sin fin; errores silenciosos en Equipos y «Crear bot» | sin 404, sin timeouts, errores tragados | **resuelto** | [TD-022](technical-debt.md#td-022) |
| «Ranking» vacío tras jugar torneos | temporada distinta entre lector y escritor | **resuelto** | [TD-029](technical-debt.md#td-029) |
| Una batalla con un ruleset de otro modo o un mapa sin ese modo se acepta y falla después | la API no validaba la compatibilidad | **resuelto**: `409` explicado al crearla | [TD-032](technical-debt.md#td-032) |
| «Generar mapa» o «Crear torneo» falla con «Requiere rol organizer» tras rellenar el formulario | los formularios no se ocultan según el rol | sigue | [TD-022](technical-debt.md#td-022) |
| Un doble clic en «Crear bot» puede dar un error | carrera con `UNIQUE(owner_id, name)` | ahora se ve el error junto al formulario; la carrera sigue | [TD-013](technical-debt.md#td-013) |
| Un bot usado en un torneo no puede inscribirse en otro | la versión pasa a `frozen` | sigue | [TD-013](technical-debt.md#td-013) |
| La lista de batallas muestra los participantes de bots privados a cualquiera | sin filtro de visibilidad | sigue | [TD-047](technical-debt.md#td-047) |
| Al añadir un miembro por email, el mensaje revela si la cuenta existe | alta inmediata sin invitación | sigue | [TD-041](technical-debt.md#td-041) |
| No hay opción para cambiar ni recuperar la contraseña | no implementado | sigue | [TD-012](technical-debt.md#td-012) |

## Operador

| Síntoma en producción | Causa resumida | Integración | Deuda |
|---|---|---|---|
| `/version` da 404 en la mayoría de los servicios; `/system/status` muestra `commit: unknown` | imágenes sin identidad de build | sigue | [TD-006](technical-debt.md#td-006), [TD-020](technical-debt.md#td-020) |
| `GET /api/healthz` responde 200 aunque la API esté caída | el gateway sirve la SPA | sigue | [TD-020](technical-debt.md#td-020) |
| `/grafana/` da 502 | perfil de observabilidad inactivo | sigue | [TD-020](technical-debt.md#td-020) |
| El backup puede fallar sin aviso; sin snapshot de la VM; apagado no limpio | sin alertas ni snapshots | sigue | [TD-007](technical-debt.md#td-007) |
| `map-service` `healthy` pero siempre 0 mapas | servicio sin uso | sigue (se queda en `production` por el contrato de despliegue) | [TD-017](technical-debt.md#td-017) |
| Variables puestas en `infrastructure/.env` (CORS, capacidades públicas, `SPECTATE_WS_URL`) no tienen efecto | el compose no las entregaba | **resuelto** (contrato por servicio) | [TD-030](technical-debt.md#td-030) |
| Al desplegar la integración, el worker no ejecuta batallas y lo dice en el log | falta `DOCKER_PROXY_URL`, la clave pública o el proxy del host | configurar según [configuration.md](../operations/configuration.md) | [TD-001](technical-debt.md#td-001) |
| El job nightly siempre está en rojo; los E2E con Docker y de navegador no corren en CI | `unshare` en el runner; sin job con Docker | nightly sigue; los E2E corren en el job obligatorio `functional-e2e` (integración PRC). Un rojo aún **no impide** el merge hasta que el operador proteja `main` con `semaforo` | [TD-019](technical-debt.md#td-019), [TD-045](technical-debt.md#td-045) |
| Los logins externos quedan con la misma IP | `TRUST_PROXY_HOPS` no cuenta el proxy externo | sigue | [TD-012](technical-debt.md#td-012) |
| Con las referencias por defecto, `compose pull` da 404 | `latest` no se publica | sigue | [TD-024](technical-debt.md#td-024) |
| El worker tarda ~1 s en tomar trabajo | aviso Redis sin productor | sigue | [TD-026](technical-debt.md#td-026) |

Diagnóstico y procedimientos: [docs/operations/diagnostics.md](../operations/diagnostics.md) y
[docs/operations/troubleshooting.md](../operations/troubleshooting.md).

## Documentación relacionada

- [current-status.md](current-status.md) · [technical-debt.md](technical-debt.md)
- [Informe del cierre funcional](../development/functional-closure-report.md)
- [Guía de usuario](../user/index.md) · [Operación](../operations/index.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Síntomas de producción | auditoría (BROWSER/RUNTIME, interna) y CODE_VERIFIED en `27f70bb` | [AUDIT-DELTA](../audits/2026-10-15/AUDIT-DELTA-2026-10.md) |
| Columna «Integración: resuelto» | RUNTIME_VERIFIED (aislado) | `npm run test:browser` (golden + fases 1-3, rc=0) y suites del informe de cierre |
| Rechazo por arranque bajo carga | RUNTIME_VERIFIED (aislado) | E2E A+B: 1 de 2 ejecuciones, «arranque 6580 ms > 5000 ms» (base); resuelto en la integración PRC ([production-readiness-report.md](../development/production-readiness-report.md)) |
| Participantes privados visibles | CODE_VERIFIED | `apps/api/src/routes/battles.ts` (`listBattles`, `getBattle`, `getBattleStats`) |
