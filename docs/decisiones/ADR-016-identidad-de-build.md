# ADR-016 · Identidad de build: procedencia de imagen observable

- **Estado**: aceptado
- **Ámbito**: todas las imágenes que construye `infrastructure/docker-compose.yml`
- **Reemplaza a**: nada. Añade una garantía que no existía.

## Contexto: tres incidentes reales

### Incidente 1 — la etiqueta mintió, y el gate lo bendijo

Una construcción se lanzó con `docker compose --project-directory <directorio de producción>`
sobre un compose cuyo `build.context: ..` se resuelve **contra ese directorio**, no contra
el árbol recién clonado. Resultado: se construyó el **árbol viejo** (`98f381ec`) y se
etiquetó con el commit **nuevo** (`4d469dc`).

Cuatro servicios "pasaron" el gate de despliegue. El gate comparaba
`imagen declarada == imagen desplegada`, que es una **tautología** cuando la etiqueta
miente: la imagen desplegada era, en efecto, la declarada; lo que no era, era el código.
Nada dentro de la imagen decía de qué árbol había salido, así que no había forma de
notarlo salvo buscando marcadores de contenido a mano, servicio por servicio.

Se puede comprobar hoy mismo en producción: las imágenes solo llevan las etiquetas que
pone Compose (`com.docker.compose.project/service/version`). Ni una sola etiqueta OCI, ni
una variable con el commit. El nombre del tag era **la única** fuente de verdad, y era la
que había fallado.

### Incidente 2 — corriendo sobre una imagen que ya no existe

Un contenedor de producción seguía ejecutándose sobre una image ID que había sido
**borrada del daemon**: `docker inspect <contenedor>` la reportaba tan tranquilo (el
contenedor vive sobre sus capas mientras no se pare), pero `docker image inspect <id>`
respondía `No such image`. El estado en marcha **no era reproducible**: un restart no lo
recuperaba y el baseline no servía para rollback. Nadie lo vio porque nada lo miraba.

### Incidente 3 — la etiqueta se movió bajo un contenedor vivo

Medido en producción (VM108, 12 contenedores): `infrastructure-postgres-1` corre una
image ID que **existe** y que `docker image inspect` resuelve, pero la referencia con la
que arrancó, `postgres:16-alpine`, resuelve **hoy** a otra imagen distinta — upstream
republicó la etiqueta, y la que corre es PostgreSQL 16.14 mientras la etiqueta ya es
16.15. El contenedor está sano; lo que no es sano es que **un `restart` cambiaría la
versión de la base de datos sin que nadie lo hubiera decidido**.

Este modo de fallo no estaba contemplado en la primera versión de este ADR, y su
detector tenía además un defecto propio: la existencia de la image ID se comprobaba con
`docker images --no-trunc -q`, un listado que **omite las imágenes sin etiqueta de nivel
superior**. La imagen de postgres se había quedado sin `RepoTags`, así que el verificador
daba a la vez un **DRIFT CRÍTICO falso** ("la imagen no existe") y **ceguera al drift
verdadero**. La existencia se comprueba con `docker image inspect <image-id>`, nunca con
un listado.

## Decisión

**El commit viaja dentro de la imagen y se expone en ejecución.**

1. **Contrato de build.** Cada Dockerfile declara `ARG BUILD_COMMIT`, `ARG BUILD_DATE` y
   `ARG SERVICE_NAME`, los promueve a `ENV` y los publica como etiquetas OCI estándar:
   `org.opencontainers.image.revision`, `.created`, `.title` y `.source`. El bloque va **al
   final** del Dockerfile: un `ARG` invalida la caché de todo lo que le sigue, y estos tres
   valores cambian en cada build.

   Quien construye los pasa: la CI con `github.sha`, un operador con `git rev-parse HEAD`.
   Si no se pasan, la imagen queda marcada `unknown` — **nunca hereda un commit por
   descuido**, que es exactamente lo que ocurrió en el incidente 1.

2. **Contrato de runtime.** Cada servicio expone `GET /version` con un cuerpo estable:

   ```json
   { "service": "replay-service", "commit": "4d469dc" }
   ```

   `builtAt` (ISO-8601) se añade si se embebió. **Nada más**: ni hostname, ni IP, ni rutas,
   ni variables de entorno, ni versiones de dependencias. Lo implementa un único módulo
   compartido, `packages/build-info/index.ts`, para que no haya dos formas del mismo JSON.

   - Servicios Express (`api`, `arena-engine`, `map-service`, `replay-service`,
     `bot-manager`): `mountVersionEndpoint(app, "<servicio>")`.
   - `streamer` (servidor `node:http`, no Express): misma función de cuerpo,
     `versionPayload(...)`.
   - `web` y `gateway` (imágenes nginx, sin proceso Node): el build genera un
     `version.json` estático y la conf lo publica en `location = /version`.
   - `tournament-worker` **no expone HTTP** (su señal de vida es un fichero); escribe el
     mismo cuerpo en `/tmp/version.json` al arrancar. El gate lo lee con `docker exec … cat`.

3. **/version NO requiere autenticación.** Razones, en orden:
   - **No hay nada que proteger.** El repositorio es público y las imágenes se publican en
     GHCR con el commit en el propio tag. El commit desplegado no es un secreto; el
     contrato prohíbe explícitamente cualquier otro campo, y hay un test que lo comprueba
     (un `/version` con `hostname` pone el verificador en rojo).
   - **Autenticarlo lo volvería inútil justo cuando hace falta.** El caso de uso es el gate
     de despliegue y el diagnóstico de un stack a medio arrancar, cuando la autenticación
     (JWT, secretos internos) puede ser precisamente lo que está mal configurado. Un
     `/version` que requiere credenciales no puede responder "quién soy" en una caída de
     credenciales.
   - **Sin exposición pública añadida.** Cada servicio sirve su `/version` en su puerto, en
     las redes internas del Compose. El gateway sirve **el suyo** solo en el `server` de
     `:80` (LAN/red interna) y **no hace `proxy_pass` de `/version` hacia los servicios
     internos**: no se añade ninguna ruta nueva al `:443` público. El gate lee desde dentro
     del stack, no desde Internet.

   Si algún día se decidiera que el commit sí es información sensible, la corrección
   correcta sería dejar de publicar tags con el sha en un registro público, no poner una
   contraseña a `/version`.

## El modelo de drift: CUATRO estados, no booleanos sueltos

Los tres incidentes son tres modos de fallo **distintos**, y mezclarlos en flags sueltos
("¿existe?", "¿coincide el tag?") es lo que produjo el defecto: que una imagen EXISTA no
dice que sea la que la etiqueta nombra hoy, y que la etiqueta nombre un commit no dice
que la imagen contenga ese commit. Se modelan como estados explícitos
(`infrastructure/scripts/lib/image-drift.mjs`):

| Estado                 | Qué significa                                                                      | Incidente |
| ---------------------- | ---------------------------------------------------------------------------------- | --------- |
| `TAG_CONTENT_MISMATCH` | la etiqueta existe pero contiene código distinto                                     | 1         |
| `IMAGE_MISSING`        | el contenedor corre una image ID ya inexistente                                       | 2         |
| `TAG_MOVED`            | la image ID que corre es válida, pero la referencia declarada resuelve hoy a otra     | 3         |
| `RUNTIME_MATCH`        | la image ID en ejecución es la esperada/pinchada                                      | —         |

Y cuatro observaciones que se comparan **por separado**, sin combinarlas a mano:

- **(a)** image ID que corre — `.Image` del contenedor;
- **(b)** referencia/etiqueta declarada — `.Config.Image`;
- **(c)** image ID a la que resuelve **hoy** (b) — `docker image inspect <ref> -f {{.Id}}`;
- **(d)** digest esperado, si el despliegue lo tiene anclado.

Orden de decisión: `IMAGE_MISSING` primero (sin (a) no hay contenido que comparar), luego
`TAG_CONTENT_MISMATCH` (el fallo de contenido pesa más que a dónde apunte la referencia),
luego `TAG_MOVED`, y `RUNTIME_MATCH` si no aplica ninguno.

**La procedencia nunca se aprueba por omisión.** Una imagen sin identidad embebida sale
`not_exercised`, no "verificada": sin el commit dentro lo único mirado sería la etiqueta,
que es exactamente lo que puede mentir. Las imágenes hoy en producción son anteriores a
este ADR, así que todas salen `not_exercised` en procedencia — y eso es la respuesta
correcta, no un aprobado.

Salida del clasificador sobre el caso real, tal cual:

```
container                 = <servicio de base de datos>
runtime image exists      = YES
tag still points to runtime image = NO
drift = TAG_MOVED
```

## El gate futuro de despliegue

Un despliegue solo es válido si, **para cada servicio**, se cumple todo esto:

| # | Comprobación                                                          | Cómo                                                        |
| - | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1 | `tag` de la imagen = commit desplegado                                | nombre de la referencia                                     |
| 2 | `org.opencontainers.image.revision` de la imagen = commit desplegado   | `docker image inspect` (sin arrancar nada)                  |
| 3 | `/version` del contenedor **en marcha** = commit desplegado            | `docker exec … wget -qO- 127.0.0.1:<puerto>/version`        |
| 4 | la **image ID en ejecución EXISTE** en el daemon                       | `docker image inspect <image-id>` (NUNCA `docker images -q`) |
| 5 | la **referencia declarada sigue resolviendo** a la image ID que corre  | `docker image inspect <ref> -f {{.Id}}`                      |

- (1) sola es la tautología que falló. (2) la rompe sin coste. (3) prueba que lo que corre
  es esa imagen y no otra cosa que se le parece.
- (5) es el incidente 3: la etiqueta se movió y un restart traería otra versión.
- (4) es el incidente 2: si la image ID en ejecución **no existe**, es **DRIFT CRÍTICO**.
  El estado no es reproducible, un restart no lo recupera y **el baseline no es reutilizable
  para rollback**. Hay que reconstruir o volver a bajar la imagen del registro **antes** de
  tocar nada.

Herramientas, ya en el repo:

```bash
# (1)(2)(3) sobre una imagen concreta
node infrastructure/scripts/verify-image-provenance.mjs \
  --image ghcr.io/pjclavero/s9-ai-arena/replay-service:sha-<sha> \
  --commit <sha> --service replay-service --port 8083 \
  --env SERVICE_ENTRY=apps/replay-service/src/main.ts

# (4)(5) sobre un daemon entero: clasifica cada contenedor en uno de los cuatro estados
node infrastructure/scripts/check-running-image-id.mjs [--json]

# calibración por mutación del clasificador (cada garantía se ve ROJA)
node infrastructure/scripts/mutate-image-drift.mjs
```

Ambos salen con `rc != 0` ante el defecto, con el motivo en una línea. No hay "amarillo":
o la imagen es la que dice ser, o no lo es.

## Verificación en CI

El job `image-provenance` de `ci.yml` (obligatorio en el semáforo; un `skipped` **no** es un
check aprobado) construye imágenes de verdad y comprueba, en el mismo run:

- **control positivo** — `gateway` (camino nginx) y `replay-service` (camino Node) con el
  commit del run: tag = LABEL = `/version`;
- **control negativo (la mutación)** — la MISMA imagen reconstruida con otro
  `BUILD_COMMIT` y etiquetada con el commit del run. El verificador **tiene que fallar**;
  si saliera 0, el paso falla y con él la CI. Sin ese negativo, un verificador que
  devolviera 0 siempre pasaría por bueno;
- **calibración de (4)(5)** — `check-running-image-id.mjs --self-test`, que fabrica los
  cuatro estados y exige que cada uno se clasifique como el suyo, incluido el caso de una
  imagen sin `RepoTags` (la que `docker images -q` omite), que debe salir con la imagen
  **existente**;
- **calibración por mutación** — `mutate-image-drift.mjs` aplica siete mutaciones al
  código de producción y exige que cada una deje roja la suite. La primera reintroduce
  `docker images -q` como prueba de existencia: si sobreviviera, el arreglo no estaría
  probado.

## Consecuencias

- Un build del árbol equivocado etiquetado con el commit correcto ya no puede pasar
  inadvertido: su `LABEL` y su `/version` dicen el commit viejo.
- Cambiar de commit ya no invalida la caché de `npm ci` ni de los `COPY` (el bloque va al
  final): el coste en tiempo de build es despreciable.
- Una imagen construida sin los build-args no miente: dice `unknown`, y el gate la rechaza.
- El drift de la etiqueta de la base de datos en VM108 queda **detectado y nombrado**, no
  corregido: anclar un digest es una decisión del operador con su propia ventana de base
  de datos. Este ADR sólo garantiza que el sistema **sabe decir** que ese drift existe.
- **Este ADR no cambia el rollout en curso**, que se verifica con marcadores de contenido y
  sus controles positivo y negativo. Sirve para que el **siguiente** release no necesite esa
  artesanía.
