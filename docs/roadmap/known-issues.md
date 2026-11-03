# Problemas conocidos — S9 AI Arena

## Resumen

Síntomas **vigentes** que puede ver un **usuario** o un **operador**, con su causa resumida y la entrada de
deuda que los sigue. La causa técnica completa está en [technical-debt.md](technical-debt.md).

- Revisado el 2026-11-02 contra `main` (`e3bf2fa`). Producción corre RC5.5 (`a1a6c4e`); lo que sólo está en `main` se indica en la columna «Dónde».
- Los síntomas de la auditoría de octubre que ya están resueltos (build sin sandbox, `rulesetId desconocido`, replay en blanco, replays visibles para anónimos, etc.) se han archivado en [../history/status/known-issues-2026-10.md](../history/status/known-issues-2026-10.md); no se repiten aquí.
- Las filas marcadas «sin re-comprobar» vienen de la auditoría original y ningún cambio posterior de `main` las cita.

## Índice

- [Usuario web](#usuario-web)
- [Operador](#operador)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Usuario web

| Síntoma | Causa resumida | Dónde | Deuda |
|---|---|---|---|
| No hay forma de recuperar la contraseña; en «Mi cuenta» no se puede activar el 2FA ni ver o cerrar sesiones | la API tiene las operaciones, pero la web no tiene pantallas y la recuperación descarta el token (no hay canal de entrega) | producción y `main` | [TD-012](technical-debt.md#td-012) |
| Un torneo con una batalla fallida no termina | el cierre del match exige batallas `finished` | producción y `main` | [TD-015](technical-debt.md#td-015) |
| «Crear torneo» de captura de bandera (CTF) con reglas se rechaza con un motivo | los bandos del torneo son A/B y los mapas CTF usan red/blue | `main` (reglas 0.4.0, aún sin desplegar) | [TD-070](technical-debt.md#td-070) |
| El filtro «Abortada o con incidencia» de los replays no muestra las batallas detenidas por el límite técnico | el filtro no incluye `technical_limit` | `main` | [TD-071](technical-debt.md#td-071) |
| Una página de «Mis bots» o de la lista de bots puede salir con menos elementos de los pedidos | la visibilidad se filtra después de leer 200 filas | producción y `main` | [TD-068](technical-debt.md#td-068) |
| Un error de filtro al paginar se presenta como «cursor inválido» | el cursor se hace responsable de cualquier error de conversión | `main` | [TD-067](technical-debt.md#td-067) |
| Un doble clic en «Crear bot» puede dar un error | carrera con `UNIQUE(owner_id, name)` (sin re-comprobar) | producción y `main` | [TD-013](technical-debt.md#td-013) |
| Un bot usado en un torneo no puede inscribirse en otro | la versión pasa a `frozen` (sin re-comprobar) | producción y `main` | [TD-013](technical-debt.md#td-013) |
| Al añadir un miembro por email, el mensaje revela si la cuenta existe | alta inmediata sin invitación (sin re-comprobar) | producción y `main` | [TD-041](technical-debt.md#td-041) |
| No se puede borrar un mapa ni una versión de mapa | no hay operación de borrado de mapas | producción y `main` | [TD-042](technical-debt.md#td-042) |

## Operador

| Síntoma | Causa resumida | Dónde | Deuda |
|---|---|---|---|
| El job `nightly` está siempre en rojo | `unshare` no disponible en el runner y la imagen `backup:e2e-test` no se carga; 5 de las últimas 5 ejecuciones fallan | CI | [TD-019](technical-debt.md#td-019) |
| `GET /api/healthz` responde 200 aunque la API esté caída | el gateway sirve la SPA y `/healthz` es estático | producción y `main` | [TD-020](technical-debt.md#td-020) |
| La alerta de backup no avisa | el perfil `observability` no está desplegado; las alertas existen en la configuración | producción | [TD-007](technical-debt.md#td-007) |
| `map-service` aparece `healthy` y no sirve mapas a nadie | servicio sin uso | producción y `main` | [TD-017](technical-debt.md#td-017) |
| Streaming: la clave de emisión se ve con `ps` en el host; los MP4 no se borran; nadie avisa si el streamer cae | FFmpeg recibe la URL con la clave en el argv; sin retención ni alerta | `main` (perfil `streaming`, no desplegado) | [TD-066](technical-debt.md#td-066) |
| Los logins externos quedan con la misma IP | `TRUST_PROXY_HOPS` no cuenta el proxy externo (sin re-comprobar) | producción | [TD-012](technical-debt.md#td-012) |
| El worker tarda hasta ~1 s en tomar trabajo | el aviso por Redis nunca se emite (`notify()` sin llamadas) | producción y `main` | [TD-026](technical-debt.md#td-026) |
| Los contenedores `bot-bot_smoke*` y `s9-localreg` siguen en el host | restos de un smoke manual | producción | [TD-058](technical-debt.md#td-058) |
| `compose pull` con las referencias por defecto da 404 | `latest` no se publica (sin re-comprobar) | producción | [TD-024](technical-debt.md#td-024) |
| Backup, restore, readiness y drift no se ven desde la web | administración operativa solo por CLI | producción y `main` | [TD-023](technical-debt.md#td-023) |

Diagnóstico y procedimientos: [docs/operations/diagnostics.md](../operations/diagnostics.md) y
[docs/operations/troubleshooting.md](../operations/troubleshooting.md).

## Documentación relacionada

- [current-status.md](current-status.md) · [technical-debt.md](technical-debt.md) · [pending-features.md](pending-features.md)
- [Guía del jugador](../user/index.md) · [Operación](../operations/index.md)
- Problemas de octubre ya resueltos: [../history/status/known-issues-2026-10.md](../history/status/known-issues-2026-10.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Recuperación sin canal de entrega; sin pantallas de 2FA ni sesiones | CODE_VERIFIED | `apps/api/src/routes/auth.ts:386-398`, `:440`; `git grep -nE "auth/(2fa|sessions|recover|reset)" -- apps/web/src` vacío |
| Una batalla `failed` bloquea el cierre del match | CODE_VERIFIED | `apps/tournament-worker/src/results.ts:378`, `:408` |
| CTF rechazado en torneos | CODE_VERIFIED | `apps/api/src/services/battle-rules.ts:353-361` |
| Filtro `aborted` sin `technical_limit` | CODE_VERIFIED | `apps/api/src/services/replay-list.ts:222-226` |
| `listBots`: 200 filas y visibilidad en memoria | CODE_VERIFIED | `apps/api/src/routes/bots.ts:205-223` |
| `runCursorQuery` | CODE_VERIFIED | `apps/api/src/serialize.ts:168-175` |
| Nightly en rojo | RUNTIME_VERIFIED (GitHub) | `gh run list --workflow nightly.yml` (2026-11-02) |
| `/healthz` estático | CODE_VERIFIED | `apps/api/src/server.ts:28` |
| Sin borrado de mapas | CODE_VERIFIED | `apps/api/openapi.yaml`: las operaciones `delete` son de sesiones, 2FA, equipos, bots de equipo y miembros; ninguna de mapas |
| `notify()` sin llamadas | CODE_VERIFIED | `apps/tournament-worker/src/redis-signal.ts:207` |
| Streaming: clave en argv | CODE_VERIFIED | `apps/streamer/src/ffmpeg.ts:115-118` |
