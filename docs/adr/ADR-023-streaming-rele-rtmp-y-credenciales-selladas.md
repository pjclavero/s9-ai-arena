# ADR-023 · Streaming: relé RTMP en el propio streamer y credenciales de emisión selladas

**Estado:** propuesto (2026-11-02, EQ5b · PR #227; corregido por EQ5c tras la revisión EQ6b, ronda 1) · **Ámbito:** `apps/streamer` (`rtmp/*`, `ffmpeg.ts`, `supervisor.ts`, `control.ts`, `session.ts`, `recordings.ts`), `packages/stream-secrets`, `apps/api` (`routes/streaming.ts`, `services/streaming.ts`, `services/streamer-client.ts`, migración 017), `infrastructure` (`docker-compose.yml`, `scripts/init-secrets.sh`, alertas)

## Contexto

El encargo «Administración de Streaming desde la web» pone una condición **bloqueante**
(`STREAM_KEY_ARGV_VISIBLE=NO`): la clave de emisión no puede aparecer en el argv de
ffmpeg, ni en `ps`, `/proc/*/cmdline`, `/proc/*/environ`, logs, métricas, `/status`,
`docker inspect`, el frontend, la API o la BD en claro. Además la clave se configura
**desde la web** (sin SSH, `.env` ni Compose), sin Vault ni KMS.

Estado previo (auditoría EQ5 del 2026-11-02, medido con la imagen real): ffmpeg
recibía `rtmps://…/live2/<clave>` como último argumento. `docker top` y el `ps` de
**cualquier usuario del host** la mostraban.

## Opciones evaluadas para §3

| Opción | Resultado |
|---|---|
| ffmpeg lee la URL por un canal que no sea argv | **No existe** en FFmpeg 6.1.1 (Alpine 3.20, la de la imagen). `-/opt fichero` es de FFmpeg 7.0 y se aplica a opciones de filtros/streams: probado, `-/rtmp_playpath` da «Unrecognized option» incluso en 7.1. Las opciones `rtmp_*` sólo van por argv o en la URL. |
| Relé externo local (nginx-rtmp, MediaMTX) que lea la clave de su config | Funciona, pero añade un binario y un proceso a la imagen, la clave en **otro** fichero de configuración, otra superficie (su propio puerto, logs y API) y otro ciclo de vida que supervisar. MediaMTX, además, publica hacia fuera lanzando… ffmpeg con la clave en argv. |
| **El propio streamer hace de relé** | **Elegida.** |

## Decisión

### 1. Relé RTMP(S) en el proceso Node del streamer

- ffmpeg codifica igual que antes (x11grab → x264/NVENC + AAC), pero escribe **FLV por un
  descriptor heredado** (`-f flv pipe:3`). En su argv no hay destino de red ni clave.
- `apps/streamer/src/rtmp/publisher.ts` abre TLS con la ingesta, hace el handshake RTMP
  (C1 con digest HMAC, como FFmpeg/FMLE; C2 = eco de S1), `connect`, `releaseStream`,
  `FCPublish`, `createStream` y `publish(<clave>)`, y convierte cada etiqueta FLV en un
  mensaje RTMP (metadatos con `@setDataFrame`). Es lo mismo que hace el protocolo `rtmp`
  de FFmpeg con la salida de su muxer FLV.
- La clave existe sólo en la memoria de ese proceso: no se escribe, no se pasa a otro
  proceso, no va al entorno. El logger la redacta en todo lo que escribe y el relé en
  cualquier mensaje del servidor (que puede repetir el nombre del stream), en todas sus
  formas: tal cual, escapada en JSON y URL-codificada, **sin distinguir mayúsculas**
  (EQ5c: una ingesta hostil la devolvía en mayúsculas en el rechazo; lo detectó
  `tests/eq6b/key-surfaces.ts` con procesos reales). Desde EQ5d (P3 de EQ6c) se redacta
  además **cualquier fragmento de 8 o más caracteres** de la clave, de su **base64**
  (estándar y URL-safe, en las tres alineaciones de byte, para un trozo de la clave
  codificado dentro de un texto más largo) y de su **hex**: una ingesta que repetía la
  clave codificada en su rechazo la hacía llegar a `/status` y a los logs. Desde EQ5e
  (R3-A de la ronda 3) la comparación sin distinguir mayúsculas **conserva la longitud**
  (`foldSameLength`): con `toLowerCase`, 'İ' (U+0130) pasa a dos unidades, los índices
  de la marca se desplazaban y la clave salía entera. Ver los límites de la redacción en
  «Límites conocidos».
- **Mejora de seguridad colateral:** el relé **verifica el certificado** de la ingesta
  (CA del sistema; `NODE_EXTRA_CA_CERTS` para una CA propia). FFmpeg usaba
  `tls_verify=0`: la clave se habría entregado a cualquiera que interceptara la conexión.
- Sólo `rtmps://`. `rtmp://` en claro sólo con `STREAMER_ALLOW_PLAIN_RTMP=1` (pruebas
  locales): en claro, la clave viajaría legible por la red.
- Reintentos: un corte del relé cuenta como corte de RTMPS (mismo supervisor). El contador
  sólo se salda con progreso **publicado** (antes bastaba con que ffmpeg progresara contra
  la tubería, lo que habría ocultado un rechazo continuo de la ingesta).
- **Todo fallo del arranque llega al supervisor** (EQ5c, hallazgo P1 de EQ6b): el rechazo
  explícito de la ingesta (`_error` a `connect`, `onStatus NetStream.Publish.BadName` a
  `publish`), un plazo vencido o un error de protocolo pasan por el mismo `fail()` que un
  corte: se cierra el socket, `lastError` recoge el motivo **redactado** (también el
  `code` que manda el servidor) y se reintenta hasta `maxRetries` (después, `failed`).
  Antes sólo se rechazaba la promesa y la emisión se quedaba «en directo» sin emitir.
- **Plazos tras el handshake** (EQ5c, P2-1): cada orden RTMP (`connect`, `createStream`,
  la confirmación de `publish`) tiene plazo (`commandTimeoutMs`, por defecto el de
  conexión); `/control/test` tiene además un plazo total de 15 s. Vencido, el relé falla
  y cierra el socket: una ingesta que completa el handshake y calla ya no deja nada colgado.
- **Plazo de escritura ya publicando** (EQ5d, P3 de EQ6c): si tras
  `NetStream.Publish.Start` la ingesta deja de leer y el socket sigue por encima de la
  marca de agua (4 MiB) sin `drain` más de `writeTimeoutMs` (por defecto, el plazo de
  orden: 10 s), el relé falla con `write_timeout` y el supervisor reintenta. Antes el relé
  se quedaba «publicando» para siempre con el productor parado. Desde EQ5e (R3-C) el plazo
  se **rearma** mientras siga habiendo datos pendientes sin `drain`: por debajo de la marca
  de agua sólo sigue esperando si hubo avance desde el vencimiento anterior; sin avance,
  falla igual (una ingesta que lee un poco y se cuelga ya no lo deja «publicando»).
- Lectura acotada: además del tope por mensaje (1 MiB), un tope **agregado** de 2 MiB de
  mensajes entrantes a medias en todos los csid.

### 2. Credenciales SELLADAS (cifrado asimétrico en reposo)

- `init-secrets.sh` genera un par **RSA-3072** (`stream_secrets_private.pem` y su pública).
- La **API sólo tiene la pública**: sella la clave que llega del navegador y guarda el
  **sobre** en `streaming_credentials.sealed` (migración 017). No puede abrirlo: ni ella,
  ni un volcado de la BD, ni un backup **de la BD sola** (ver «Límites» sobre el backup).
- **El sobre está atado a su destino** (EQ5c, hallazgo P2-2 de EQ6b). Formato v2: se sella
  `{platform, ingest, key}`. La clave va cifrada con AES-256-GCM bajo una clave de
  contenido aleatoria envuelta con RSA-OAEP-SHA256, y `{kid, platform, ingest canónica}`
  es el **AAD** de GCM. La ingesta canónica es `proto://host:puerto/app` (host en
  minúsculas, puerto explícito; `canonicalIngestUrl`).
  - La API sella con la ingesta de la plataforma (YouTube: la fija; RTMPS personalizado:
    la guardada en la configuración, que tiene que existir antes: si no, 409
    `ingest_missing`).
  - La orden de arranque lleva `platform` e `ingestUrl`; el streamer sólo abre el sobre si
    **ambas casan** con las selladas (`binding_mismatch` ⇒ 409). Cambiar `bind` en el
    sobre para re-apuntarlo rompe la etiqueta de GCM (`undecryptable`).
  - **Etiqueta de GCM completa** (EQ5d, P3 de EQ6c): `authTagLength: 16` al cifrar y al
    descifrar, e `isSealedSecret` exige base64 canónico de **12 bytes de IV y 16 de
    etiqueta**. Sin eso, GCM aceptaba etiquetas truncadas (4/8/12 bytes): con 4 bytes,
    re-apuntar un sobre costaba ~2^32 intentos en vez de 2^128.
  - El streamer **registra** cada sobre rechazado con su código (`binding_mismatch`,
    `undecryptable`, `key_mismatch`, `invalid`), sin material secreto: un goteo de
    `undecryptable` es la huella de alguien probando sobres.
  - Si el operador cambia la ingesta personalizada, la clave guardada deja de valer: la
    pantalla dice «guardada para otra URL de ingesta: vuelve a introducirla» y start/test
    responden 409 `credential_unbound` sin mandar nada al streamer.
  - La clave **heredada** de despliegue (`STREAM_KEY_FILE`) queda atada igual: sólo se usa
    si la ingesta de la orden es la del despliegue (`STREAM_RTMPS_URL`).
  - Los sobres v1 (sólo la clave) se rechazan; no hubo v1 en producción (el PR no está
    desplegado).
- El **streamer tiene la privada** (secreto montado 0400). La orden de arranque de la API
  lleva el sobre; el streamer lo abre en memoria y se lo da al relé.
- `kid` (huella de la pública) en el sobre: si se rota el par, la pantalla dice «guardada
  con otra clave de cifrado: vuelve a introducirla» en lugar de un error criptográfico.
- Lo único legible en la BD son los 4 últimos caracteres (`****ABCD`), que es lo máximo que
  el encargo permite mostrar.
- Sin clave pública configurada, `PUT /admin/streaming/credentials/*` responde **503 y no
  guarda nada** (nunca en claro).
- La API interna de control del streamer exige el secreto compartido `x-streamer-auth`
  (`streamer_control_secret`): otro contenedor de la red `platform` no puede arrancar una
  emisión ni leer su estado saltándose el RBAC de la API.
- **El control falla en cerrado** (EQ5c, P2-3): con `STREAMER_CONTROL_SECRET_FILE`
  definido el secreto es obligatorio; si no se puede leer o está vacío, todo lo
  autenticado responde 401 y `/healthz` 503 (contenedor `unhealthy`, visible). Se relee
  en cada petición. Sólo sin la variable (uso heredado) queda abierto, con aviso.
  `init-secrets.sh` avisa si no puede dar un secreto al uid del runtime (antes, `chown
  … || true` en silencio).

**Propiedad que se afirma** (y que prueban `apps/streamer/src/eq6b-relay-break.test.ts` y
`apps/streamer/src/eq5c-correcciones.test.ts`): con la BD y el secreto `x-streamer-auth`
—todo lo que tiene la API— **no se puede leer la clave ni hacer que salga hacia una
ingesta distinta de aquella para la que se guardó**. Quien compromete la API puede
sustituir o borrar la clave, o dejarla inutilizable cambiando la ingesta, pero no
obtenerla ni redirigirla.

Por qué no cifrado simétrico con la clave en un secreto montado: la API tendría que poder
descifrar, así que comprometer la API (o leer su secreto y la BD) bastaría para obtener la
clave.

### 3. Administración y operación

- Una sola emisión a la vez: índice único parcial `streaming_sessions_one_active` en BD,
  más el 409 `already_active` del streamer.
- **Sin emisiones zombi** (EQ5c, P2-4; EQ5d, P2 y P3 de EQ6c). Invariante: *el streamer
  sólo emite si hay una sesión activa en BD y el streaming está activado*.
  - Dentro de un proceso de la API, start, restart y stop se ejecutan **en serie** (un
    cerrojo por proceso). Las comprobaciones previas del start que no cambian nada
    (activado, destino, disco) van **fuera** del cerrojo; dentro se **vuelve a leer** la
    configuración antes de insertar la sesión.
  - Entre instancias (sin cerrojo compartido) lo sostienen **dos órdenes**: (1) el stop
    **marca la sesión parada en BD ANTES** de llamar a `/control/stop`; (2) start y
    restart, **después** de la respuesta del streamer, recomprueban que su sesión siga
    activa **y** que el streaming siga activado. Si no, marcan (si hace falta), mandan
    `/control/stop`, auditan `streaming.session.start_cancelled` / `restart_cancelled`
    (`reason`: `stopped_during_operation` o `disabled_during_operation`) y responden 409
    (`start_cancelled`, `not_active` o `streaming_disabled`). Por qué basta: si la
    recomprobación de A es anterior al marcado de B, el efecto del start de A es anterior
    al stop de B (que llega al streamer después de marcar); si es posterior, A ve la
    sesión parada y para él mismo. En ningún orden el último efecto es un start sin sesión.
  - **Desactivar** guarda `enabled=false` y, después y **dentro del cerrojo**, lee la
    sesión activa y la para. Un start en vuelo de otra instancia o lo ve esa lectura (si
    insertó antes) o ve él `enabled=false` al recomprobar (si recomprueba después).
  - Probado con dos instancias de la API sobre la misma BD real
    (`apps/api/src/eq6c-streaming-break.test.ts`, `eq5d-streaming-correcciones.test.ts`,
    este último con un bloqueo de fila real para forzar el entrelazado del PUT).
  - **Start sin respuesta** (EQ5e, R3-E): si el start vence el plazo del cliente, falla
    la red o el streamer responde 5xx, la orden pudo aplicarse igualmente. La sesión se
    marca `failed` y se manda un `/control/stop` **compensatorio** (a ciegas si no hay otra
    sesión activa; si la hay, sólo se para lo huérfano), auditado como
    `streaming.session.start_compensated` (`cause`, `outcome`).
  - **Reconciliación de huérfanas** (EQ5e, R3-B): `reconcileOrphanEmission` para el
    streamer si emite (o reintenta) y la BD no tiene una sesión activa, o la tiene pero el
    streamer declara otra (`session.sessionId`). Lee primero el streamer y después la BD:
    un start legítimo inserta su sesión antes de llamar al streamer, y mientras el streamer
    emite algo huérfano ningún start sin `replace` puede prosperar (409), así que no corta
    una emisión legítima. Se ejecuta tras un 409 del streamer a un start, en la
    recomprobación cuando hay otra sesión activa y **cada 30 s** desde `server.ts`
    (`startOrphanReconciler`). Cada parada se audita como `streaming.session.orphan_stopped`.
    Cubre start(A) ‖ stop(B) ‖ start(C en B) y la respuesta de un start que llega tarde.
- Grabación: no se empieza con menos de 2 GiB libres (`disk_low`) **ni si el streamer no
  puede medir el disco** (`disk_unknown`, fail-closed).
- Ingesta personalizada sin hosts internos (SSRF): se rechazan nombres de una etiqueta
  (servicios de Docker), `localhost` y sufijos `.local/.internal/.lan/.home.arpa`, IPv4 de
  loopback, privadas, CGNAT, link-local (metadatos) y no canónicas (`0x7f.1`, `127.1`), e
  IPv6 loopback/ULA/link-local/site-local (`fec0::/10`)/multicast. Las IPv6 se
  **normalizan** a sus 8 grupos (EQ5d, P3 de EQ6c): las formas que incrustan una IPv4
  obsoletas o de transición local —compatible `::a.b.c.d`, mapeada `::ffff:0:0/96`,
  traducida `::ffff:0:0:0/96`, NAT64 local `64:ff9b:1::/48`, Teredo— se rechazan siempre;
  de NAT64 `64:ff9b::/96` y 6to4 `2002::/16` se **extrae** la IPv4 y se le aplica la misma
  lista. Sólo el E2E local admite hosts internos (`STREAMING_ALLOW_INTERNAL_INGEST=1`,
  nunca en el Compose).
- Guardar con una emisión activa **nunca reinicia en silencio** (`pendingRestart`); el
  operador pulsa «Reiniciar emisión». Desactivar con emisión activa exige `confirmStop`.
- **«En directo» sólo es verdad** (EQ5d, P3 de EQ6c): en RTMPS el estado de la pantalla
  es `live` sólo con el relé **publicando**; mientras conecta (o con el relé cerrado) es
  `starting`, «Iniciando», con «Detener» disponible.
- El retardo anti-coaching sigue saliendo **sólo** de la copia de reglas
  (`spectator.delaySeconds`, que aplica el gateway): la pantalla lo lee, no lo guarda.
- Retención de MP4: la decide el streamer sobre su directorio (sólo ficheros regulares con
  el nombre exacto de ffmpeg.ts, nunca la grabación en curso, nunca fuera de
  `video/`); la API audita **cada** borrado en `audit_log`.

## Consecuencias

- **Código propio de protocolo** (≈ 500 líneas): riesgo de interoperabilidad. Mitigación:
  probado contra dos servidores de terceros (servidor RTMP de FFmpeg 7.1 y MediaMTX 1.9.3
  RTMPS) con el FFmpeg 6.1.1 de la imagen. **No probado contra YouTube** (no hay clave de
  prueba: `YOUTUBE_PRIVATE_STREAM=BLOCKED`).
- El sobre se envía a la API interna del streamer por la red `platform` (HTTP sin TLS):
  sin la privada no sirve de nada.
- Rotar el par RSA invalida las credenciales guardadas (hay que volver a introducirlas).
- La privada del streamer y la pública de la API son ficheros de `infrastructure/secrets/`:
  entran en el mismo procedimiento de backup y custodia que el resto de secretos.

## Límites conocidos (declarados)

- **Backup (P3 de EQ6b):** el repositorio restic guarda `infrastructure/secrets/` (con
  `stream_secrets_private.pem`) en su snapshot `s9-arena-secrets` y el volcado de la BD
  (con los sobres) en `s9-arena-data`, **en el mismo repositorio y con la misma
  contraseña**. Quien tenga el repositorio y `restic_password` puede abrir las claves de
  emisión. «Ni un backup puede descifrarlo» sólo vale para un backup de la BD sola.
  Mitigación pendiente (fuera de este PR): sacar la privada del backup general (custodia
  aparte) o no respaldarla y re-introducir las claves tras una restauración.
- **SSRF:** la comprobación es del nombre escrito; un nombre público que resuelva a una IP
  interna (DNS rebinding) no se detecta. Y quien tenga `x-streamer-auth` puede pedir al
  streamer un `/control/test` (handshake, sin clave) hacia cualquier host: el streamer no
  aplica la lista de hosts internos.
- **Entre instancias** (el cerrojo es por proceso; ver § 3). Corrige la afirmación de
  EQ5c, que era falsa: la recomprobación sola NO bastaba (con el stop marcando la BD
  después, start‖stop y restart‖stop dejaban el streamer emitiendo sin sesión; lo
  demostró EQ6c). Con el marcado previo, lo que puede quedar es el error **contrario y
  visible**: si otra instancia arranca una sesión nueva entre el marcado de un stop y la
  llegada de ese stop al streamer, el stop corta la emisión nueva y la pantalla muestra
  «Emisión interrumpida» (sesión activa, streamer parado) hasta que el operador la
  reinicie o la detenga; nunca una emisión sin sesión. Y un restart cancelado cuya sesión
  ya sustituyó otra no para el streamer (para no cortar la otra): la emisión puede seguir
  con la configuración del restart bajo la sesión nueva, lo que «pendiente de reinicio»
  hace visible. Además se emite a veces un `/control/stop` sobrante (inofensivo).
  Con tres o más operaciones entre instancias (R3-B) puede quedar, durante como mucho un
  ciclo de reconciliación (30 s) o hasta el siguiente start, una emisión sin sesión; la
  reconciliación la para y la audita. El Compose despliega **una** réplica de la API: el
  caso multi-réplica es un límite declarado, no la configuración de referencia.
- **Start cuya respuesta se pierde** (R3-E): el stop compensatorio sale cuando vence el
  plazo; si la orden de start llega al streamer DESPUÉS del stop (red muy lenta), la
  emisión huérfana dura hasta la siguiente reconciliación (≤ 30 s).
- **Stop con el streamer caído:** la sesión queda parada en BD (la intención del operador
  manda) y, sin `force`, la API responde 503. Si el streamer seguía emitiendo, al volver
  la pantalla lo muestra (estado del streamer sin sesión) y un nuevo «Detener» lo para:
  `stop` siempre llama a `/control/stop`.
- **Redacción:** es por coincidencia de texto. Cubre la clave, cualquier fragmento suyo
  de ≥ 8 caracteres y lo mismo de su base64 (estándar/URL-safe) y su hex, sin distinguir
  mayúsculas. **No** cubre fragmentos de < 8 caracteres, otras codificaciones (base32,
  doble codificación, compresión, cifrados triviales) ni una clave partida entre dos
  líneas de log. Puede sobre-redactar texto inocente que coincida con 8 caracteres de
  esas formas (inofensivo): si la clave contiene una palabra de 8 o más letras que aparece
  en el log (p. ej. `streamer`), `"service":"streamer"` sale como `"service":"***"`. Se
  acepta (sobre-redacción, nunca fuga): distinguir «palabra común» de «trozo de la clave»
  obligaría a dejar pasar trozos de la clave. Desde EQ5e el plegado de mayúsculas es
  **completo y de longitud constante**: cada carácter se pasa a minúsculas por separado y,
  si eso cambiaría su longitud (U+0130), se toma su primera unidad (İ → i).
- **Plazo de escritura:** una congestión real de más de 10 s seguidos sin `drain` se trata
  como corte y provoca un reintento (reconexión), igual que un corte de red.
- Un stop pedido mientras un start espera al streamer tarda lo que tarde esa llamada (como
  mucho el plazo del cliente HTTP, 10 s).

## Verificación

- `apps/streamer/tests/secret-surfaces.test.ts` (regresión calibrada: ROJA con el diseño
  anterior, VERDE con el relé), `apps/streamer/src/rtmp/publisher.test.ts`,
  `apps/api/src/eq5b-streaming-admin.test.ts`, `apps/api/src/db/migration-017.test.ts`.
- Revisión EQ6b: `apps/streamer/src/eq6b-relay-break.test.ts`,
  `apps/api/src/eq6b-streaming-break.test.ts` (ROJAS sobre eb0f858, VERDES tras EQ5c) y
  `tests/eq6b/key-surfaces.ts` (procesos reales). Regresión de EQ5c, calibrada con
  mutaciones: `apps/streamer/src/eq5c-correcciones.test.ts`,
  `apps/api/src/eq5c-streaming-correcciones.test.ts`.
- Revisión EQ6c (ronda 2): `apps/streamer/src/eq6c-relay-break.test.ts`,
  `apps/api/src/eq6c-streaming-break.test.ts`, `apps/api/src/eq6c-ssrf.test.ts` y
  `tests/eq6c/argv-harness.ts` (ROJAS sobre a41a903, VERDES tras EQ5d). Regresión de EQ5d,
  calibrada con 14 mutantes (cada uno revierte una barrera y pone roja al menos una
  prueba): `apps/streamer/src/eq5d-correcciones.test.ts`,
  `apps/api/src/eq5d-streaming-correcciones.test.ts`, `apps/api/src/eq5d-ssrf.test.ts`.
- Revisión ronda 3: `apps/streamer/src/r3-relay-break.test.ts` y
  `apps/api/src/r3-streaming-break.test.ts` (7 ROJAS sobre 787db33, VERDES tras EQ5e),
  calibradas con 6 mutantes en serie (uno por hallazgo); regresión propia en
  `apps/streamer/src/eq5e-redaccion.test.ts` (U+0130, ß, ﬁ, combinantes, emojis, Kelvin,
  letras astrales) y `apps/api/src/db/migration-017.test.ts` (con una migración posterior
  simulada detrás de la 017).
- `tests/streaming-e2e/secret-audit.sh` y `tests/streaming-e2e/e2e.sh` (imagen real,
  ingesta RTMPS local). Ver [docs/operations/streaming.md](../operations/streaming.md).
