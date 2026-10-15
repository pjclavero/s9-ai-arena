# Runtime drift scanner

`infrastructure/scripts/runtime-drift-scan.mjs`

## Qué es y qué NO es

```
DRIFT SCANNER  = obtiene HECHOS
R17            = INTERPRETA hechos
```

El escáner **no dice «listo» ni «no listo»**. Dice *qué hay*: por cada servicio en
marcha, qué etiqueta se declaró, sobre qué image ID corre de verdad, si esa image
ID sigue existiendo en el daemon, a qué ID resuelve **hoy** la etiqueta declarada,
qué identidad de build trae embebida (si trae alguna), qué runtime ejecuta y en
qué se aparta de la especificación en montajes, secretos y variables de entorno.
La decisión de readiness es de R17, que consume el JSON de aquí.

## Columnas

| campo | significado |
|---|---|
| `service` | nombre del servicio Compose (no el del contenedor) |
| `declared_ref` | referencia de imagen que el contenedor declara (`Config.Image`) |
| `running_image_id` | image ID de contenido sobre la que corre de verdad |
| `running_image_exists` | ¿existe esa ID en el daemon? — vía `docker image inspect` |
| `declared_ref_current_id` | a qué ID resuelve **hoy** `declared_ref` |
| `expected_digest` | digest exigido por la especificación (si la hay) |
| `build_commit` | `org.opencontainers.image.revision` embebido (ADR-016) |
| `runtime_version` | versión de runtime realmente ejecutada (PG/NODE/REDIS/NGINX…) |
| `spec_drift` | desvío en montajes, secretos y entorno |
| `result` | estado (ver abajo) |

### Estados

`IMAGE_MISSING` › `TAG_MISMATCH` › `TAG_MOVED` › `DIGEST_MISMATCH` › `RUNTIME_DRIFT`
› `SPEC_DRIFT` › `NOT_EXERCISED` › `OK` (precedencia: gana el primero que aplique).

**`NOT_EXERCISED` no es éxito.** Es evidencia que falta, no evidencia a favor: sale
cuando no hay identidad de build embebida, cuando no se ha comprobado la existencia
de la imagen o cuando no hay especificación contra la que comparar. `rc=1` salvo
`--allow-unknown`.

El modelo de 4 estados de drift lo define el carril de **procedencia** (ADR-016,
`verify-image-provenance.mjs`). Este escáner no lo duplica: emite hechos crudos
más un `result` estable que ese modelo puede mapear. Es una **dependencia
declarada**, no una reimplementación.

## Uso

```bash
# 1) adquisición en el anfitrión de Docker (LECTURA PURA: ps, inspect, image inspect)
node infrastructure/scripts/runtime-drift-scan.mjs --collect > hechos.json

# 2) interpretación donde sea (no necesita Docker), con el objetivo derivado del Compose
node infrastructure/scripts/runtime-drift-scan.mjs \
  --facts hechos.json \
  --target-from-compose infrastructure/docker-compose.yml \
  --compose-env GATEWAY_CONF=nginx-behind-proxy.conf \
  [--target anulaciones.json] [--json]

node infrastructure/scripts/runtime-drift-scan.mjs --self-test   # calibración
```

`--collect` no depende de `node_modules`: corre tal cual en el anfitrión.

## Los dos defectos reales que este escáner existe para no repetir

### 1. `docker images -q` no ve las imágenes sin etiqueta

Medido en el daemon de producción:

```
docker images --no-trunc -q     | grep -c 57c72fd2a128  →  0
docker images -a --no-trunc -q  | grep -c 57c72fd2a128  →  1
docker image inspect sha256:57c72fd2a128…              →  la encuentra
```

`57c72fd2a128` es la imagen sobre la que corre postgres. Se quedó **sin
etiquetas** cuando `postgres:16-alpine` se movió a otra imagen, y por eso el
listado no la lista. Comprobar la existencia con el listado produce un falso
«imagen desaparecida». **Aquí la existencia se comprueba siempre con
`docker image inspect <id>`.**

### 2. Comparar montajes por nombre físico

Compose prefija el proyecto: `arena_replays` se materializa como
`infrastructure_arena_replays`. Comparar el nombre físico:

- marca drift donde no lo hay (ruido que acaba ignorándose), y
- empareja por **nombre** en vez de por **destino**, así que un destino correcto
  servido por un volumen que no corresponde pasa inadvertido — el falso negativo
  peligroso.

Aquí se compara por **destino + origen lógico + rw/ro + tipo**. El origen lógico
es el nombre sin prefijo de proyecto (volúmenes) o la ruta relativa al árbol
desplegado (`repo:infrastructure/secrets/tls`, binds). Un bind fuera de ese árbol
sale como `bind:#<hash>` opaco, que **nunca** equivale a un origen esperado.
Las **ausencias deliberadas** (`absent`) se verifican como ausencias de verdad:
si la especificación retira un montaje y sigue ahí, es drift.

## Topología

Nada de lo que emite el escáner lleva topología real: sin IPs, sin nombres de
anfitrión, sin rutas absolutas. De los secretos solo sale el nombre lógico del
montaje bajo `/run/secrets`; de las variables de entorno, solo los **nombres**,
nunca los valores. Un test de la suite lo comprueba sobre la salida real.

## Estado medido en producción (solo lectura, 12 contenedores)

- **11 servicios `NOT_EXERCISED`**: las imágenes son anteriores a ADR-016 y no
  llevan identidad de build embebida. Su procedencia queda **desconocida**, no
  verificada.
- **`postgres` = `TAG_MOVED`**: corre `57c72fd2a128` (PostgreSQL **16.14**), que
  existe pero se quedó sin etiquetas; `postgres:16-alpine` resuelve hoy a
  `cf78e76683b9` (**16.15**). Un `docker compose up` de ese servicio cambiaría la
  versión de la base de datos. Además `RUNTIME_DRIFT` por 16.14 ≠ 16.15.
- **`spec_drift` limpio en los 12** contra el objetivo derivado del Compose: la
  normalización del prefijo de proyecto y de los binds casa con la realidad.

## Calibración

`infrastructure/tests/runtime-drift-scan.test.ts` (control positivo + negativos)
y el harness de mutación:

```bash
node infrastructure/scripts/runtime-drift-mutations.mjs
```

Estropea el escáner de verdad y exige que la suite se ponga **roja** con cada
mutación: existencia siempre cierta, etiqueta siempre coincidente,
`IMAGE_MISSING` como PASS, `TAG_MOVED` como PASS y montajes comparados por nombre
físico. Una mutación que sobrevive es una garantía que no comprueba nadie.
