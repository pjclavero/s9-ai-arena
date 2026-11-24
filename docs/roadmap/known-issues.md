# Problemas conocidos — S9 AI Arena

## Resumen

Síntomas **vigentes** que puede ver un **usuario** o un **operador**, con su causa resumida y la entrada de
deuda que los sigue. La causa técnica completa está en [technical-debt.md](technical-debt.md).

- Revisado el 2026-11-20 contra `main` (`80f4952`). Producción es la instalación nueva del 19-nov (`8f380eb`, motor 0.5.0, migraciones hasta la 022); lo que sólo está en `main` se indica en la columna «Dónde». Lo que corrigen los PR abiertos sigue listado aquí hasta que se mergee.
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
| No se pueden crear batallas de PRÁCTICA de captura de bandera (la web no ofrece el modo; `POST /battles` y `POST /battles/rules-check` responden 400 `mode_disabled`). Los torneos con CTF o zona quedan excluidos de V1 (400 `tournament_mode_not_allowed`, fila siguiente); las ya existentes y sus replays siguen visibles | bloqueo TEMPORAL por decisión del operador mientras CTF no esté corregido y validado (las CTF de práctica fallaban); no es un fallo nuevo. Se levanta con `S9_CTF_PRACTICE_ENABLED=1` | `main` tras mergear este cambio | (temporal) |
| Captura la bandera y control de zona no se admiten en torneos: `POST /tournaments` responde 400 `tournament_mode_not_allowed` (B3, V1). Los torneos antiguos con esos modos siguen visibles pero no avanzan: `closeEntries` responde 409 con ese código, `generate_schedule` falla con él y pasa a revisión, y un `closed` así puede cancelarse. Una batalla CTF de un torneo antiguo ya programada antes de B3 se ejecutaría y fallaría como antes (deuda: guarda en `run_battle`, ver informe B3) | los bandos del torneo son A/B y los mapas CTF usan red/blue; el mapa por defecto no tiene zonas | `main` | [TD-070](technical-debt.md#td-070) |
| El filtro «Abortada o con incidencia» de los replays no muestra las batallas detenidas por el límite técnico | el filtro no incluye `technical_limit` | `main` | [TD-071](technical-debt.md#td-071) |
| Una página de «Mis bots» o de la lista de bots puede salir con menos elementos de los pedidos | la visibilidad se filtra después de leer 200 filas | producción y `main` | [TD-068](technical-debt.md#td-068) |
| Un error de filtro al paginar se presenta como «cursor inválido» | el cursor se hace responsable de cualquier error de conversión | `main` | [TD-067](technical-debt.md#td-067) |
| Un doble clic en «Crear bot» puede dar un error | carrera con `UNIQUE(owner_id, name)` (sin re-comprobar) | producción y `main` | [TD-013](technical-debt.md#td-013) |
| Al añadir un miembro por email, el mensaje revela si la cuenta existe | alta inmediata sin invitación (sin re-comprobar) | producción y `main` | [TD-041](technical-debt.md#td-041) |
| No se puede borrar un mapa ni una versión de mapa | no hay operación de borrado de mapas | producción y `main` | [TD-042](technical-debt.md#td-042) |
| **Cambio de contrato (V1 REPLAYS PR-4b)**: el reproductor de replays ya no tiene capa de depuración; el índice de `GET /api/v1/replays/{id}/index` deja de llevar el campo `debugOpen` y ningún segmento trae `commands`. Un cliente que leyera `debugOpen` debe tratar su ausencia como «sin depuración» | retirada por decisión del operador: S9R/1 nunca sirvió comandos al visor (el campo valía siempre `false`) y no había pantalla para abrirla | `main` tras mergear PR-4b | (decisión, sin deuda) |

## Operador

| Síntoma | Causa resumida | Dónde | Deuda |
|---|---|---|---|
| El replay-service ya no acepta replays (`POST /replays/:id`, `/retention/sweep`, CLI `ingest`/`sweep`/`serve` retirados) y las variables `REPLAY_SERVICE_URL`, `REPLAY_INGEST_REQUIRED` y `REPLAY_INGEST_SECRET[_FILE]` del Compose no tienen efecto; el lanzador HTTP de la API (apagado) nunca archiva replays (`ingested:false`; estricto ⇒ `failed`) | V1 REPLAYS PR-4b: el único productor de replays es el tournament-worker (S9R/1). Limpiar las variables y el secreto del Compose y retirar el lanzador entero queda como deuda post-V1 (riesgo RB-R4) | `main` tras mergear PR-4b | (post-V1) |
| El job `nightly` está siempre en rojo | `unshare` no disponible en el runner y la imagen `backup:e2e-test` no se carga; 5 de las últimas 5 ejecuciones fallan | CI | [TD-019](technical-debt.md#td-019) |
| `GET /api/healthz` responde 200 aunque la API esté caída | el gateway sirve la SPA y `/healthz` es estático | producción y `main` | [TD-020](technical-debt.md#td-020) |
| La alerta de backup no avisa | el perfil `observability` no está desplegado; las alertas existen en la configuración | producción | [TD-007](technical-debt.md#td-007) |
| `map-service` aparece `healthy` y no sirve mapas a nadie | servicio sin uso | producción y `main` | [TD-017](technical-debt.md#td-017) |
| Streaming: los MP4 del modo grabación no se borran; nadie avisa si el streamer cae; YouTube real sin probar | sin retención ni alerta. La clave ya no va en el argv (relé RTMP, ADR-023) | `main` (perfil `streaming`) | [TD-066](technical-debt.md#td-066) |
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
| Una batalla `failed` ya no bloquea el cierre del match (política #299) | CODE_VERIFIED (2026-11-20, `80f4952`) | `apps/tournament-worker/src/results.ts` (`settleMatch`); `tournament-lifecycle-failed.test.ts` |
| CTF y zona rechazados al CREAR torneos (400 `tournament_mode_not_allowed`, también por ruleset/preset/custom); calendario no generado para torneos antiguos con esos modos | IMPLEMENTADO en PR B3 (borrador; sin integrar, sin desplegar). Probado en local con PostgreSQL embebida | `apps/tournament-worker/src/tournament-modes.ts`; `v1-b3-tournament-modes.test.ts`; `v1-tournament-ctf-zone.e2e.test.ts` |
| Filtro `aborted` sin `technical_limit` | CODE_VERIFIED | `apps/api/src/services/replay-list.ts:222-226` |
| `listBots`: 200 filas y visibilidad en memoria | CODE_VERIFIED | `apps/api/src/routes/bots.ts:205-223` |
| `runCursorQuery` | CODE_VERIFIED | `apps/api/src/serialize.ts:168-175` |
| Nightly en rojo | RUNTIME_VERIFIED (GitHub) | `gh run list --workflow nightly.yml` (2026-11-02) |
| `/healthz` estático | CODE_VERIFIED | `apps/api/src/server.ts:28` |
| Sin borrado de mapas | CODE_VERIFIED | `apps/api/openapi.yaml`: las operaciones `delete` son de sesiones, 2FA, equipos, bots de equipo y miembros; ninguna de mapas |
| `notify()` sin llamadas | CODE_VERIFIED | `apps/tournament-worker/src/redis-signal.ts:207` |
| Streaming: la clave ya no va en el argv (RETIRADA, octubre) | CODE_VERIFIED (2026-11-20) | `apps/streamer/src/ffmpeg.ts` (FLV por el descriptor 3, relé RTMP del propio streamer) |
