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

**Mapa — REQUISITO PENDIENTE, falla cerrado en vez de sustituir en silencio.** arena-engine
(contrato R6.2) solo entiende mapas-fixture (`"empty"|"mvp"|"ctf"`,
`apps/arena-engine/src/fixtures.ts`), no el catálogo real de mapas de la API. El launcher
(`battle-run-http-launcher.ts::FIXTURE_MAP_EQUIVALENTS`) mantiene una allowlist EXPLÍCITA de
qué `mapId`+`mapVersion` real tiene fixture equivalente; **hoy solo `mvp-arena-01` v1** (el
fixture `mvpArena()` usa el mismo `mapId`/`version` que el mapa publicado por el seed real).
Cualquier otro mapa se **rechaza** (`status: "failed"`, sin llegar a llamar a arena-engine) en
vez de jugarse con el fixture "mvp" por defecto: sustituir el mapa en silencio habría hecho
que alguien eligiera un mapa en la UI y se jugara otro sin enterarse — un fallo de integridad
que invalidaría la evidencia de una batalla (bloque B4), no un detalle cosmético. Soportar
mapas reales arbitrarios (que la batalla juegue la geometría real de cualquier mapa publicado,
no solo esta única equivalencia) es un **requisito pendiente**, fuera de alcance de B2: exige
que arena-engine acepte geometría de mapa en el cuerpo de `/run` en vez de un nombre de
fixture fijo. Nota aparte: incluso para `mvp-arena-01` v1, el fixture está marcado
"PROVISIONAL POR DISEÑO" en su propio fichero — su geometría puede no ser bit-a-bit idéntica
al JSON importado de Tiled hasta que E4 lo sustituya; es la mejor equivalencia disponible hoy,
no una garantía de fidelidad geométrica total.

**Otros límites conocidos de esta traducción, documentados y NO resueltos en B2** (no son
huecos de seguridad; son fidelidad de simulación pendiente): `rulesetId` se pasa tal cual
desde `battle.mode` (sin resolver contra el catálogo real de rulesets); `ticks` es un techo
fijo configurable, no derivado del ruleset; la respuesta no ingiere en replay-service
(`replay.ingested` queda `false` siempre). Nada de esto se ha probado contra Docker real — ver
el informe de entrega del bloque B2 para el detalle de qué se verificó con fakes y qué queda
pendiente de VM108.

## Validación operativa en VM108 (gateada, NO en este PR)

Para pasar a **R6.2/R9-A** falta, sobre lo que ya cablea B2:
1. Desplegar `s9-docker-proxy` en el host (VM108) y definir `DOCKER_PROXY_URL` en
   arena-engine + el secreto interno compartido (mismo fichero en api y arena-engine).
2. Definir `ARENA_ENGINE_URL`/`S9_ENABLE_REAL_BATTLE_RUNS=1` para la API (siguen apagados
   hoy; encenderlos es una decisión de despliegue, no de este bloque).
3. Crear una batalla en `#/battles/new` con bots firmados + mapa publicado → **Ejecutar batalla real**.
4. Verificar: 2 contenedores reales, batalla termina, replay ingerido (`GET /replays`), 7/7 núcleo sano.
5. Resolver los límites de traducción listados arriba: mapas reales arbitrarios (hoy solo
   mvp-arena-01 v1 tiene equivalente y todo lo demás se rechaza en vez de sustituirse),
   ruleset real, ingesta de replay.
Solo entonces: **R6.2/R9-A**.

**Dictamen: R6.2/R9-B** — UI y endpoint preparados y seguros; B2 cablea el transporte
API→arena-engine→proxy con autenticación interna, gateado y con valores por defecto seguros;
pendiente validación operativa real en VM108 y la fidelidad de traducción listada arriba.
