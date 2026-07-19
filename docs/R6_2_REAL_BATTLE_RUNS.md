# R6.2/R9-B · Ejecución containerizada de batallas desde la UI (gateado y seguro)

Endpoint + UI **preparados y gateados** para lanzar una batalla real con el pipeline seguro
validado (bot-manager → s9-docker-proxy → red arena → replay-service). **Apagado por defecto.**
La **validación operativa real** (ejecución con contenedores en VM108) queda pendiente — este
bloque es **R6.2/R9-B**, no A.

## Endpoint

```
POST /api/v1/battles/{battleId}/run     (operationId: runBattle, x-min-role: user)
```

Respuestas:
- **503 `real_battle_runs_disabled`** si `S9_ENABLE_REAL_BATTLE_RUNS != 1` (por defecto).
- **404** batalla inexistente.
- **409** `invalid_state` (no `scheduled`), `map_not_published`, `bot_not_ready`, `bot_not_signed`
  (versión sin `artifact_hash` firmado).
- **503 `runner_unavailable`** si el launcher no está cableado (aún no lo está → paso VM108).
- **200** `{ battleId, status, runner, replay }` cuando el launcher inyectado ejecuta.

La API **NO llama a Docker**: delega en un `BattleRunLauncher` **inyectado** (`AppConfig.realBattleRuns.runner`).
El launcher real vive fuera de la API (bot-manager) y usa el mismo pipeline del arnés. En tests
se inyecta un fake; **nunca Docker real**.

## Capability para la UI

`GET /api/v1/system/status` incluye `realBattleRuns: { enabled, available }`:
- `enabled` = `S9_ENABLE_REAL_BATTLE_RUNS === "1"`.
- `available` = `enabled && runner cableado`.

Nunca expone `DOCKER_PROXY_URL` ni secretos: solo booleanos.

## UI (`#/battles/new`)

Tras crear la batalla (prepared/encolada), aparece **"Ejecutar batalla real"**:
- **Deshabilitado** salvo que `realBattleRuns.available === true` (fail-closed; si `/system/status`
  no responde, queda deshabilitado). Muestra el motivo ("no disponible / runner no configurado").
- Al ejecutar: `POST /battles/:id/run` → muestra el estado y, si hay replay ingerido, enlace a
  `#/replay/:id`.

## Config/env (backend; NUNCA en frontend)

```
S9_ENABLE_REAL_BATTLE_RUNS=1     # habilita el endpoint (por defecto off → 503)
# El launcher real se inyecta en createApp({ realBattleRuns: { enabled, runner } }); sin runner → 503.
```

## Seguridad (invariantes mantenidos)

- La API no monta `/var/run/docker.sock`, no usa `privileged`, `network_mode: host` ni
  `seccomp=unconfined`. No salta bot-manager/firma/digest/proxy.
- Valida bots **ready + firmados** (`artifact_hash` real, no placeholder) y **mapa publicado**
  antes de delegar. `/system/status` mantiene `runtimePolicy` intacto.
- El frontend no recibe secretos ni la URL del proxy; solo la capability booleana.

## Tests

- Backend `apps/api/src/battle-run.test.ts` (launcher fake, sin Docker): 503 disabled, 404,
  409 invalid_state/bot_not_signed, 503 runner_unavailable, 200 con fake, y la capability.
- Frontend `apps/web/tests/battle-new-page.test.tsx`: Run deshabilitado si backend no lo permite;
  habilitado + ejecuta + enlace a replay cuando `available`.
- OpenAPI/conformance: `runBattle` añadido (58 operaciones).

## Validación operativa en VM108 (gateada, NO en este PR)

Para pasar a **R6.2/R9-A** hay que **cablear el launcher real** (bot-manager como orquestador,
que ejecuta `runContainerBattle` vía docker-proxy + red arena + ingesta en replay-service) y
validarlo en VM108. Runbook:
1. Desplegar bot-manager (perfil `bots`) como orquestador con `DOCKER_PROXY_URL`, red `arena`.
2. Inyectar el launcher real en la API y `S9_ENABLE_REAL_BATTLE_RUNS=1`.
3. Crear una batalla en `#/battles/new` con bots firmados + mapa publicado → **Ejecutar batalla real**.
4. Verificar: 2 contenedores reales, batalla termina, replay ingerido (`GET /replays`), 7/7 núcleo sano.
Solo entonces: **R6.2/R9-A**.

**Dictamen: R6.2/R9-B** — UI y endpoint preparados y seguros, pendiente validación operativa real en VM108.
