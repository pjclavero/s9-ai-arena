# Auditoría consolidada — S9 AI Arena (2026-07-16)

> Documento único de referencia que **sintetiza tres auditorías independientes** sobre el
> mismo repositorio y las reconcilia con el **estado real del código** (verificado ejecutando
> las suites y leyendo el árbol, no fiándose de los documentos).
>
> - **Auditoría interna A (esta casa):** cuatro frentes — seguridad, motor/combate,
>   visor/gráficos y gestión/estado — con verificación en código (`archivo:línea`) y
>   ejecución de `tsc`/`vitest`.
> - **Auditoría externa B** ("Auditoría completa · capítulos 1–11"): estructurada por
>   capítulos, con puntuación de salud 7,1/10.
> - **Auditoría externa C** ("Auditoría técnica · dictamen ejecutivo"): dictamen de madurez
>   por áreas y plan P0–P3.
>
> Las **tareas ejecutables** derivadas de este documento viven en el dosier, parte nueva
> **[Ronda 2](Dosier_tareas_S9_AI_Arena.md#15-ronda-2--remediación-integración-evolución-y-retirada-de-v1)**.
> Aquí están los **hechos, los errores y la corrección técnica**; allí, quién hace qué y cómo se prueba.

---

## 1. Cómo se comparan las tres auditorías

Las tres coinciden en el diagnóstico de fondo — *base técnica excelente, madurez operativa
por detrás, documentación desalineada* — pero difieren mucho en exactitud, y esa diferencia
importa porque marca en qué informe se puede confiar para planificar.

### 1.1 Veredicto sobre cada auditoría

**Auditoría B (por capítulos, 7,1/10) — desactualizada en lo esencial.** Describe un
proyecto que ya no existe: afirma que "solo E1 y E2 están completados", "81 pruebas",
"sin CI/CD visible (no se encuentra .github/workflows)", "catálogo provisional en fixtures",
"RBAC definido pero sin implementación", "sin sistema de persistencia de torneos ni ranking"
y "deathmatch no implementado en modes.ts". **Todo eso es falso en el repo actual** (ver §2).
B leyó, casi con certeza, el README obsoleto y no el código. Sus **soluciones genéricas** son
razonables como checklist (autenticar el gateway, logging estructurado, pooling de
proyectiles), pero varias ya están hechas y otras atacan un proyecto que no es este. **Valor:
bajo como estado; medio como inventario de buenas prácticas.** Sus dos aciertos concretos y
vigentes: `radioSentThisSecond` como fuga (coincide con nuestro hallazgo) y la observación de
que el visor no dibuja paredes/banderas/zonas.

**Auditoría C (dictamen de madurez) — actual y en gran medida correcta.** Clava el estado:
"alfa técnica avanzada… no preparada para abrir competiciones con bots no confiables",
identifica **el bug de munición (#15)** como crítico, el **montaje de `docker.sock`** como
riesgo máximo, la discrepancia **`published` vs `validated`**, las **dos formas de
`battle_stats`**, la **coexistencia de dos proyectos**, el **README obsoleto**, la **CI
permisiva con `continue-on-error`** y la falta de despliegue v2 real. Su plan P0–P3 es
sólido. **Valor: alto.** Sus imprecisiones son menores y de matiz: da por no cableados el
directo y las estadísticas del torneo (H2/H3), que **sí se cerraron** recientemente (ver
§2.3); y su tabla de madurez es cualitativa, sin `archivo:línea`.

**Auditoría A (esta casa) — la más profunda en fallos silenciosos.** Aporta lo que ninguna
de las otras dos vio, porque exige leer el código de ejecución y no solo su forma:

- El **sensor acústico está muerto** y un **test vacuo** lo oculta (§3, ERR-ENG-01).
- El **lint de determinismo no cubre el fichero del RNG** — la regla que protege la
  reproducibilidad no vigila la pieza de la que depende (ERR-ENG-02).
- El **secreto JWT degrada a una constante pública** en el despliegue real (ERR-SEC-01).
- El **sandbox nunca ejecuta un bot**: el pipeline por defecto salta las etapas que lo harían
  y **devuelve "pasado"** (ERR-SEC-03).
- El **job de CI del sandbox pasa siempre en verde sin probar nada** (`|| true` + digest
  `:PENDIENTE`) (ERR-SEC-04).
- El **rate-limit y el bloqueo de fuerza bruta se computan sobre la IP del gateway**, lo que
  habilita un DoS de cuota global y un bloqueo dirigido de cuentas (ERR-SEC-05).
- El **visor v2 no tiene ni un solo asset** y **el replay no interpola** (se ve a saltos),
  y **no hay pantalla de torneos** en el panel (§5).
- `zone_control` **no es jugable** (puntúa con la zona vacía; los objetivos no llevan id/posición).

### 1.2 Matriz de acuerdo

| Tema | A (casa) | B (capítulos) | C (madurez) | Realidad verificada |
|---|---|---|---|---|
| Entregas hechas | E1–E12 | **E1–E2 (error)** | E1–E12 | **E1–E12** (§2.1) |
| CI existe | Sí, permisiva | **"No existe" (error)** | Sí, permisiva | 4 workflows, `continue-on-error` en tsc (§2.6) |
| RBAC implementado | Sí (fortaleza) | **"Sin implementación" (error)** | — | Sí, derivado de OpenAPI (§4) |
| Bug de munición #15 | — (lo confirma gestión) | No | **Sí (crítico)** | **Confirmado** (§2.2) |
| docker.sock | **Sí (crítico C2)** | No | **Sí (máximo)** | Confirmado (ERR-SEC-02) |
| Sandbox no ejecuta bots | **Sí (crítico C3)** | No | Parcial | Confirmado (ERR-SEC-03) |
| Sensor acústico muerto | **Sí (único)** | No | No | Confirmado (ERR-ENG-01) |
| Visor sin assets | **Sí (detallado)** | Parcial | Sí | Confirmado (§5) |
| Directo/stats de torneo cableados | Sí (H2/H3 cerrados) | — | **No (desfasado)** | **Sí, cerrados** (§2.3) |
| Dos proyectos v1/v2 | Sí | No | **Sí** | Confirmado (§2.7) |
| README obsoleto | Sí | No (lo padece) | **Sí** | Confirmado (§2.1) |

---

## 2. Estado real (lo que hay que creer)

### 2.1 Las 12 entregas están hechas; el README mentía

`docs/estado-proyecto.md` y `docs/auditoria-2026-07-16.md` ya lo decían; el README no se
actualizó tras la fusión E1+E2 y se quedó anclado en "E1/E2 completados, E3 próximo".
**Corregido en este ciclo** (README reescrito). Las 12 carpetas de entrega existen con código
y tests: contratos, motor, módulos, mapas, protocolo+SDKs (incluidos esbozos Java/.NET),
seguridad, plataforma (API + web), visor/replays, torneos, DevOps, streaming y QA.

**La línea divisoria real de todo lo pendiente es una sola:** hasta ahora no existía un
entorno con Docker y salida a internet donde verificar el sandbox, construir las imágenes y
desplegar la v2. Lo pendiente es **verificación, integración y despliegue**, no desarrollo —
salvo los errores de código que este documento cataloga.

### 2.2 Bug de munición (#15) — CRÍTICO funcional, confirmado

Un bot construido con el editor/API real **dispara `no_ammo` y nunca hace daño.** La cadena:

- La forma canónica del loadout pone la munición como propiedad del arma
  (`{ slot:"turret_main", moduleId:"weapon.cannon@1", ammo:"ammo.ap@1" }`), sin módulo de
  munición aparte. Es lo que produce el editor (`apps/web/src/pages/LoadoutEditor.tsx:69`) y
  lo que valida E3 (`packages/module-catalog/validator/index.ts:151`).
- **`resolveVehicle` ignora `entry.ammo`**: `packages/module-catalog/resolve/index.ts:87`
  mapea solo `loadout.modules` 1:1 y nunca lee `ammo`. El `VehicleSpec` sale sin munición.
- En el motor, `combat.ts:184` `ammoFor()` recorre `modulesOf("ammo")` → vacío → `fire()`
  devuelve `null` y el disparo se resuelve como `"no_ammo"` (`combat.ts:156`).

**Por qué nadie lo vio:** los fixtures `resolve/archetypes.ts` **duplican la munición a mano**
(añaden un módulo `ammo_main` además de la propiedad `ammo:` del arma), y los golden de
`resolve/index.test.ts` se comparan contra esos fixtures pre-expandidos. Es un "resolvedor
alternativo" incrustado en el fixture. El E2E de torneo usa un loadout SIN ese doble-ammo,
así que ahí los bots **sí** salen sin munición, pero el test solo comprueba que haya campeón
y clasificación, nunca que se dispare. → **ERR-ENG-08.**

### 2.3 Hallazgos H1–H7 de la auditoría previa: 5 cerrados, 2 abiertos

| | Estado | Evidencia |
|---|---|---|
| H1 builtins peligrosos bloquean | **Cerrado** | `bot-manager/src/static-analysis.ts:175` política `block` por defecto |
| H2 directo del torneo (`attachBattle`) | **Cerrado** | `tournament-worker/src/engine-executor.ts:162` |
| H3 `runStatsJob` + `battle_stats` canónico | **Cerrado** | `battle-runner.ts:169`; test guardián `battle-stats-canonical.test.ts` |
| H4 CI construye 8 imágenes | **Cerrado** | `ci.yml:113` matrix de 8 servicios |
| H5 `cpuMs` sin rellenar | **Abierto** (P3, depende del runner) | `replay-service/src/stats.ts:110` persiste `null` |
| H6 rutas rating/standings por equipos | **Cerrado** | `routes/standings.ts:29`, `routes/tournaments.ts:199` |
| H7 errores de tsc | **Abierto de verdad** | ver §2.5 |

Nota: las auditorías externas B y C no reflejan el cierre de H2/H3 (directo y estadísticas
del torneo); a día de hoy **sí** están cableados.

### 2.4 Discrepancias de contrato: cerradas

- **`published` vs `validated`:** cerrada. El pipeline marca `validated` (17.1 de E7) con
  evento `build.validated` (`bot-manager/src/pipeline.ts:115`); test de aceptación dedicado.
- **`battle_stats` con dos formas:** cerrada. Una sola forma canónica jsonb escrita por
  `runStatsJob`; el worker ya no escribe en la transacción de fin de batalla
  (`battle-runner.ts:242`).

### 2.5 Errores de tsc: 268 reales, no 2

`npx tsc --noEmit` (el comando exacto de CI) devuelve **268 errores en 23 archivos**, no los
"2" que documentan los papeles:

- **~230 en `apps/web/**`** son un **error de configuración**, no de código: el `tsconfig.json`
  raíz incluye `apps/**/*` sin `"jsx"` y sin excluir `apps/web` (que sí tiene su propio
  tsconfig con `react-jsx`). Se arreglan **excluyendo `apps/web` del tsconfig raíz** o dándole
  su propio proyecto en el typecheck. → **ERR-GES-02.**
- **38 errores genuinos** repartidos: `routes/bots.ts` (14), `battles.ts` (6), `standings.ts`
  (2), `catalog.ts` (1) — casi todos `TS2345 'string | string[]'` en query params, **varios
  introducidos por los propios fixes de H6**; `maps.ts:54` (`supportedModes`);
  `arena-engine/src/sim/battle.ts:411,420` (los 2 de E2 ya documentados);
  `bot-manager/src/pipeline.ts:96`; `streamer/src/main.ts:23`; `tournament-worker/src/redis-signal.ts:76`.
  → **ERR-GES-03.**

Todo esto pasa desapercibido porque el paso de tipos de la CI lleva `continue-on-error: true`
(`ci.yml:46`). H7 **no** está cerrado.

### 2.6 Suite de tests: verde en Linux, roja por entorno en Windows

- **Linux (ia-server), documentado:** 646 pasan / 1 falla (zstd en Node 20) / 3 skipped.
- **Windows (host del usuario), medido ahora:** 542 pasan / 9 fallan / 122 skipped; **22
  ficheros fallan** todos por el mismo motivo: el PostgreSQL embebido (`embedded-postgres`,
  `pg_ctl`) no arranca/migra de forma fiable en Windows (`relation "users" does not exist`).
  Es **fallo de entorno**, no de lógica. → tarea de robustez de tests (**ERR-GES-04**).

No hay tests deshabilitados (`.skip`/`.todo`) ni marcadores `FIXME`/`HACK` reales.

### 2.7 Dos proyectos superpuestos — confirmado

- **v1 (prototipo, desplegado):** `docker-compose.yml` de la raíz con `arena-server` (WS
  :8081), `arena-viewer` (**Phaser 3**), `bots/bot-red`, `bots/bot-blue`. Es lo único vivo en
  producción (VM108, tras el proxy de VM104).
- **v2 (producto real):** `apps/web` (React+Vite, **Phaser 4**) y el resto de servicios. **No
  aparece en el compose raíz**; solo en `infrastructure/docker-compose.yml`.

Convivir con Phaser 3 y 4, dos protocolos y dos rutas de despliegue es una fuente permanente
de confusión y de "desplegar el sistema equivocado". → **plan de retirada de v1** (Ronda 2, R-V1).

---

## 3. Catálogo consolidado de errores con corrección técnica (sin código)

Ordenado por severidad. Cada error tiene un ID citado por las tareas del dosier. La columna
"corrección" describe **qué hacer**, no cómo escribirlo.

### 3.1 Seguridad

| ID | Sev | Error (archivo:línea) | Corrección técnica |
|---|---|---|---|
| **ERR-SEC-01** | Crítica | Secreto JWT degrada a constante pública: `auth/tokens.ts:15` cae a `"dev-only-jwt-secret"`; el Compose inyecta `JWT_SECRET_FILE` que **nadie lee**, y `NODE_ENV` no se define en ningún sitio, así que el guard de producción nunca dispara. Los tickets de espectador se firman con ese mismo secreto. | Leer secretos **por archivo** (`*_FILE`) con precedencia y **fallar el arranque si no hay secreto explícito**, sin depender de `NODE_ENV` (invertir: exigir secreto salvo modo dev declarado). Eliminar el literal. Separar el secreto de tickets del de sesión y darles `audience`/`issuer` distintos. Test: arrancar sin secreto lanza. |
| **ERR-SEC-02** | Crítica | `bot-manager` monta `/var/run/docker.sock` en RW (`infrastructure/docker-compose.yml:238`) — RCE en el servicio que procesa código de usuario = root en el host. El escáner de Compose lo **whitelistea**, contradiciendo a `container-runner.ts:89` que lo marca como violación. | Eliminar el montaje directo. Interponer un **proxy de API de Docker** con allowlist estricta (crear/arrancar/parar/inspeccionar) que rechace `privileged`, bind-mounts, `--network host` y cambios de usuario; o Docker rootless / runtime con aislamiento de kernel (gVisor/Kata). Retirar la excepción del escáner; `complianceViolations` como única fuente de verdad. Aislar el nodo de build sin acceso a BD/secretos/backups. |
| **ERR-SEC-03** | Crítica | El pipeline por defecto (`E6PipelineBotManager`) se construye **sin `agentResolver`**; `resolveOrSkip` marca `skipped` y **retorna como "pasado"** las tres etapas que ejecutan el bot (`protocol_test`, `smoke_battle`, `resource_limits`). Ninguna ruta ejecuta un bot en sandbox; un bot llega a `validated` sin correr jamás. | **Fallar cerrado:** la ausencia de resolver debe **rechazar** el build, no aprobarlo. Distinguir en el tipo de retorno "etapa superada" de "etapa no ejecutable" y tratar la segunda como bloqueante para pasar a `validated`. Mientras no haya Docker, el estado honesto es `rejected` o "no verificable", nunca `validated`. |
| **ERR-SEC-04** | Alta | El job de CI del sandbox pasa **siempre en verde sin probar nada**: usa la imagen `...@sha256:PENDIENTE` y cada `docker run` lleva `|| true`, así que el fallo de arranque se traga y se imprime "OK". Falsa garantía que **oculta** ERR-SEC-03. | Capturar el código de salida de `docker run` por separado y **abortar si el contenedor no llegó a ejecutarse**; exigir que cada bot hostil emita un marcador positivo de "intenté el ataque y fui bloqueado" (silencio = fallo). Rechazar digests placeholder con el guard existente. Marcar el job **skipped**, nunca passed, mientras no haya runner con Docker. |
| **ERR-SEC-05** | Alta | Sin `trust proxy` en Express: `req.ip` es la IP del gateway para **todas** las peticiones. La cuota anónima degenera en cubo global (un atacante agota `spectate-ticket` para todos) y el bloqueo de login se vuelve `<gateway>\|<email>` → **bloqueo dirigido** de cualquier cuenta cuyo email se conozca. | Configurar confianza de proxy **acotada** al salto/rango del gateway (no genérica), coherente con el modo "detrás de VM104" (dos saltos). Test: un `X-Forwarded-For` inyectado desde fuera no altera la clave de límite. |
| **ERR-SEC-06** | Alta | Análisis estático evadible y `os` permitido: `DEFAULT_PYTHON_DANGEROUS` no incluye `os` (ni `importlib`, `pickle`, `pty`…); el parseo es regex línea a línea. Con ERR-SEC-03, es la **única** barrera real. | Ampliar la lista con `os` y módulos de proceso/FFI/serialización; sacar `os`/`process` de las listas permitidas; sustituir el regex por **análisis del AST real** de cada runtime (detecta imports dinámicos, `eval`/`exec`, acceso a `__builtins__`). Entender que esto es defensa en profundidad: la barrera real es el sandbox (ERR-SEC-03). |
| **ERR-SEC-07** | Alta | Desactivar 2FA (`routes/auth.ts:191`) solo pide un access token válido: un token robado anula el segundo factor de forma permanente y silenciosa. | Exigir **reautenticación fuerte** (contraseña + TOTP/recuperación vigente) para desactivar 2FA; auditar el intento; revocar el resto de sesiones al cambiar el estado. Alta de 2FA en dos pasos (secreto pendiente confirmado con un código). |
| **ERR-SEC-08** | Alta | Refresh tokens sin detección de reutilización, sin vida máxima absoluta (cada refresh reestablece +14 días → sesión eterna) y sin rate-limit (`routes/auth.ts:120`). | Familias de tokens: ante un token ya rotado, **revocar toda la familia** y auditar robo probable. Caducidad absoluta fijada en la creación que el refresh no extienda. Aplicar el limitador existente. |
| **ERR-SEC-09** | Media | Inyección en `Content-Disposition`: `source_filename` (de `file.originalname`) se interpola sin escapar (`routes/bots.ts:245`); comillas/CRLF permiten spoofing de nombre o un 500. | Normalizar el nombre al recibirlo (base, allowlist de caracteres, longitud acotada); emitir la cabecera con la **codificación estándar** de parámetros, con nombre por defecto derivado del id de versión. |
| **ERR-SEC-10** | Media | Subida sin validación de tipo/contenido; `decodePackage` acepta cualquier `path` (`../`, absolutos, control) — latente hoy (almacén en `bytea`), traversal de escritura en cuanto exista el resolver de ERR-SEC-03. | Validar el paquete con **esquema estricto** (ajv, ya usado en el motor): rechazar toda ruta no relativa/normalizada/contenida, sin `..`. Exigir el manifiesto en la raíz exacta. Verificar tipo por contenido real; limitar número de ficheros. |
| **ERR-SEC-11** | Media | Enumeración de usuarios por temporización en login (`routes/auth.ts:90`): si el email no existe, no se ejecuta Argon2id (cortocircuito). | Ejecutar **siempre** una verificación Argon2id contra un hash señuelo cuando el usuario no existe, descartando el resultado. Coherente con `recover`, que ya lo hace. |
| **ERR-SEC-12** | Media | Firma de artefactos con clave efímera (`e6-bot-manager.ts:81` genera par nuevo por instancia): la firma es correcta pero **inverificable** después; no hay cadena de custodia. | Cargar la clave privada del **almacén de secretos**, publicar la pública, rechazar arranque sin ella, y **verificar** la firma antes de cada lanzamiento. |
| **ERR-SEC-13** | Media | `allowScripts` en `package.json` es inerte: no hay `@lavamoat/allow-scripts` instalado; `npm ci` en CI corre scripts de instalación de todo el árbol. | Instalar la herramienta que da sentido al campo **o** adoptar `--ignore-scripts` global y reconstruir explícitamente los 3 paquetes nativos. Un control que solo existe como declaración induce a error. |
| **ERR-SEC-14** | Media | Limitadores en memoria (`rate-limit.ts`): no compartidos entre réplicas, se limpian al reiniciar y **nunca se podan** (crecen sin cota). | Trasladar el estado al **almacén compartido** (Redis/tabla `api_usage`). Mientras, añadir expiración y cota de claves. |
| **ERR-SEC-15** | Media | Build síncrono dentro de la petición HTTP: `submitBotVersion` corre el pipeline entero en el proceso de la API (`enqueueBuild` no encola). Cualquier `developer` (rol automático al registrarse) satura el event loop de la API. | **Encolar de verdad** en la tabla `jobs` (patrón ya usado en batallas) y devolver 202; el worker consume. Rate-limit por usuario a la creación de versiones. |
| **ERR-SEC-16** | Baja | Varias: `jwt.verify` sin fijar algoritmo/`audience`; `SPECTATE_WS_URL` por defecto en claro con el ticket en la query (acaba en logs de Nginx/Loki); códigos de recuperación de 48 bits sin sal; HSTS emitido por la API en vez del terminador TLS; `SERVICE_ENTRY` de la API apunta a `main.ts` inexistente (el real es `server.ts`) — el contenedor de la API **no arranca** en el Compose actual. | Fijar algoritmo y separar por `audience`; transportar el ticket fuera de la URL y exigir `wss`; subir entropía y usar KDF con sal; mover HSTS al gateway; corregir el entrypoint. |

**Correctamente mitigado (no tocar):** sin inyección SQL (todo por knex parametrizado);
Argon2id; refresh hasheado con rotación; revocación efectiva (sesión consultada en cada
request); **RBAC derivado del OpenAPI** con test de matriz rol×endpoint; control de acceso a
objeto con 404 en vez de 403; recuperación que no enumera y no toca el 2FA; CORS estricto;
segmentación de red con redes `internal`; guard de digests placeholder que falla cerrado;
ticket de espectador de un solo uso con `debug` firmado por el servidor. Es una base de
seguridad muy por encima de la media para un proyecto de este tamaño.

### 3.2 Motor y sistema de combate

| ID | Sev | Error (archivo:línea) | Corrección técnica |
|---|---|---|---|
| **ERR-ENG-01** | Crítica (funcional) | **Sensor acústico muerto:** `battle.ts:193` hace `this.sounds = []` **justo antes** del bucle que construye observaciones, así que el acústico siempre lee un array vacío. El test que debería cogerlo (`sensors-fog.test.ts:241`) está guardado con `if (acoustic.sources.length > 0)` y **pasa vacuamente**. Además `observationFor()` lee `this.sounds` en otro instante → las dos rutas de observación ven cosas distintas. | **Doble búfer:** servir a las observaciones el búfer del ciclo anterior e intercambiar **después** de construir todas las observaciones. Unificar las dos rutas de observación. **Endurecer el test** para que exija sonidos, no que los tolere ausentes. |
| **ERR-ENG-02** | Alta (determinismo) | **El lint de determinismo no cubre el RNG:** `lint-determinism.mjs:18` fija `SIM_DIR = src/sim`, pero `rng.ts`, `replay.ts`, `stubs.ts` y `fixtures.ts` están **fuera**. Un `Math.random()` en `rng.ts` pasa la CI en verde — justo la pieza de la que depende toda la reproducibilidad. | Invertir la carga: vigilar **todo `src/`** con una **lista de exclusión** explícita y comentada para los pocos ficheros que usan reloj real (`protocol-server.ts`, `cli.ts`). Un fichero nuevo queda vigilado por defecto. |
| **ERR-ENG-03** | Alta (jugabilidad) | **`zone_control` no es jugable:** puntúa con la zona **vacía** (`modes.ts:302`, `teamsInside.size <= 1` incluye 0) → el primero que toca y se va gana en ~16 s; y `objectives()` (`modes.ts:309`) no da `id` ni posición, con >1 zona el bot no puede decidir a cuál ir. | Separar **propiedad de puntuación** (puntuar solo con presencia real) o introducir decaimiento/neutralización tras N ticks vacía. Incluir `id` y posición de cada zona en los objetivos (son públicos por definición del modo). |
| **ERR-ENG-04** | Media (auditoría) | **Punto ciego del hash de estado:** `stateHash` (`battle.ts:647`) no incluye nada del solver de Rapier (islas, cuerpos dormidos, contactos); una divergencia sub-1e-5 es invisible al hash pero sigue viva. Y `verify()` tiene resolución de 30 ticks (`hashEveryNTicks` por defecto), así que `divergedAtTick` solo señala múltiplos de 30. | Añadir al canónico el nº de cuerpos despiertos y el conteo de contactos (coste casi nulo). Exponer `hashEveryNTicks` como parámetro del ruleset para auditar impugnaciones con hash por tick. |
| **ERR-ENG-05** | Media | **Estado global mutable en combate:** `combat.ts:176` declara `headingCache` a nivel de módulo, compartido entre batallas del proceso; `vehicleHeadingOf` devuelve 0 sin entrada → en el primer tick un arma con arco parcial se valida contra heading 0. Latente porque ningún arma v1 declara `turretArcRad`. | Mover el heading a un **campo de `Vehicle`**, no a un caché global paralelo. |
| **ERR-ENG-06** | Media (memoria) | **Dos fugas acotadas:** `radioSentThisSecond` (`battle.ts:94`) se indexa por `id:segundo` y **nunca se purga**; `radioQueue.filter()` reasigna el array cada tick aunque esté vacío. (Coincide con el hallazgo de la auditoría B.) | Contador por vehículo que guarde el segundo y se reinicie al cambiar; guard de longitud en la cola. |
| **ERR-ENG-07** | Media (trampa config) | **`deathmatch` no fuerza su premisa:** puntúa por equipo asumiendo "cada vehículo es su equipo", pero no lo valida; con `dm_practice@1` y dos vehículos del mismo equipo, nadie puntúa nunca. Simétrico: el `captured` de la bandera es un estado inalcanzable (se asigna y se sobrescribe en el mismo tick). | El modo debe **rechazar en construcción** una lista de participantes donde dos compartan equipo en DM. Revisar la FSM de bandera para que el estado intermedio sea observable o eliminarlo del enum. |
| **ERR-ENG-08** | Crítica (funcional) | **Munición no propagada (#15).** Ver §2.2. | `resolveVehicle` debe leer `entry.ammo` y materializar el módulo de munición correspondiente. **Prueba vertical obligatoria** loadout→resolución→disparo→impacto→stats. Quitar el doble-ammo de los fixtures para que los golden reflejen la forma canónica. |
| **ERR-ENG-09** | Baja (rendimiento) | Asignaciones por frame: `poses()` reconstruye un Map 2×/tick; búsquedas `find()` lineales dentro de bucles lineales (`damageVehicle`, `resolveProjectiles`); `stateHash` con `JSON.stringify`+sha cada 30 ticks. Techo práctico ~8–16 bots. | Buffer de poses reutilizado in-place; índice `Map<id,Vehicle>` construido una vez; mantener el sort de módulos estable. No urgente al dimensionado actual. |

### 3.3 Visor, gráficos y front

| ID | Sev | Error (archivo:línea) | Corrección técnica |
|---|---|---|---|
| **ERR-VIS-01** | Alta (producto) | **El replay no interpola:** `ReplayPage.tsx:57` llama a `resetTo` en cada frame, que borra `prev` del interpolador → el replay se ve a **10 saltos/s a 1×** mientras el directo va suave. | El reproductor debe **empujar snapshots** con el instante derivado del playhead y usar `resetTo` solo tras un seek. Idealmente, la escena acepta un "tiempo de reproducción" explícito para que interpole igual en directo y en replay. |
| **ERR-VIS-02** | Alta (producto) | **No hay pantalla de torneos ni de batallas** en el panel: el visor/replay solo son accesibles **tecleando el hash con un UUID a mano** (`App.tsx:22`). No se puede crear/ver/seguir un torneo desde la web pese a que el backend está. | Añadir rutas y componentes de **torneos, batallas e historial**, con enlaces desde bot→batallas→replay. Es el mayor agujero de usabilidad. |
| **ERR-VIS-03** | Alta (producto) | **La sesión se pierde al recargar (F5):** el token vive en una variable de módulo (`api.ts:13`), nunca se persiste; no hay manejo de 401 → cada pantalla falla en silencio al caducar. | Persistir la sesión (cookie httpOnly emitida por la API) e interceptor único que ante 401 refresque o limpie sesión y redirija con mensaje. |
| **ERR-VIS-04** | Alta (producto) | **El editor de loadout no carga el existente:** se monta sin `key` ni props del bot (`BotsPage.tsx:127`); siempre arranca en blanco y conserva el estado del bot anterior. No se puede editar un loadout guardado. Tres `!` en el render revientan la pantalla si el catálogo viene incompleto (sin error boundary). | Cargar la revisión vigente, `key={bot.id}` para remontar, ofrecer duplicar/comparar. Añadir error boundary y quitar los non-null assertions. |
| **ERR-VIS-05** | Media | **Cero apartado gráfico:** no hay un solo asset en el repo; todo son primitivas (rectángulos, un `Arc` de 2 px para proyectiles — invisibles a zoom global). Banderas, zonas, bases, barras de vida y minimapa **no se dibujan** aunque el overlay ya tiene los datos. El visor legacy (Phaser 3) es gráficamente más rico que el bueno. | Ver §4 (mejoras gráficas). No es un bug puntual sino contenido ausente: es trabajo de un equipo de arte + integración. |
| **ERR-VIS-06** | Media | **Interpolación frágil:** sin extrapolación ni clamp de hueco (los vehículos se congelan y saltan con jitter); el span se mide por tiempo de **llegada**, no por delta de ticks; los proyectiles no interpolan (parpadean a 10 Hz); la niebla se aplica **antes** de interpolar → teletransporte al entrar en visión. | Interpolar sobre delta de ticks con reloj de reproducción y delay-buffer; simular proyectiles balísticos localmente; filtrar niebla **después** de interpolar con fundido e histéresis. Añadir `serverTimeMs` al snapshot. |
| **ERR-VIS-07** | Media | **El canvas no se redimensiona** (sin `scale`, resolución fija del primer paint, borroso en HiDPI); `Phaser.AUTO` cae a Canvas2D en `/broadcast` (Chromium `--disable-gpu`) sin batching; sin control de FPS. | Modo de escala `RESIZE` + `devicePixelRatio`; forzar WebGL con SwiftShader en el streamer; fijar el FPS objetivo por vista. |
| **ERR-VIS-08** | Media | **Reconexión del espectador sin backoff** (delay fijo 1 s ×30 = estampida), sin heartbeat (conexión zombi), y el fallo inicial de `connect()` se pierde en silencio (`ViewerPage.tsx:59`). `state.events` crece sin límite. | Backoff exponencial con jitter y tope; watchdog de cliente; enrutar el fallo inicial al bucle de reconexión; buffer circular de eventos. |
| **ERR-VIS-09** | Media | **Sin batching:** todo son Shapes/Text (no Sprites de atlas) → 35–40 draw calls/frame para lo que debería costar 1; el pool de proyectiles solo crece; `frameOf`/`applyCamera` asignan objetos por frame pese al comentario "cero allocs". Sin medición de FPS. | Atlas de texturas + Sprites con `setTint`; `BitmapText`; hornear la capa estática a `RenderTexture`; pool con techo; reutilizar mapas en el camino caliente; contador de FPS y prueba de rendimiento en CI (Playwright). |
| **ERR-VIS-10** | Media (a11y) | Sin `<form>` (no se envía con Enter), sin labels visibles (solo `aria-label`+placeholder), sin `role="alert"`, sin `:focus-visible`, sin responsive (todo `max-width:960` y `height:640` fijos), sin error boundary, contrastes que rozan AA, texto de dominio en inglés crudo. | Formularios con `onSubmit`; labels visibles; regiones `aria-live` para feed/estado; foco visible; media queries; error boundary; i18n mínima; revisar contraste. |
| **ERR-VIS-11** | Baja | Re-render de React a 60 fps en el replay (`setTick` por frame de RAF); `await` de red dentro del bucle de RAF (`player.advance()`→`fetch`) → micro-congelación al cruzar chunk; `seekTick` dispara un fetch por cada `onChange` del slider (carrera). | Tick en un ref publicado con throttling; prefetch del chunk N+1 fuera del render; seek al soltar el slider con `AbortController`. |

### 3.4 Gestión, estado, CI e integración

| ID | Sev | Error | Corrección técnica |
|---|---|---|---|
| **ERR-GES-01** | Alta (confianza) | **README obsoleto** (decía E1/E2 de 12). Induce a auditores y colaboradores a error — B cayó en él. | **Hecho en este ciclo.** README reescrito como portada estable con v1/v2 y punteros a `estado-proyecto.md` como fuente de verdad. Mantener la disciplina. |
| **ERR-GES-02** | Media | tsconfig raíz incluye `apps/web` sin `jsx` → ~230 falsos errores de tsc que ahogan los reales. | Excluir `apps/web` del tsconfig raíz o darle su proyecto propio en el typecheck. |
| **ERR-GES-03** | Media | 38 errores de tsc genuinos (query params `string\|string[]`, varios de los fixes de H6), ocultos por `continue-on-error`. | Corregir los 38 (normalizar query params, tipar). Quitar `continue-on-error` del paso de tipos para que **rompa** la CI. H7 no está cerrado hasta que tsc dé 0. |
| **ERR-GES-04** | Media | 22 ficheros de test fallan en Windows por PostgreSQL embebido (`pg_ctl`). Fallo de entorno, pero bloquea el desarrollo local en Windows. | Documentar el requisito y/o dar una ruta a Postgres en contenedor/servicio para los tests, y una etiqueta para separar los tests que exigen BD. |
| **ERR-GES-05** | Media | CI permisiva: `continue-on-error` en tsc; paso de "Formato" es un `echo`; sin paso de cobertura; `deploy-staging` y `smoke-and-promote` son **stubs** que salen 0 sin `STAGING_HOST`. | Separar resultados **verde/amarillo/rojo**: no presentar como despliegue exitoso una ejecución que solo omitió staging. Hacer bloqueantes tipos y seguridad. Añadir cobertura y formateador reales. |
| **ERR-GES-06** | Media | `DIGESTS.lock` con placeholders (`sha256:000…0`, `1111…1`); guard añadido pero digests reales sin fijar (bloqueado por falta de Docker con red). | Construir las imágenes de runtime en un entorno con Docker+red y **fijar los digests reales**; el despliegue debe rechazar placeholders, `latest`, imágenes sin firma ni SBOM. |
| **ERR-GES-07** | Baja | `cpuMs` persiste `null` (H5): depende del runner containerizado. | Rellenar al medir CPU en el sandbox real (parte de la fase con Docker). Desglosar decisión/bloqueo/mensajes/timeouts. |
| **ERR-GES-08** | Baja (gobierno) | Sin `SECURITY.md`, sin Dependabot/Renovate, protección de rama por confirmar, IPs/VMs internas en docs públicas. | Añadir política de reporte de vulnerabilidades, actualización automatizada de dependencias, protección de `main` gateada por CI, y separar docs públicas de inventario privado de infraestructura. |

---

## 4. Mejoras (qué y cómo, sin código)

### 4.1 Motor

- **Reglamentos versionados e inmutables por combate** (física, daño, cadencia, munición,
  puntuación, respawn, objetivos, catálogo permitido) para reproducir temporadas antiguas tras
  actualizar el motor.
- **Registro de modos por metadatos** (id+versión, mapas compatibles, equipos mín/máx,
  respawn, objetivos, desempate, stats propias) en vez de un `switch` rígido.
- **Determinismo cross-entorno**: comparar hashes entre versiones de Node, hosts y nº de
  núcleos, y tras serializar/restaurar snapshot; cuantizar lo que decide colisiones/puntuación.
- **Flujo de eventos canónico** del que deriven replay, visor, stats y streaming, para que
  nadie interprete la batalla de forma distinta.
- **Regla de oro escrita en `modes.ts`:** toda entidad con estado que introduzca un modo nuevo
  **debe entrar en el hash y en el snapshot**, o no existe a efectos de auditoría (el fallo es
  silencioso — dos batallas con el payload en sitios distintos hashearían igual).

### 4.2 Visor y gráficos

- **Dirección artística única** (estética táctica/industrial, paleta S9, tipografía) coherente
  entre web, visor y emisión. 2D cenital de calidad, sin necesidad de 3D.
- **Sprites modulares derivados del loadout** (chasis, torreta, arma, blindaje, emblema,
  nombre corto) con `setTint` por equipo desde el ruleset, no colores hardcodeados. Un
  espectador debe distinguir de un vistazo un explorador de un artillero.
- **Daño visible progresivo** (impactos, blindaje roto, humo, módulos destruidos) que **coincida
  exactamente con el estado público** del motor.
- **Efectos de combate** decorativos y reproducibles desde eventos (fogonazo, trazadoras,
  estelas, explosiones, decals persistentes en `RenderTexture`).
- **HUD completo**: marcador, reloj/fase, objetivo actual, panel de bots con vida/módulos,
  kill feed, **minimapa** (segunda cámara con `ignore()`), estado de banderas/zonas.
- **Objetivos CTF/zonas dibujados** (los datos ya llegan al overlay y se ignoran).
- **Director de cámara** para `/broadcast` que puntúe la acción (proximidad, disparos, vida
  baja, captura inminente, último superviviente) con transiciones suaves y tiempo mínimo por plano.
- **Reproductor de replay** con línea temporal con marcas de eventos, salto al siguiente evento,
  cámara libre, avance tick a tick, y export de clip corto.
- **Accesibilidad visual**: no depender solo de rojo/azul (patrones, formas, emblemas), modo
  daltónico, contraste alto, `prefers-reduced-motion`, escalado de UI.

### 4.3 Gestión y usabilidad

- **Navegación permanente** por rol: Inicio, Mis bots, Taller de loadouts, Mapas, Combates,
  Torneos, Clasificación, Repeticiones, SDK, Administración.
- **Gestión de bots** con tarjetas de estado, versión activa, último resultado, historial,
  logs, duplicar/rollback/comparar, progreso en vivo del pipeline; subir ZIP además de pegar;
  batalla privada de prueba.
- **Taller de loadout visual** (slots sobre el chasis, arrastrar y soltar, barras de coste/
  masa/energía, **selección explícita de munición** — nada de coger la primera compatible en
  silencio, que además es el origen del bug de munición), presets, deshacer/rehacer, aviso de
  cambios de catálogo que invaliden el loadout.
- **Centro de torneos**: asistente de configuración, cuadro visual, batallas en curso, cola,
  reintentos, pausa/reanudación, intervención administrativa **auditada** con impacto en Elo.
- **Administración** con búsqueda de usuario y selector de roles (no UUID + cadena separada por
  comas), confirmación para privilegios altos, imposibilidad de quitar al último admin, motivo
  obligatorio; hallazgos de seguridad con filtros, severidad, estado y enlace al artefacto.
- **Tratamiento de errores** que distinga red/permisos/validación/servicio caído/timeout/
  conflicto; **nunca** una lista vacía cuando la carga falló; estado de carga, reintento e id
  de correlación.
- **Observabilidad**: paneles de batallas activas, duración de tick, retraso del motor, bots
  desconectados, timeouts, CPU/RAM por bot, tamaño de cola, fallos de replay, espectadores,
  latencia WS, almacenamiento, duración de builds, backups y última restauración validada.

---

## 5. Sistema de combate: modos actuales y propuestos

### 5.1 Modos que existen hoy (exactamente 4)

Declarados en `packages/game-rules/index.ts` y registrados en `modes.ts`, con 5 rulesets
(`dm_practice`, `tdm_mvp`, `ctf_mvp`, `zc_mvp`, `skirmish_low`):

| Modo | Puntuación | Estado real |
|---|---|---|
| `deathmatch` | 1 por baja | Funciona; **no valida** que cada vehículo sea su equipo (ERR-ENG-07) |
| `team_deathmatch` | 1 por baja, fuego amigo puntúa al rival | Correcto |
| `capture_the_flag` | 1 por captura, FSM de bandera | Correcto; un estado de la FSM es inalcanzable (cosmético) |
| `zone_control` | continua por tick controlado | **No jugable** tal cual (ERR-ENG-03) |

La arquitectura de modos es **genuinamente conectable** (`GameMode` con
`tick`/`objectives`/`winner`/`onKill`/`spawnFor`; un solo punto de registro). Añadir un modo =
una clase + una entrada + un ruleset. Eso es barato de verdad.

### 5.2 Modos nuevos, por coste de implementación

**Sin tocar el motor (solo `modes.ts` + `game-rules`):**

- **King of the Hill** — es `zone_control` con una zona y puntuación solo por presencia. Es
  literalmente ERR-ENG-03 arreglado: reparar el modo existente **es** el modo nuevo.
- **Last Man Standing / Eliminación por rondas** — `BaseMode.winner` ya declara ganador al
  último equipo vivo sin respawn; falta solo el ruleset que lo nombre, y para rondas un nivel
  "match" por encima de `Battle` con semillas derivadas (para lo que ya existe `rng.fork()`,
  hoy sin usar). **Debería ser el primer modo nuevo:** máximo valor competitivo, mínimo cambio.
- **Domination** — varias zonas permanentes; ritmo de puntuación por nº de zonas controladas.
  Reutiliza zone_control corregido.
- **Juggernaut / VIP** — un vehículo marcado, el resto puntúa matándolo. `carryingFlag` es el
  precedente exacto de un campo por vehículo; `onKill` ya da víctima y atacante.
- **Sigilo / emboscada** — viable **hoy** publicando los dos JSON de catálogo que faltan
  (`sensor.acoustic`, `sensor.proximity`, ya implementados en el motor), tras arreglar
  ERR-ENG-01 (sin el cual el acústico devuelve vacío).

**Requieren extender el motor (con su coste concreto):**

- **Battle Royale con zona que se cierra** — el daño de zona existe pero lee zonas
  **estáticas**; hace falta exponer zonas mutables en `ModeContext`, y entonces la geometría de
  la zona **pasa a ser estado de simulación y debe entrar en el hash**.
- **Escolta / Payload** — el motor no tiene entidades dinámicas que no sean vehículos; hace
  falta un cuerpo neutral con su entrada en hash y snapshot, rutas/checkpoints y overtime.
- **Extracción de recursos / Horda (PvE)** — objetos recogibles, capacidad de carga, puntos de
  extracción; PvE además exige IA neutral y generador de oleadas.

**Orden recomendado:** (1) Eliminación por rondas, (2) King of the Hill, (3) Domination,
(4) Juggernaut, (5) Battle Royale, (6) Payload, (7) Extracción/PvE. Los cuatro primeros son
baratos; a partir de Battle Royale se toca el hash y sube el coste y el riesgo de auditoría.

---

## 6. Conclusión

El proyecto tiene una base técnica muy por encima de lo que su README sugería, y las tres
auditorías coinciden en ello. La síntesis operativa es:

1. **El desarrollo del dosier está hecho** (E1–E12 en capa verificable). Lo que falta es
   **corregir errores concretos, integrar, verificar con Docker y desplegar**.
2. Hay **dos errores críticos funcionales** que hacen que el producto no funcione de verdad
   aunque los tests pasen: la **munición** (los bots no disparan) y el **sensor acústico
   muerto**; y **tres críticos de seguridad** que impiden abrir la plataforma a terceros: el
   **secreto JWT**, el **sandbox que no se ejecuta** y el **`docker.sock`**.
3. El **patrón transversal** que une casi todo lo grave: *el proyecto documenta con honestidad
   excepcional lo que está pendiente de entorno, pero el código lo trata como aprobado* — el
   pipeline devuelve `passed`, la CI dice `OK`, el estado es `validated`. La corrección
   estructural es que **toda ruta no verificable falle cerrado y se reporte como omitida, nunca
   como superada**.
4. El **siguiente hito no es añadir funciones**, sino demostrar **una cadena completa operativa**
   (crear bot → loadout → subir → sandbox valida → publicar → torneo → combate → directo →
   replay → stats → clasificación → restaurar y reproducir) sobre la v2 desplegada, con la v1
   fuera del camino.

El plan de ejecución — tareas por equipo, priorizadas, con pruebas, con lo dependiente de
despliegue al final y la retirada de v1 — está en la
**[Ronda 2 del dosier](Dosier_tareas_S9_AI_Arena.md#15-ronda-2--remediación-integración-evolución-y-retirada-de-v1)**.
