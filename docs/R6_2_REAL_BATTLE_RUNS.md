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
`map_unplayable` (no es jugable para el motor), `map_mode_incompatible` (el mapa no tiene las
entidades que el modo exige — comprobado con `modeMapIncompatibilities()`, el mismo código del
motor que usa `createMode`), y `map_identity_mismatch` — **al volver**, el mapa de la cabecera
del replay debe ser exactamente el pedido; si el motor jugó otro mapa, la batalla es `failed`
y el replay NO se ingesta.

> **La comparación de vuelta es del mapa ENTERO, geometría incluida** (`sameArenaMap`), no de
> `mapId@version#checksum`. El `checksum` de un `ArenaMap` NO se deriva de su geometría:
> `toEngineMap()` lo copia del documento origen, así que quien fabrique la cabecera de un
> replay puede firmar cualquier geometría con la identidad del mapa pedido. El supervisor de
> B9 lo demostró con una batalla real (`proc-test-7` firmado como `mvp-arena-01`: la guarda
> por etiqueta la aceptó e ingestó, con 3 muros pedidos frente a 6 jugados). Comparar el mapa
> completo no da falsos positivos: `Battle` no muta `config.map` — el daño a los destructibles
> vive en `battle.destructibleHp`, un `Map` aparte.

**Ruleset/ticks — B9: resueltos (y arreglado un bug real).** Hasta B9 el launcher enviaba
`rulesetId: battle.mode` (`"deathmatch"`), que **no es** un ruleset del motor
(`dm_practice@1`, `tdm_mvp@1`...): `loadRuleset()` lanzaba dentro de `runContainerBattle` y
toda batalla real lanzada desde la API acababa en un 502 `battle_failed` genérico. Ahora
`apps/api/src/services/battle-ruleset-resolver.ts` traduce modo (+ `rulesets.config.engineRulesetId`
si la fila de BD lo declara) → ruleset REAL del motor, exigiendo que el modo coincida
(`ruleset_mode_mismatch` si no), y `ticks` sale de `ruleset.timeLimitTicks` en vez de un
20000 fijo. arena-engine, además, rechaza con **400** un `rulesetId` que no esté en su
catálogo, en vez de dejarlo explotar a mitad de batalla.

**Plazo de la llamada `POST /run` — derivado, no fijo.** El launcher abortaba a 30 s fijos.
Con el ruleset resuelto de verdad, `ticks = timeLimitTicks = 9000` ⇒ la batalla dura
`9000 × 34 ms ≈ 306 s`, y una práctica de 2 bots en deathmatch SIEMPRE agota el límite
(`scoreToWin: 5`, sin respawn: nadie hace 5 bajas). Es decir: con el timeout fijo, el caso
NORMAL habría sido `failed: "arena-engine no respondió en 30000ms"` con los contenedores vivos
otros cuatro minutos y el replay perdido — un timeout en lugar del 502, no una batalla que
funcione (bloqueante del supervisor de B9). El plazo sale ahora de
`packages/game-rules/battle-timing.ts`, el MISMO módulo del que el motor deriva su guard global
(`containerBattleOverallTimeoutMs`), de modo que la API siempre espera más que el motor: quien
se rinde primero es quien puede limpiar los contenedores. `ARENA_ENGINE_RUN_TIMEOUT_MS`
sobrescribe el plazo de forma absoluta si un operador lo necesita (un valor por debajo de la
duración teórica se registra como aviso).

**Límites que siguen abiertos tras B9** (no son huecos de seguridad; son fidelidad y alcance):

- `meta.supportedModes` del documento del mapa NO se comprueba contra el modo de la batalla.
  El motivo real (corregido tras la revisión del supervisor, la versión anterior de este
  párrafo era falsa): los DOS sitios donde vive esa información se contradicen para el mapa
  del seed — `db/seeds/dev.ts` guarda en la columna `supported_modes` el valor
  `mapDoc.supportedModes ?? ["deathmatch"]`, y el documento no tiene ese campo en la raíz
  (está en `meta.supportedModes`), así que la columna acaba con `["deathmatch"]` mientras el
  documento declara `["capture_the_flag","team_deathmatch"]`. Gatear con un dato inconsistente
  consigo mismo no aporta garantía: lo que B9 sí comprueba es la condición REAL y verificable
  (que el mapa tenga las entidades que el modo exige, `map_mode_incompatible`). Reconciliar
  columna y documento es trabajo propio del pipeline de mapas.
- `budget_credits`/`forbidden_categories` de la fila de `rulesets` de la BD siguen sin
  aplicarse al ruleset del motor (afectan a la validación de loadout, otra capa).
- **`zone_control` y `domination` no son jugables sobre NINGÚN mapa del catálogo actual**:
  los 21 mapas del repo suman 2 zonas y las dos son de daño — cero de captura, y esos dos
  modos exigen 1 y 2 zonas de captura respectivamente (`MODE_REGISTRY`, sim/modes.ts). El
  rechazo es correcto y ahora ocurre en la API (`map_mode_incompatible`, antes reventaba
  dentro del motor), pero mientras nadie publique un mapa con zonas de captura esos modos
  están disponibles en la API y no se pueden jugar. (Observación del supervisor de B9; no se
  arregla aquí: hacen falta mapas nuevos, que es trabajo del pipeline de mapas.)
- **Techo de recursos sorteable por el camino por defecto**: omitiendo `overallTimeoutMs` en
  el cuerpo de `/run` y pidiendo `ticks: 1_000_000` (el máximo que acepta la validación), el
  guard global derivado sale de ~9,45 h. Exige el secreto interno de arena-engine, así que no
  es un vector desde fuera; acotar el guard derivado, y no solo el que llega en el cuerpo,
  queda pendiente. (Observación del supervisor de B9.)
- **La colisión de checksum de `map-service/canonical.ts` sigue viva en `main`** y B9 se
  apoya en ese checksum para `map_checksum_mismatch`. NO afecta a la identidad del mapa
  jugado —que desde la revisión del supervisor es estructural, geometría completa— pero sí
  debilita ese mensaje concreto: un documento manipulado que lograra colisionar pasaría esa
  comprobación (y seguiría teniendo que pasar el validador de E4 y la comparación de vuelta).
- Nada de esto se ha probado contra Docker real — ver el informe de entrega del bloque
  correspondiente para qué se verificó con fakes y qué queda pendiente de VM108.
- **Bloqueo externo conocido (issue #92)**: el `botId` que la API envía en el cuerpo de
  `/run` es un UUID, mientras el esquema del HELLO del protocolo exige
  `^bot_[0-9a-zA-Z]{1,24}$`. Es ajeno a este bloque, pero es la razón por la que hoy ninguna
  batalla lanzada desde la web puede completarse todavía, ni siquiera con B9 dentro.

## Validación operativa en VM108 (gateada, NO en este PR)

Para pasar a **R6.2/R9-A** falta, sobre lo que ya cablea B2:
1. Desplegar `s9-docker-proxy` en el host (VM108) y definir `DOCKER_PROXY_URL` en
   arena-engine + el secreto interno compartido (mismo fichero en api y arena-engine).
2. Definir `ARENA_ENGINE_URL`/`S9_ENABLE_REAL_BATTLE_RUNS=1` para la API (siguen apagados
   hoy; encenderlos es una decisión de despliegue, no de este bloque).
3. Crear una batalla en `#/battles/new` con bots firmados + mapa publicado → **Ejecutar batalla real**.
4. Verificar: 2 contenedores reales, batalla termina, replay ingerido (`GET /replays`), 7/7 núcleo sano.
5. Resolver los límites de traducción listados arriba. Mapas reales arbitrarios, ruleset real
   e ingesta de replay están resueltos EN EL REPO (B6/B9), con motores falsos y batallas
   grabadas de verdad, pero **NINGUNA batalla real de extremo a extremo ha llegado a
   completarse desde la API todavía**: antes de B9 moría en un 502 (`rulesetId` inválido) y,
   con el ruleset ya resuelto, el plazo HTTP derivado (≈350 s para 9000 ticks) solo se ha
   ejercitado con relojes de test. Validación pendiente en VM108: una práctica completa
   (~5 min de batalla) que termine con `status: "completed"` y su replay ingerido, y otra
   sobre un mapa del catálogo distinto de `mvp-arena-01`.
Solo entonces: **R6.2/R9-A**.

**Dictamen: R6.2/R9-B** — UI y endpoint preparados y seguros; B2 cablea el transporte
API→arena-engine→proxy con autenticación interna, gateado y con valores por defecto seguros;
pendiente validación operativa real en VM108 y la fidelidad de traducción listada arriba.
