# Contrato de despliegue reproducible

Un despliegue no es reproducible porque alguien lo recuerde bien. Este documento
y `infrastructure/deploy-contract.json` fijan **de una vez** proyecto, ficheros
compose, perfil(es), TAG, prefijo de imagen, ficheros de entorno y ruta de
secretos; `infrastructure/scripts/deploy-contract-gate.mjs` los verifica, y la CI
comprueba que ese verificador **sabe ponerse rojo**.

Este carril **no despliega nada**. Entrega el contrato y su gate.

## Los tres defectos medidos

### 1 · Referencia de postgres incoherente (corregido aquí)

`infrastructure/docker-compose.yml` declaraba:

```
postgres:16-alpine@sha256:57c72fd2a128…
```

El **digest es correcto** y resuelve en el registro: es el índice OCI publicado
de `postgres:16.14-alpine`, con `PG_VERSION=16.14` en las 8 plataformas. Lo
incoherente es el emparejamiento: la etiqueta `16-alpine` resuelve **hoy** a
16.15 (`sha256:cf78e766…`). Docker resuelve por digest e ignora la etiqueta, así
que funcionaba; pero `docker manifest inspect` de esa referencia responde
`manifest verification failed`, y quien la lea entiende 16.15.

Corrección aplicada, y ninguna más — **el digest no cambia**:

```
postgres:16.14-alpine@sha256:57c72fd2a128…
```

No cambia contenido ni versión objetivo. **Subir a 16.15 va en ventana aparte.**

### 2 · `TAG=local` en el entorno de despliegue (P0, NO corregido aquí)

Mientras corren imágenes `:4d469dc`, el `.env` del despliegue fija `TAG=local`, y
las etiquetas `:local` apuntan a las imágenes **anteriores** al rollout
(`api:local` ≠ `api:4d469dc`; igual en gateway, web y tournament-worker). Un
`docker compose up --no-build` recrearía los doce servicios contra las imágenes
de la versión previa, **revirtiendo el rollout entero sin avisar**.

El repositorio no puede arreglar el `.env` de una máquina: lo que sí puede es
hacer que ese estado sea **imposible de aprobar**. Es el gate C.

### 3 · El perfil productivo no estaba declarado

Todos los servicios llevan `profiles:`. Sin `COMPOSE_PROFILES`, el compose
renderiza **CERO** servicios (medido: `docker compose config --services` sale
vacío). El rollout usó `--profile development`. Nada en el repositorio lo decía.
Ahora lo dice el contrato, y el gate D lo verifica **por conjunto de servicios**.

## Las cuatro garantías del gate

### B · Referencia de imagen, en tres niveles separados

```
1 SINTAXIS   contiene @sha256:<64 hex válidos>
2 REGISTRO   el digest RESUELVE en el registro, la etiqueta que lo acompaña
             resuelve AL MISMO digest, y la plataforma esperada existe
3 VERSIÓN    el artefacto resuelto contiene la versión esperada (PG_VERSION)
```

Se informan por separado y ninguno absorbe al siguiente: un digest impecable
puede ser el de otra versión.

#### La autoridad del nivel 2 NO puede ser el almacén local de Docker

Error real cometido durante este análisis, y la razón de que la regla esté
escrita en el código:

```
docker image inspect postgres:16-alpine@sha256:57c72fd2a128…
  → Error response from daemon: No such image
```

De ahí se concluyó —**mal**— que el digest no existía y que era un image ID
local. El digest existe y resuelve sin problema. Lo que ocurre es que la imagen
del almacén local no tiene `RepoDigests` (se quedó sin etiquetas cuando
`postgres:16-alpine` se movió a 16.15), y `docker image inspect` sólo sabe de lo
que hay en el daemon. **El almacén local responde por lo que se descargó, no por
lo que el registro publica.** Como autoridad da falsos negativos —un digest real
declarado inexistente— y podría dar falsos positivos.

La autoridad es el registro, y se consulta **sin descargar**:

```
docker buildx imagetools inspect <ref>     # digest, plataformas y config
docker manifest inspect <ref>              # además verifica etiqueta↔digest
```

Por eso todo resolvedor debe declarar `fuente: "registro"`. Uno que declare
`almacen-local`, o que no lo declare, se rechaza con `N2_FUENTE_NO_AUTORIZADA`
**aunque sus datos sean correctos**: la garantía es de dónde viene el hecho.

Y «no pude preguntar» no es «no existe»: un `429 Too Many Requests` de Docker
Hub (ocurrió de verdad a mitad de esta comprobación) sale como
`N2_REGISTRO_INACCESIBLE`. Rojo igual — no comprobado no es aprobado — pero sin
hacer creer que un digest bueno se ha esfumado.

### C · Gate de TAG, por efecto

Prohibir la palabra `local` no arregla nada: `IMAGE_PREFIX`, un default
`:latest` o cualquier otra interpolación producen el mismo drift. El gate
**renderiza** el compose con el entorno declarado y compara la referencia
resultante de cada servicio con el artefacto que el contrato dice desplegar.
Probado: `TAG=local` falla, `TAG` ausente (cae a `:latest`) falla,
`IMAGE_PREFIX` cambiado falla, y un TAG plausible que no es el del contrato
también falla.

### D · Gate de perfil, por conjunto exacto

Igualdad de conjuntos contra `servicios_esperados`, no comparación de nombres:

| Perfil | Servicios | Veredicto |
| --- | --- | --- |
| (ninguno) | 0 | **no aceptable** — el peor falso negativo posible |
| `nucleo` | 7 | no aceptable: conjunto incompleto |
| `development` | 11 | **canónico** |
| `production` | 12 | no aceptable: arrastra `backup`, gestionado aparte |
| `external-db` | 11 (sin `postgres`) | no aceptable |

Los conjuntos están medidos con `docker compose config --services` real y viven
en `infrastructure/tests/fixtures/compose-profiles-medido.json`, que **calibra**
el renderizador offline del gate: si se apartara de lo que Docker hace, el gate
compararía el stack contra una ficción.

`backup` queda fuera del conjunto canónico a propósito (`gestionados_aparte`):
tiene ventana propia y su alineación es un carril posterior.

#### Discrepancia declarada (no resuelta aquí)

Tres cosas dicen tres perfiles distintos, y conviene no taparlo:

| Fuente | Perfil / conjunto |
| --- | --- |
| `docs/despliegue.md` | `--profile production` (12 servicios) |
| El stack vivo | 12 servicios, `backup` incluido — coincide con `production` |
| Este contrato | `development` (11) + `backup` gestionado aparte |

El contrato elige `development` porque `backup` **hoy no se despliega con el
resto**: corre una imagen de otra versión (`11b36a7` frente a `4d469dc`) y viene
de otro árbol de construcción, es decir, ya está gestionado aparte de hecho, no
sólo de derecho. Declararlo dentro del conjunto canónico haría que el gate
aprobara un `up` que lo recrearía junto a los demás.

**Consecuencia:** mientras `backup` no se alinee (carril posterior), el conjunto
canónico y el stack vivo difieren en ese servicio **a propósito y por escrito**.
Cuando ese carril cierre, el contrato pasa a `production` y el conjunto a 12; el
gate D lo hará fallar hasta que ambas cosas se cambien a la vez, que es
exactamente lo que se quiere.

### E · Servicios con estado

`STATEFUL_SERVICES = { postgres, queue }`. Ambos deben declarar volumen,
destino, durabilidad y política **explícita** de persistencia y de recreación, y
el gate comprueba que el volumen existe en el compose y está montado en su
destino.

`queue` entra aquí a propósito: es Redis con `--appendonly yes` sobre
`queue_data`, es decir **estado durable**, y hasta ahora se trataba como
infraestructura inocua.

**DEUDA-QUEUE-BACKUP (declarada, no resuelta):** no hay backup/restore diseñado
ni probado para `queue_data`. Diseñarlo es un carril propio; aquí sólo se
declara, y el gate exige que quien no tenga copia verificada declare su deuda
—callarla sería aprobar por omisión.

## La envoltura

El contrato **es** la envoltura declarativa, y el gate la emite como invocación
ejecutable desde el mismo fichero que verifica (no pueden divergir):

```
node infrastructure/scripts/deploy-contract-gate.mjs --invocacion
```

Salida (variables + argv exactos, con `--no-build` del contrato de release):

```
TAG=4d469dc IMAGE_PREFIX=s9arena docker compose \
  -f infrastructure/docker-compose.yml --env-file infrastructure/.env \
  -p infrastructure --profile development up -d --no-build
```

Nadie tiene que recordar cinco flags, y la invocación es inspeccionable: sale del
contrato que el gate comprueba.

## Uso

```
node infrastructure/scripts/deploy-contract-gate.mjs --self-test    # offline
node infrastructure/scripts/deploy-contract-gate.mjs                # C, D, E
node infrastructure/scripts/deploy-contract-gate.mjs --registro     # + niveles 2 y 3
node infrastructure/scripts/deploy-contract-gate.mjs --invocacion
node infrastructure/scripts/deploy-contract-mutations.mjs           # calibración
```

`rc=0` verde · `rc=1` alguna garantía roja · `rc=2` no se pudo comprobar
(contrato o compose ausentes). **La ausencia nunca es aprobado**: sin
`--registro`, los niveles 2 y 3 salen `NO_EJERCIDO` y el gate no aprueba.

## Lo que este carril NO hace

- No despliega, no recrea, no reinicia, no toca producción.
- No sube postgres a 16.15 (ventana aparte).
- No arregla el `.env` de la máquina de despliegue: lo hace inaprobable.
- No diseña backup/restore de `queue_data` (deuda declarada arriba).
- No alinea `backup` con el conjunto canónico (carril posterior).
