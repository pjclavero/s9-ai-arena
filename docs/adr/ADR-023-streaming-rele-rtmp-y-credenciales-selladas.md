# ADR-023 · Streaming: relé RTMP en el propio streamer y credenciales de emisión selladas

**Estado:** propuesto (2026-11-02, EQ5b · PR #227) · **Ámbito:** `apps/streamer` (`rtmp/*`, `ffmpeg.ts`, `supervisor.ts`, `control.ts`, `session.ts`, `recordings.ts`), `packages/stream-secrets`, `apps/api` (`routes/streaming.ts`, `services/streaming.ts`, `services/streamer-client.ts`, migración 017), `infrastructure` (`docker-compose.yml`, `scripts/init-secrets.sh`, alertas)

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
  proceso, no va al entorno. El logger la redacta (y su forma escapada en JSON) en todo lo
  que escribe, y el relé la redacta en cualquier mensaje del servidor (que puede repetir
  el nombre del stream).
- **Mejora de seguridad colateral:** el relé **verifica el certificado** de la ingesta
  (CA del sistema; `NODE_EXTRA_CA_CERTS` para una CA propia). FFmpeg usaba
  `tls_verify=0`: la clave se habría entregado a cualquiera que interceptara la conexión.
- Sólo `rtmps://`. `rtmp://` en claro sólo con `STREAMER_ALLOW_PLAIN_RTMP=1` (pruebas
  locales): en claro, la clave viajaría legible por la red.
- Reintentos: un corte del relé cuenta como corte de RTMPS (mismo supervisor). El contador
  sólo se salda con progreso **publicado** (antes bastaba con que ffmpeg progresara contra
  la tubería, lo que habría ocultado un rechazo continuo de la ingesta).

### 2. Credenciales SELLADAS (cifrado asimétrico en reposo)

- `init-secrets.sh` genera un par **RSA-3072** (`stream_secrets_private.pem` y su pública).
- La **API sólo tiene la pública**: cifra con RSA-OAEP-SHA256 la clave que llega del
  navegador y guarda el **sobre** en `streaming_credentials.sealed` (migración 017). No
  puede descifrarlo: ni ella, ni un volcado de la BD, ni un backup de la BD.
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

Por qué no cifrado simétrico con la clave en un secreto montado: la API tendría que poder
descifrar, así que comprometer la API (o leer su secreto y la BD) bastaría para obtener la
clave. Con el sellado, quien compromete la API puede **sustituir** la clave, no leerla.

### 3. Administración y operación

- Una sola emisión a la vez: índice único parcial `streaming_sessions_one_active` en BD,
  más el 409 `already_active` del streamer.
- Guardar con una emisión activa **nunca reinicia en silencio** (`pendingRestart`); el
  operador pulsa «Reiniciar emisión». Desactivar con emisión activa exige `confirmStop`.
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

## Verificación

- `apps/streamer/tests/secret-surfaces.test.ts` (regresión calibrada: ROJA con el diseño
  anterior, VERDE con el relé), `apps/streamer/src/rtmp/publisher.test.ts`,
  `apps/api/src/eq5b-streaming-admin.test.ts`, `apps/api/src/db/migration-017.test.ts`.
- `tests/streaming-e2e/secret-audit.sh` y `tests/streaming-e2e/e2e.sh` (imagen real,
  ingesta RTMPS local). Ver [docs/operations/streaming.md](../operations/streaming.md).
