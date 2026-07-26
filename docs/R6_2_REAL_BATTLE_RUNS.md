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

## B2 · cableado real (API → arena-engine → s9-docker-proxy), aún gateado

B2 sustituye el orquestador previsto (bot-manager como proceso aparte) por una cadena más
corta que reutiliza el servicio HTTP de B1 sin que la API hable nunca con Docker:

```
API --HTTP(red platform)--> arena-engine --HTTP--> s9-docker-proxy --> bots (red arena)
```

- **`apps/arena-engine/src/service.ts`**: `POST /run` ahora exige autenticación interna
  (cabecera `x-arena-engine-auth`, comparación en tiempo constante contra
  `ARENA_ENGINE_INTERNAL_SECRET[_FILE]`) — sin credencial válida, 401 SIEMPRE, incluso con
  runner cableado. `network`/`engineHost` YA NO se aceptan del cuerpo de la petición (B1 los
  dejaba pasar porque eran inocuos sin runner; con el runner real, aceptarlos del body
  habría permitido a quien alcanzara la red interna forzar una red Docker arbitraria o un
  `engineHost` propio). El runner (`ProxyContainerRunner`, habla con `s9-docker-proxy`, nunca
  con `docker.sock`) se cablea vía `serviceConfigFromEnv()`, gateado por `DOCKER_PROXY_URL`:
  sin configurar, sigue en 503 `runner_unavailable`.
- **`apps/api/src/services/battle-run-http-launcher.ts`**: implementación real de
  `BattleRunLauncher` — llama a arena-engine por HTTP con la misma credencial interna, con
  timeout, y traduce la respuesta a `BattleRunResult`. Se inyecta en `server.ts` solo si
  `ARENA_ENGINE_URL` y el secreto compartido están AMBOS presentes; si falta alguno, sigue
  sin runner (503) exactamente igual que antes de B2.
- **Compose**: ambas piezas de config tienen valores por defecto seguros — sin desplegar el
  secreto (`arena_engine_internal_secret`, generado por `init-secrets.sh`, montado por
  archivo en ambos servicios) o sin `DOCKER_PROXY_URL`, el comportamiento no cambia respecto
  a B1 (503 en ambos extremos). `S9_ENABLE_REAL_BATTLE_RUNS` sigue sin encenderse en ningún
  fichero de configuración.

**Mapa — B9: CUALQUIER MAPA PUBLICADO DEL CATÁLOGO, RESUELTO DE VERDAD.** (Hasta B9: el
launcher solo admitía `mvp-arena-01` v1 vía la allowlist `FIXTURE_MAP_EQUIVALENTS`, que
traducía ese único mapId a un mapa-fixture del motor; todo lo demás se rechazaba. Rechazar
era correcto —mejor eso que jugar otro mapa en silencio— pero el catálogo real de mapas del
proyecto no se usaba, y ni siquiera `mvp-arena-01` se jugaba con su geometría real, sino con
la fixture "PROVISIONAL POR DISEÑO".)

Cadena de B9: `map_versions` (fila `published`, contenido `InternalMap` de E1/E4) →
`toEngineMap()` (apps/map-service) → `ArenaMap` → campo **`map`** del cuerpo de `POST /run`
(`apps/api/src/services/battle-map-resolver.ts`). arena-engine valida ese mapa entero como
entrada externa (`apps/arena-engine/src/arena-map.ts::validateArenaMap`) antes de tocar el
motor; `map` y `mapName` (fixture) son **excluyentes**.

El invariante no cambia, se refuerza — **fail closed y con código distinguible** en
`BattleRunResult.errorCode`: `map_not_published` (no existe esa versión EXACTA publicada;
nunca se coge "la última"), `map_content_mismatch` (fila y documento divergen),
`map_checksum_mismatch` (el checksum canónico del documento no cuadra con su contenido:
se manipuló tras publicarse), `map_invalid` (no pasa el validador REAL de E4),
`map_unplayable` (no es jugable para el motor), y `map_identity_mismatch` — **al volver**, el
mapa de la cabecera del replay debe ser exactamente el pedido (mapId+versión+checksum); si el
motor jugó otro mapa, la batalla es `failed` y el replay NO se ingesta.

**Ruleset/ticks — B9: resueltos (y arreglado un bug real).** Hasta B9 el launcher enviaba
`rulesetId: battle.mode` (`"deathmatch"`), que **no es** un ruleset del motor
(`dm_practice@1`, `tdm_mvp@1`...): `loadRuleset()` lanzaba dentro de `runContainerBattle` y
toda batalla real lanzada desde la API acababa en un 502 `battle_failed` genérico. Ahora
`apps/api/src/services/battle-ruleset-resolver.ts` traduce modo (+ `rulesets.config.engineRulesetId`
si la fila de BD lo declara) → ruleset REAL del motor, exigiendo que el modo coincida
(`ruleset_mode_mismatch` si no), y `ticks` sale de `ruleset.timeLimitTicks` en vez de un
20000 fijo. arena-engine, además, rechaza con **400** un `rulesetId` que no esté en su
catálogo, en vez de dejarlo explotar a mitad de batalla.

**Límites que siguen abiertos tras B9** (no son huecos de seguridad; son fidelidad y alcance):
`meta.supportedModes` del mapa NO se comprueba contra el modo de la batalla (el seed publica
`mvp-arena-01` con `["capture_the_flag","team_deathmatch"]` y las batallas de práctica se
crean en `deathmatch`: activarlo hoy rompería el camino que funciona); `budget_credits`/
`forbidden_categories` de la fila de `rulesets` de la BD siguen sin aplicarse al ruleset del
motor; y nada de esto se ha probado contra Docker real — ver el informe de entrega del bloque
correspondiente para qué se verificó con fakes y qué queda pendiente de VM108.

## Validación operativa en VM108 (gateada, NO en este PR)

Para pasar a **R6.2/R9-A** falta, sobre lo que ya cablea B2:
1. Desplegar `s9-docker-proxy` en el host (VM108) y definir `DOCKER_PROXY_URL` en
   arena-engine + el secreto interno compartido (mismo fichero en api y arena-engine).
2. Definir `ARENA_ENGINE_URL`/`S9_ENABLE_REAL_BATTLE_RUNS=1` para la API (siguen apagados
   hoy; encenderlos es una decisión de despliegue, no de este bloque).
3. Crear una batalla en `#/battles/new` con bots firmados + mapa publicado → **Ejecutar batalla real**.
4. Verificar: 2 contenedores reales, batalla termina, replay ingerido (`GET /replays`), 7/7 núcleo sano.
5. Resolver los límites de traducción listados arriba. Mapas reales arbitrarios, ruleset real
   e ingesta de replay YA están resueltos (B6/B9) en el repo; falta validarlos en VM108 con
   una batalla real sobre un mapa del catálogo distinto de mvp-arena-01.
Solo entonces: **R6.2/R9-A**.

**Dictamen: R6.2/R9-B** — UI y endpoint preparados y seguros; B2 cablea el transporte
API→arena-engine→proxy con autenticación interna, gateado y con valores por defecto seguros;
pendiente validación operativa real en VM108 y la fidelidad de traducción listada arriba.
