# Apagar y encender VM108 sin perder trabajo

> Runbook operativo. Para el día a día del stack, ver [`../OPERACION_VM108.md`](../OPERACION_VM108.md).

## Qué se pierde y qué no

Lo que **no** se pierde en un apagado son los datos: viven en volúmenes de Docker, en disco.

| Volumen | Contenido | Sobrevive |
|---|---|---|
| `infrastructure_postgres_data` | base de datos completa | sí |
| `infrastructure_arena_replays` | repeticiones | sí |
| `infrastructure_arena_maps` · `_assets` · `_bot_sources` | contenido | sí |
| `infrastructure_queue_data` | cola Redis | sí, pero es **EPHEMERAL** — su contenido no es autoridad de nada |

Lo que sí se pierde es el **trabajo a medias**: un job reclamado que nadie devolverá a la
cola, una batalla en curso con su contenedor efímero, una transacción abierta sin confirmar.
Por eso el preflight mira estado en vuelo, no espacio en disco.

La autoridad sobre qué trabajo existe es **PostgreSQL**, no Redis: la cola sólo avisa. Un job
en `running` en la tabla `jobs` sigue ahí después del apagado; lo que desaparece es el aviso.

## 1 · Preflight (obligatorio)

```bash
ssh root@192.168.1.208
bash /opt/s9-ai-arena/infrastructure/scripts/preflight-apagado.sh
```

Tres resultados, y sólo uno autoriza:

| rc | Significado | Qué hacer |
|---|---|---|
| `0` | **SEGURO APAGAR** | continuar |
| `1` | **NO APAGAR** — hay trabajo en vuelo | esperar a que termine y repetir |
| `2` | **INDETERMINADO** — alguna comprobación no se pudo hacer | investigar; **no** apagar |

El `rc=2` existe a propósito: una comprobación que no se pudo hacer no es un visto bueno.
Si el contenedor de PostgreSQL no responde, el preflight no puede afirmar que no hay jobs en
vuelo — y decir «0 jobs» porque la consulta falló sería exactamente la clase de falso verde
que estos gates existen para evitar.

El script está calibrado: con un contenedor de postgres inexistente sale `2`, con un
contenedor ajeno corriendo sale `1` nombrándolo, y sin mutaciones sale `0`.

## 2 · Apagado

**Ordenado, nunca brusco.** Desde dentro de la VM:

```bash
shutdown -h now
```

O desde Proxmox: **Shutdown** (envía ACPI y la VM se apaga sola).

> **Nunca «Stop»** en Proxmox. Equivale a tirar del cable: PostgreSQL tendría que recuperar
> el WAL al arrancar. Normalmente lo consigue, pero es un riesgo que no hace falta correr.

No hace falta parar los contenedores a mano antes: el apagado ordenado envía `SIGTERM` a
Docker, que lo propaga. PostgreSQL cierra su cluster limpiamente y Redis vuelca su AOF.

## 3 · Encendido

No hay que hacer nada: `docker` está habilitado en el arranque y los 12 contenedores tienen
`restart=unless-stopped`, así que el stack vuelve solo.

Comprobación después de arrancar:

```bash
docker ps --filter label=com.docker.compose.project=infrastructure --format '{{.Names}}\t{{.Status}}'
# esperado: 12 contenedores, todos (healthy)
```

Si alguno tarda, es normal: `postgres` alcanza `healthy` en ~25 s y `api` en ~50 s, porque
espera a que la base de datos esté lista.

### Lo que aparecerá en los logs y NO es una incidencia

`tournament-worker` registrará **exactamente una** degradación y **una** recuperación de Redis:

```
Redis no disponible: el worker degrada a polling de la BD   err=... (socket cerrado)
Redis recuperado: vuelve el aviso por señal
```

Es el comportamiento correcto, verificado en producción: al apagarse Redis el socket se
cierra, el worker lo detecta y pasa a consultar la base de datos; al volver, retoma la señal.
Los contadores son **por transición**, así que una parada = una degradación, no una por
segundo. Si vieras el contador subiendo continuamente con Redis sano, *eso* sí sería un fallo.

## 4 · Dos cosas que conviene tener en cuenta

**El backup diario corre a las 04:15 UTC.** Si la VM sigue apagada a esa hora, ese día no hay
copia. No pasa nada por un día, pero conviene saberlo si el apagado se alarga.

**VM108 vive en `Hvergelmir` (192.168.1.152), que es también el host del repositorio de
backup.** Apagar la VM no afecta a las copias; apagar el hipervisor se lleva las dos cosas por
delante. Es un punto único de fallo conocido y pendiente de resolver: mientras siga así, las
copias no protegen de que ese equipo falle.

## 5 · Estado verificado en la última preparación de apagado

`2026-09-13 16:27 UTC` — preflight `rc=0`:

```
jobs running/claimed/pending   0        idle in transaction    0
batallas running               0        prepared (2PC)         0
builds en curso                0        cola Redis DBSIZE      0
contenedores del proyecto     12        ajenos                 0
último backup con BD    b56d1f94  2026-09-13T04:15:01Z (hace 12,2 h)
```
