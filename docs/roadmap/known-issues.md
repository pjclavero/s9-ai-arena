# Problemas conocidos — S9 AI Arena

## Resumen

Síntomas que puede ver hoy un **usuario** o un **operador**, con su causa resumida y la entrada de
deuda que los sigue. La causa técnica completa está en [technical-debt.md](technical-debt.md).
Base: `27f70bb`, verificado el 2026-10-15.

## Índice

- [Usuario web](#usuario-web)
- [Operador](#operador)
- [Verificación](#verificación)

## Usuario web

| Síntoma | Causa resumida | Solución temporal | Deuda |
|---|---|---|---|
| Al enviar un bot a validación, la versión queda `rejected` con «sandbox no verificado» | falta el sandbox de ejecución en el build; reenviar no sirve | ninguna | [TD-001](technical-debt.md#td-001) |
| «Nueva batalla» muestra `rulesetId desconocido` en cualquier modo | la web pide rulesets que no están en la BD | ninguna desde la web. Un organizer puede jugar vía torneo con el ruleset del contenido base | [TD-003](technical-debt.md#td-003) |
| El resultado de una batalla no depende del código del bot | todas las batallas las juega un bot de relleno (stub) con el loadout del usuario | ninguna | [TD-002](technical-debt.md#td-002) |
| El replay se queda con el lienzo vacío y «tick 0/N» | el reproductor usa la escena antes de que arranque el motor gráfico | ninguna | [TD-009](technical-debt.md#td-009) |
| El visor en directo se queda en «conectando…» | el mismo defecto de arranque; además, el worker no puede verificar tickets | ninguna | [TD-009](technical-debt.md#td-009), [TD-028](technical-debt.md#td-028) |
| `#/replays` muestra «Servicio de replays no disponible» cuando se accede por HTTPS | redirección 301 a http bloqueada por el navegador (contenido mixto) | ninguna para el usuario | [TD-014](technical-debt.md#td-014) |
| El editor de mapas pierde lo editado con F5 y no tiene botón Guardar | el editor sólo trabaja en el cliente | exportar el JSON; aun así, importarlo da error 500 | [TD-010](technical-debt.md#td-010) |
| «Generar mapa» o «Crear torneo» falla con «Requiere rol organizer» después de rellenar el formulario | los formularios no se ocultan según el rol | pedir el rol a un admin | [TD-022](technical-debt.md#td-022) |
| No se puede asignar un bot a un equipo desde la web; para invitar hay que escribir un UUID | falta la UI de gestión del equipo | ninguna desde la web | [TD-011](technical-debt.md#td-011) |
| Un doble clic en «Crear bot» da un error sin aviso | la carrera se traduce en 500 y la UI no lo muestra | no repetir el clic; recargar | [TD-013](technical-debt.md#td-013), [TD-022](technical-debt.md#td-022) |
| Una ruta inexistente muestra «Mis bots»; «Cargando…» puede no terminar nunca | sin página 404 ni timeouts en el cliente | recargar | [TD-022](technical-debt.md#td-022) |
| Equipos aparece vacío cuando la API falla | la página se traga el error | recargar | [TD-022](technical-debt.md#td-022) |
| «Ranking» dice «Todavía no hay clasificación para este modo.» incluso después de jugar torneos | la página consulta una temporada distinta de aquella en la que se guardan los resultados | ninguna desde la web; la API devuelve datos con `?seasonId=season-1` | [TD-029](technical-debt.md#td-029) |
| La lista de batallas no muestra el ganador; `finished (none)` sale en rojo | presentación de estados internos | consultar la API | [TD-022](technical-debt.md#td-022) |
| Un bot usado en un torneo no puede inscribirse en otro | la versión pasa a `frozen` y una versión nueva nunca se valida | ninguna | [TD-013](technical-debt.md#td-013), [TD-001](technical-debt.md#td-001) |
| No hay opción para cambiar la contraseña ni para recuperarla por email | no implementado | ninguna documentada | [TD-012](technical-debt.md#td-012) |

## Operador

| Síntoma | Causa resumida | Deuda |
|---|---|---|
| `/version` da 404 en la mayoría de los servicios; `/system/status` muestra `commit: unknown` | imágenes sin identidad de build; `/system/status` lee variables que nadie fija | [TD-006](technical-debt.md#td-006), [TD-020](technical-debt.md#td-020) |
| `GET /api/healthz` responde 200 aunque la API esté caída | el gateway no tiene esa ruta y sirve la SPA | [TD-020](technical-debt.md#td-020) |
| `/grafana/` da 502 | el perfil de observabilidad no está activo | [TD-020](technical-debt.md#td-020) |
| El backup puede fallar sin que nadie se entere | sólo el healthcheck lo ve; no hay alerta | [TD-007](technical-debt.md#td-007) |
| No hay snapshot de la VM para volver atrás | se borraron y no se han recreado | [TD-007](technical-debt.md#td-007) |
| PostgreSQL recupera el WAL tras un apagado | el apagado no fue limpio (sin `stop_grace_period`) | [TD-007](technical-debt.md#td-007) |
| El contenedor `map-service` está `healthy`, pero siempre devuelve 0 mapas | servicio sin uso; los mapas los persiste la API | [TD-017](technical-debt.md#td-017) |
| El job nightly de GitHub Actions siempre está en rojo | `unshare` en el runner; la imagen de backup no se carga | [TD-019](technical-debt.md#td-019) |
| Los logins de todos los usuarios externos quedan con la misma IP | `TRUST_PROXY_HOPS` no cuenta el proxy inverso externo | [TD-012](technical-debt.md#td-012) |
| Con las referencias de imagen por defecto, `compose pull` da 404 | por defecto se usa `latest`, que no se publica | [TD-024](technical-debt.md#td-024) |
| El arranque del worker no es inmediato tras encolar trabajo | aviso Redis sin productor; el worker hace polling (~1 s) | [TD-026](technical-debt.md#td-026) |

Diagnóstico y procedimientos: [docs/operations/diagnostics.md](../operations/diagnostics.md) y
[docs/operations/troubleshooting.md](../operations/troubleshooting.md).

## Documentación relacionada

- [current-status.md](current-status.md) · [technical-debt.md](technical-debt.md)
- [Guía de usuario](../user/index.md) · [Operación](../operations/index.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Mensaje de rechazo del build | CODE_VERIFIED | `apps/bot-manager/src/pipeline.ts:172` |
| `rulesetId desconocido` | CODE_VERIFIED | `apps/api/src/routes/battles.ts:401` |
| `fetch("/replays")` sin barra final | CODE_VERIFIED | `apps/web/src/pages/ReplaysPage.tsx:28` |
| El editor no persiste | CODE_VERIFIED | `apps/web/src/pages/MapEditorPage.tsx:14-16` |
| `/system/status` con `commit: unknown` | CODE_VERIFIED | `apps/api/src/routes/system.ts:51` |
| map-service en memoria | CODE_VERIFIED | `apps/map-service/src/main.ts:20-42` |
| Síntomas de navegador | auditoría (BROWSER, interna) | capturas de la pasada 2 de la auditoría |
