# ADR-017 · Contrato de release: BUILD y DEPLOY son fases distintas

- **Estado**: aceptado
- **Ámbito**: todo despliegue del stack `infrastructure/docker-compose.yml`
- **Complementa a**: ADR-016 (identidad de build). ADR-016 hace que la imagen
  pueda decir de dónde salió; ADR-017 dice **cuándo se construye, cuándo se
  despliega y qué hay que poder enseñar para afirmar que un despliegue ocurrió**.
- **Utillaje**: `infrastructure/scripts/release-gate.mjs`,
  tests y mutaciones en `infrastructure/tests/release-gate.test.ts`.

> Ninguna regla de este documento es una buena práctica genérica. Cada una está
> aquí porque un incidente concreto y verificado de este proyecto la habría
> evitado, y cada una tiene una prueba capaz de ponerse roja.

## 1. Los incidentes que este contrato impide

| # | Incidente (todos reales en este proyecto) | Qué falló de verdad | Regla |
|---|---|---|---|
| 1 | Construcción con el contexto equivocado: `--project-directory` de producción sobre un compose con `build.context: ..`. Se compiló el árbol **viejo** (`98f381ec`) y se etiquetó con el commit **nuevo** (`4d469dc`). Cuatro servicios "pasaron" el gate desplegando código antiguo. | El gate comparaba *imagen declarada == imagen desplegada*: una **tautología** cuando la etiqueta miente. | §2, §3 |
| 2 | Contenedor corriendo una image ID **borrada del daemon**: vivo sobre sus capas, no reproducible tras un restart. | Nada miraba la existencia de la image ID en ejecución. | §5 |
| 3 | **Etiqueta movida bajo un contenedor vivo**: `infrastructure-postgres-1` corre PostgreSQL **16.14** mientras `postgres:16-alpine` ya resuelve a **16.15**. Un restart cambiaría la versión de la base de datos sin decisión de nadie. | La etiqueta no es una identidad: es un puntero mutable, y otro carril del mismo host lo movió. | §5, §6 |
| 4 | Gate que **se contradecía a sí mismo**: imprimía "intercambio de imagen puro" justo debajo de haber clasificado un cambio de montajes. | El texto y el diff se calculaban por separado. | §4 |
| 5 | Invariante medido sobre un **host compartido**: un recuento de contenedores del host dio fallo espurio porque otro carril corría uno efímero. | El invariante era del stack; la medida, del host. | §6 |
| 6 | `docker images -q` usado como **prueba de existencia**: omite imágenes sin etiqueta de nivel superior. | Hoy en VM108 la imagen que realmente corre en postgres **no aparece** en ese listado. | §5 |
| 7 | Un `git clone` de **ruta local** hardlinkeó `.git/objects`; un borrado posterior vació **384 objetos** del repositorio productivo. | El clon no era una copia: era el mismo inodo. | §8 |

Estado medido en VM108 el 2026-09-02 (solo lectura), que da fe de 3, 5 y 6 y
añade un hallazgo:

- `postgres:16-alpine` resuelve hoy a un digest distinto del que corre → **16.15
  frente a 16.14 en marcha**;
- la image ID en ejecución de postgres **no aparece** en `docker images --no-trunc -q`;
- convive con el stack un contenedor **sin proyecto Compose** de otro carril;
- los contenedores del **mismo** proyecto declaran **tres**
  `com.docker.compose.project.config_files` distintos (dos árboles de build
  temporales y el directorio de producción): no hay compose canónico, así que
  ningún comando reproduce el conjunto desplegado (§7).

## 2. BUILD y DEPLOY

No son dos pasos de lo mismo: son dos fases con entradas, salidas y
verificaciones distintas. **Entre ellas hay una verificación de contenido**; sin
ella, el incidente 1 es invisible.

```
BUILD   árbol fuente correcto · commit correcto · contexto correcto ·
        BUILD_COMMIT embebido · etiquetas de imagen · verificación de CONTENIDO
DEPLOY  --no-build OBLIGATORIO · project-directory productivo · imagen ya construida ·
        image ID en ejecución · spec diff · health · smoke · verificación de versión
```

**BUILD**

1. Un árbol fuente limpio y **declarado** (§8 para cómo se obtiene).
2. `BUILD_COMMIT=$(git rev-parse HEAD)` **de ese árbol**, `BUILD_DATE`, `SERVICE_NAME`.
3. `--project-directory` = **el árbol fuente**, nunca el de producción.
4. Etiquetado de imagen con ese commit.
5. **Verificación de CONTENIDO antes de desplegar nada**:
   `verify-image-provenance.mjs` (ADR-016) — tag = `org.opencontainers.image.revision` = `/version`.

**DEPLOY**

1. `--no-build` **obligatorio**.
2. `--project-directory` = **el de producción** (§3).
3. La imagen ya existe y ya pasó la verificación de contenido. Aquí no se construye.
4. Comprobar la **image ID en ejecución** (existe, y es la de la etiqueta) (§5).
5. **Spec diff** clasificado de forma no contradictoria (§4).
6. Health, humo **no destructivo** (§9), y verificación de versión desplegada.

```bash
node infrastructure/scripts/release-gate.mjs --invocacion build \
  --arbol-fuente /tmp/arbol-<sha> -- <la invocación de build>
node infrastructure/scripts/release-gate.mjs --invocacion deploy -- <la invocación de deploy>
```

## 3. La regla de `--project-directory`

`--project-directory` **no controla una cosa: controla tres a la vez**.

1. el contexto de construcción de todo `build.context` **relativo**;
2. la resolución de rutas relativas (volúmenes, `env_file`, confs);
3. la resolución de los **ficheros de secretos**.

Por eso no vale "quitarlo para construir y ponerlo para desplegar" sin más, y
por eso el incidente 1 no fue un descuido tonto: quien lo puso lo puso por (3),
y sin saberlo cambió (1).

- **BUILD**: `--project-directory` = **el árbol fuente que se quiere construir**.
- **DEPLOY**: `--project-directory` = **el de producción** (para que (2) y (3)
  resuelvan bien) **+ `--no-build`**, para que (1) no pueda construir nada.

## 4. Un gate no puede contradecirse a sí mismo

La clasificación de un cambio **se deriva del conjunto de campos que difieren**;
no se calcula aparte del texto que la anuncia. `clasificarCambioDeSpec` devuelve
`{clase, camposCambiados, resumen}` donde `resumen` se construye *desde*
`camposCambiados`: no existe ningún camino que imprima "intercambio de imagen
puro" con `mounts` en la lista. Es una invariante probada sobre un abanico de
specs, no una promesa.

## 5. Prohibido como evidencia única

Ninguna de estas tres, por sí sola, prueba nada:

| Señal | Por qué no vale |
|---|---|
| **La etiqueta** | Mintió y el gate la bendijo (incidente 1). Y es un puntero mutable que otro puede mover bajo un contenedor vivo (incidente 3). |
| **Un `docker compose` con salida 0** | Salió 0 construyendo el árbol equivocado (incidente 1). |
| **Un contenedor `healthy`** | Un contenedor healthy corría sobre una image ID ya borrada (incidente 2), y hoy `infrastructure-postgres-1` lleva días healthy sobre una imagen que ninguna etiqueta nombra ya. |

Y dos reglas de medida:

- **La existencia de una imagen se prueba con `docker image inspect <id>`**, nunca
  con la pertenencia a `docker images -q`: ese listado omite las imágenes sin
  etiqueta de nivel superior (incidente 6, reproducido hoy con postgres).
- **La etiqueta que resuelve hoy debe ser la image ID que corre.** Si difieren,
  un restart cambia de versión sin decisión de nadie (incidente 3).

Ninguna de esas dos se reimplementa aquí. La **autoridad de identidad** es
`BUILD_COMMIT` + `/version` + image ID que **existe**, nunca la etiqueta, y el
clasificador único de los **cuatro estados** de ADR-016
(`IMAGE_MISSING`, `TAG_CONTENT_MISMATCH`, `TAG_MOVED`, `RUNTIME_MATCH`) vive en
`infrastructure/scripts/lib/image-drift.mjs` (`clasificarDrift`), consumido por
`packages/readiness/probes-docker.ts` y por `check-running-image-id.mjs`.

Y `RUNTIME_MATCH` **a secas no es "verificado"**: la matriz
`ESTADO_DRIFT_A_READINESS` de `packages/readiness/checks.ts` lo mapea a
`requiere_procedencia`, porque que la image ID sea la esperada no dice de qué
árbol salió. El §6 de este contrato es lo que cierra esa mitad.

## 6. Todo despliegue responde cuatro preguntas

| Pregunta | Fuente admisible |
|---|---|
| **qué código** | `git rev-parse HEAD` del árbol **que se construyó** |
| **qué imagen** | `org.opencontainers.image.revision` de la imagen + su image ID |
| **qué SPEC** | `docker compose config` del compose **canónico** (§7) |
| **qué runtime** | `/version` del contenedor **en marcha** + su image ID en ejecución |

Fail-closed: una pregunta sin responder **no se aprueba por omisión**, y una
respondida con una de las señales del §5 se rechaza.

```bash
node infrastructure/scripts/release-gate.mjs --evidencia despliegue.json
```

**Ámbito de la medida.** Todo invariante se toma sobre el **proyecto Compose**
(`com.docker.compose.project`), nunca sobre el host: se comprueba que estén todos
los servicios esperados y que no sobre ninguno **dentro del proyecto**. Un
contenedor efímero de otro carril ni falta ni sobra — es de otro (incidente 5).

## 7. Un solo compose canónico

Los contenedores de un mismo proyecto deben declarar **el mismo**
`com.docker.compose.project.config_files`. Tres orígenes distintos, como hay hoy
en VM108, no son un stack desplegado: son despliegues parciales solapados que
ningún `docker compose` posterior reproduce. Lo comprueba `composeCanonicoUnico`.

## 8. Entornos temporales

- **Nunca `git clone` de una ruta local** salvo con `--no-hardlinks`. Un clon
  local hardlinkea `.git/objects`: no es una copia, es el mismo inodo, y un
  borrado destructivo del clon vació 384 objetos del repositorio productivo.
  **Preferir el remoto.**
- **Limpiar con `rm -rf`, nunca con `shred`.**
- `shred` **solo** para secretos aislados, y comprobando antes
  `stat -c '%i %h %n' <fichero>`: **si el contador de enlaces es mayor que 1,
  ABORTAR** — hay otro nombre apuntando al mismo inodo y el shred lo destruye
  también. Si el contador no se puede leer, también se aborta (fail-closed).

## 9. Nada destructivo como prueba de humo en producción

Prohibido usar como prueba de humo contra producción cualquier operación
destructiva: barrido de retención, `DELETE`, `forget`, `prune`, `TRUNCATE`,
`rm -rf`. **Motivo real: una sonda de retención sin autenticación borró replays
de producción** — la "prueba" de la garantía la demostró destruyendo el dato.

Si una garantía destructiva debe probarse, va en **fixture aislado**. El humo de
producción son lecturas (`infrastructure/scripts/smoke.sh`).

## 10. Cómo se cuenta la CI

Se cuenta el **recuento de conclusiones de TODOS los checks**. **Nunca el final
de un `--watch`**: `gh run watch` informa del último job que terminó, no del
estado del conjunto.

- `skipped`, `neutral` y `not_exercised` **NO** son éxito.
- Un check todavía en marcha no es éxito.
- Un recuento vacío no es verde (fail-closed: no se leyó nada).

```bash
gh pr checks <n> --json name,state,bucket   # o `gh api …/check-runs`
node -e '…' # contarConclusiones() de release-gate.mjs
```

Es la misma regla que ya aplica el semáforo del run
(`infrastructure/scripts/ci-gate.mjs`); aquí se enuncia para quien **lee** la CI
desde fuera, que es donde se coló el error.

## 11. Merges

- **Seriales**, uno detrás de otro, con **CI post-merge entre cada uno**: dos
  ramas verdes por separado no son una `main` verde.
- Si una rama **se actualiza y cambia su HEAD** entre la revisión y el merge, se
  supervisa el **delta exacto** (`git diff <HEAD-revisado>..<HEAD-nuevo>`) antes
  de mergear. Una aprobación es de un árbol concreto, no de un nombre de rama.
- Todo informe de verificación empieza declarando **repo, rama y HEAD**.

## Consecuencias

- El incidente 1 deja de ser posible en silencio: el DEPLOY sin `--no-build` se
  rechaza, y un BUILD cuyo `--project-directory` no es el árbol declarado también.
- Un despliegue que no puede responder las cuatro preguntas no se afirma.
- El coste es una invocación más (`release-gate.mjs`) por fase.
- Lo que este ADR **no** hace: no comprueba la coherencia interna de una imagen
  ni clasifica los cuatro estados de drift (eso es ADR-016, con el clasificador
  único en `infrastructure/scripts/lib/image-drift.mjs`), ni traduce esos estados
  a un veredicto de readiness (eso es `ESTADO_DRIFT_A_READINESS`). Los consume;
  no los reimplementa.
