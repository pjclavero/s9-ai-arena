# Override selectivo de versión por servicio

> Estado: **mecanismo y gate en el repositorio. NADA ejecutado en producción.**
> La recreación de `tournament-worker` es una autorización aparte.

## 1. Por qué existe

`tournament-worker` corre en producción el código de `4d469dc`. Ese runtime **se
paraliza en silencio si Redis muere después de arrancar**: el waiter nunca se
rechaza, y el healthcheck sigue verde porque es un `setInterval` ajeno al bucle
de trabajo. El arreglo está en `main` (PR #142) y el runtime desplegado sigue
siendo el defectuoso.

Hacía falta adelantar **ese** servicio sin mover los otros diez, validados en
`4d469dc`. Con un único `TAG` eso no se podía expresar: la única forma de
desplegar otra versión era pasar `TAG` en la línea de comandos, y eso mueve la
referencia de todos.

## 2. El mecanismo

```yaml
image: ${IMAGE_PREFIX}/<servicio>:${<SERVICIO>_TAG:-${TAG:-latest}}
```

```
TAG=4d469dc                        # línea base general
TOURNAMENT_WORKER_TAG=82c74a8      # override explícito
```

Uniforme para los servicios de aplicación: `API_TAG`, `WEB_TAG`, `GATEWAY_TAG`,
`MAP_SERVICE_TAG`, `BOT_MANAGER_TAG`, `ARENA_ENGINE_TAG`, `REPLAY_SERVICE_TAG`,
`TOURNAMENT_WORKER_TAG` (y `STREAMER_TAG` / `BOT_RUNTIME_TAG`, de perfiles
opcionales). `postgres` y `queue` **no** tienen variable: están anclados por
digest y ofrecerles una palanca de etiqueta rompería el anclaje.

### `bot-build-worker` comparte variable con `bot-manager`

No son dos artefactos, son **dos roles del mismo artefacto**: el contrato
declara la misma referencia (`s9arena/bot-manager:<tag>`) para los dos. Una
variable por servicio haría **expresable** que la misma imagen tuviera dos
etiquetas distintas — o una no existe en el registro, o existen las dos y el
gestor y su trabajador de construcción corren código distinto sobre el mismo
contrato interno. Con una sola variable ese estado no se puede ni escribir, que
es más barato que detectarlo. Consecuencia aceptada: adelantar uno adelanta los
dos, y el gate lo cuenta como **dos** imágenes cambiadas, no como una excepción
silenciosa.

## 3. La tensión con `backup`: dos semánticas contrarias, a propósito

|                        | servicios de aplicación             | `backup`                    |
| ---------------------- | ----------------------------------- | --------------------------- |
| referencia             | `${SVC_TAG:-${TAG:-latest}}`        | `${BACKUP_TAG:-latest}`     |
| ¿sigue a `TAG` global? | **sí**, por defecto                 | **no**, nunca               |
| el override es…        | una **excepción temporal**          | el **régimen normal**       |
| quién lo verifica      | `tag-override-gate.mjs` (G1, G5)    | `backup-stack-gate.mjs` (G6) |

**No es una inconsistencia que haya que limar.** `backup` es un bloque aparte,
con ventana propia; anidarlo reintroduciría el defecto que cerró #139 (alinear
la copia movería de rebote los once servicios de aplicación). Los de aplicación
sí siguen a `TAG` porque su destino es moverse todos juntos.

Las dos direcciones se comprueban **por efecto**, con un TAG centinela, y ambas
tienen mutación que las pone rojas. Quien venga a "unificar esto" se encontrará
con un gate rojo que le dice hacia dónde no unificar.

### Punto ciego encontrado y cerrado en `backup-stack-gate.mjs`

La sonda G6 de #139 sólo probaba con `BACKUP_TAG` **puesta**. En ese caso un
`${BACKUP_TAG:-${TAG:-latest}}` anidado rinde exactamente lo mismo que el
correcto: la sonda no veía nada. El anidamiento sólo se manifiesta el día que
alguien quita esa línea del `.env` — y ese día la copia empezaría a seguir al
TAG global en silencio. Se añadió la segunda sonda (variable propia ausente +
TAG centinela) y su mutación.

## 4. Los overrides son visibles, nunca estado invisible

Requisito literal del operador: *«no volver a caer en "el .env dice X pero el
runtime es otra cosa" sin que el sistema lo declare»*. Tres sitios:

1. **El contrato** (`infrastructure/deploy-contract.json`,
   `overrides_de_version.activos`): variable, etiqueta, commit, motivo,
   procedencia del artefacto y **condición de cierre**. `activos` vacío es el
   estado sano.
2. **El verificador**:

   ```
   $ node infrastructure/scripts/tag-override-gate.mjs
   GLOBAL TAG        4d469dc
   OVERRIDES:
     tournament-worker   82c74a8
   EFFECTIVE:
     api                 4d469dc
     arena-engine        4d469dc
     bot-build-worker    4d469dc
     bot-manager         4d469dc
     gateway             4d469dc
     map-service         4d469dc
     replay-service      4d469dc
     tournament-worker   82c74a8
     web                 4d469dc
   ```

   `EFFECTIVE` lista **todos**, no sólo las excepciones: un listado de
   excepciones obliga a deducir el resto, y deducir es donde se cuela el estado
   invisible.

3. **El escáner de deriva y R17**, sin reimplementar nada:
   - `runtime-drift-scan.mjs --overrides-from-contract infrastructure/deploy-contract.json`
     añade la columna `override` a cada fila y un resumen
     `OVERRIDES DE VERSIÓN ACTIVOS (n): …`. Distingue tres estados y no dos:
     hay override · no hay · **no se ha mirado** (sin la bandera). No haber
     mirado no es «no hay».
   - `packages/readiness` gana dos comprobaciones: `security.version_overrides`
     (no bloqueante — el override es herramienta legítima de transición, pero
     R17 se niega a decir verde mientras el stack no corra un único TAG) y
     `security.version_overrides_declared` (**bloqueante** — un override con
     efecto y sin declarar es el defecto, no el override en sí).

**El destino declarado es volver a un único `TAG` común** en la alineación
completa. Cada entrada de `activos` es deuda con condición de cierre.

## 5. Nota técnica: la interpolación anidada

Había **dos** implementaciones de `interpolar` en el repositorio
(`deploy-contract-gate.mjs` y `runtime-drift-scan.mjs`), las dos con una regex
de una sola pasada cuyo grupo de defecto (`[^}]*`) se para en la primera llave
de cierre. Sobre `${A:-${B:-c}}` devolvían la cadena literal `${B:-c}` como si
fuera una etiqueta, y `String.replace` no reentra en lo que acaba de escribir.
Un gate que comparase esos nombres habría estado verde mientras Compose
desplegaba otra cosa.

Ahora hay **una sola** implementación (`infrastructure/scripts/lib/interpolar.mjs`),
con emparejamiento de llaves, y **calibrada contra la autoridad real**: la tabla
`CASOS_CALIBRACION` es lo que devuelve `docker compose config` (v5.3.0) en el
anfitrión de despliegue sobre un compose de juguete en un directorio temporal.

## 6. El gate, ejecutado

```
$ node infrastructure/scripts/tag-override-gate.mjs --gate
GATE DE RECREACIÓN (línea base vs objetivo)
  changed_images                  1
    service                       tournament-worker  s9arena/tournament-worker:4d469dc → s9arena/tournament-worker:82c74a8
  changed_specs_other_than_image  0

VERDE · el override es selectivo, visible y no toca nada más
```

Contrastado **por efecto** contra el `docker compose config` real del anfitrión
de despliegue, en un directorio temporal propio (creado y destruido; producción
no se tocó):

- baseline (`TAG=4d469dc`) vs objetivo (`+ TOURNAMENT_WORKER_TAG=82c74a8`):
  una sola línea de diferencia, `tournament-worker`;
- la spec completa **sin** el campo `image` es byte a byte idéntica
  (`changed_specs_other_than_image = 0`);
- con `TAG=CENTINELA`: `api → s9arena/api:CENTINELA` y
  `backup → s9arena/backup:ad0a42b` (la copia no se movió).

El número esperado **no está cableado**: sale de `overrides_de_version.activos`,
así que el gate no puede aprobar un override distinto del declarado, y si mañana
se adelanta `bot-manager` esperará dos imágenes (por el artefacto compartido) en
vez de una.

## 7. Procedencia de la imagen objetivo (ADR-016)

**La CI ya publicó el artefacto.** Se publica como `sha-<sha completo>`; `:main`
y `sha-<corto>` **no existen** (comprobado: HTTP 404 los tres).

| dato               | valor                                                                   |
| ------------------ | ----------------------------------------------------------------------- |
| referencia         | `ghcr.io/pjclavero/s9-ai-arena/tournament-worker:sha-82c74a80043997b162dba6a0caad8e944be143ce` |
| manifest digest    | `sha256:24165b4d944722483c57ed5ab9e34fb259a7106a9cab8d8eac28f22c666f2831` |
| **Image ID**       | `sha256:b61209b159b465975db074e1baaef63755bbfa74a654d7bb92bb29793bc9298c` |
| `BUILD_COMMIT`     | `82c74a80043997b162dba6a0caad8e944be143ce`                              |
| OCI `revision`     | `82c74a80043997b162dba6a0caad8e944be143ce`                              |
| `BUILD_DATE`       | `2026-09-06T13:57:06Z`                                                  |

Producción usa `IMAGE_PREFIX=s9arena` (imágenes locales), así que el paso previo
es **traer y retaguear, nunca reconstruir**:

```
docker pull  ghcr.io/pjclavero/s9-ai-arena/tournament-worker:sha-82c74a80043997b162dba6a0caad8e944be143ce
docker image inspect -f '{{.Id}}' ghcr.io/.../tournament-worker:sha-82c74a8...   # == b61209b1...
docker tag   ghcr.io/pjclavero/s9-ai-arena/tournament-worker:sha-82c74a80043997b162dba6a0caad8e944be143ce \
             s9arena/tournament-worker:82c74a8
```

Retaguear no cambia el Image ID, y por eso la verificación posterior es posible.

**Si el artefacto no estuviera publicado** (no es el caso hoy): se construye
desde un clon del **remoto**, nunca desde el árbol de producción — `build.context: ..`
se resuelve contra `--project-directory` y con el de producción construiría el
árbol equivocado; ése es el incidente original del proyecto. Y `git clone` de
una ruta **local** enlaza `.git/objects` con enlaces duros: si hay que clonar en
la misma máquina, `--no-hardlinks`. Con `BUILD_COMMIT=$(git rev-parse HEAD)` y
`BUILD_DATE` explícitos (ADR-016): sin ellos la imagen queda «unknown» y el gate
de despliegue la rechaza.

### Verificación posterior (preparada, no ejecutada)

1. `docker inspect -f '{{.Image}}' <contenedor>` ⇒ `sha256:b61209b1…` (**running
   Image ID == target Image ID**).
2. `BUILD_COMMIT` en el runtime ⇒ `82c74a80043997b162dba6a0caad8e944be143ce`.
   Hoy el contenedor vivo **no lleva identidad embebida** (medido: ninguna de las
   variables `BUILD_*` está presente), así que este paso además cierra un hueco
   de procedencia que hoy existe.
3. `node infrastructure/scripts/tag-override-gate.mjs` ⇒ `EFFECTIVE`
   `tournament-worker 82c74a8`.
4. `runtime-drift-scan.mjs --overrides-from-contract …` ⇒ fila
   `tournament-worker` con `override=82c74a8` y `result=OK`.

## 8. Comando de recreación — **RENDERIZADO, NO EJECUTADO**

```
IMAGE_PREFIX=s9arena TAG=4d469dc TOURNAMENT_WORKER_TAG=82c74a8 \
  docker compose --project-directory <directorio-de-despliegue> \
  -p infrastructure -f infrastructure/docker-compose.yml \
  --profile development up -d --no-build --no-deps tournament-worker
```

Lo genera `tag-override-gate.mjs --invocacion` **desde el contrato**, así que no
puede divergir de él.

- `--no-build`: `build.context: ..` construiría el árbol equivocado.
- `--no-deps`: `depends_on` alcanza a `postgres` (**NO RESTART**) y a `queue`
  (que este carril no toca).
- un solo servicio nombrado: no se recrea nada más.

**Precondición para cualquier operación sobre `queue`**: desplegar este worker
cierra el riesgo de la parálisis silenciosa. Mientras no se despliegue, tocar
Redis paraliza el torneo sin que ningún healthcheck lo diga.
