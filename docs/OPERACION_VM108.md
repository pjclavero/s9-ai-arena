# Operación de VM108 — S9 AI Arena (runbook)

> Estado real y contexto: ver [`ESTADO_ACTUAL.md`](ESTADO_ACTUAL.md).
> **Regla de oro:** los comandos de Docker/Compose se ejecutan **como el usuario `s9arena`**,
> nunca como `root` (el PostgreSQL embebido se niega a correr como root, y `s9arena` es el
> dueño de `/opt/s9-ai-arena`).

## 0. Datos rápidos

| | |
|---|---|
| Host | `s9-arena` — LAN `192.168.1.208` — Tailscale `100.81.2.105` |
| Ruta | `/opt/s9-ai-arena` |
| Compose oficial | `infrastructure/docker-compose.yml` |
| Perfil desplegado | `nucleo` (7 servicios) |
| Proyecto Compose | `infrastructure` |
| Usuario | `s9arena` |

Entrar como `s9arena`:
```bash
ssh root@192.168.1.208        # o el mecanismo habitual
su - s9arena
cd /opt/s9-ai-arena/infrastructure
```

## 1. Ver estado

```bash
cd /opt/s9-ai-arena/infrastructure
docker compose ps                       # servicios del proyecto
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker compose --profile nucleo config --services   # servicios del perfil
```

## 2. Arrancar (perfil núcleo)

```bash
cd /opt/s9-ai-arena/infrastructure
docker compose --profile nucleo up -d
```
No fijamos `COMPOSE_PROFILES` en `.env`: **hay que pasar `--profile nucleo` explícitamente**.
Los contenedores tienen `restart: unless-stopped`, así que vuelven solos tras un reinicio de la VM.

## 3. Parar SOLO S9 AI Arena (sin tocar otros proyectos)

```bash
cd /opt/s9-ai-arena/infrastructure
docker compose --profile nucleo stop      # detiene sin borrar
# o para bajar los contenedores (mantiene volúmenes):
docker compose --profile nucleo down
```
> ⛔ **NUNCA** `docker compose down -v` (borra volúmenes: PostgreSQL, replays, cola).
> ⛔ **NUNCA** `docker system prune` (afecta a todo el host).

## 4. Ver logs

```bash
docker compose logs -f --tail=100                 # todos
docker compose logs -f gateway                    # uno
docker compose logs --since=30m tournament-worker # ventana
```

## 5. Probar health

```bash
# En la propia VM:
curl -s http://127.0.0.1:8080/healthz            # -> ok
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/   # -> 200
# API real (bajo /api/v1/, NO /api/health):
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/v1/
```

## 6. Probar el visor / panel

- Abrir en navegador `http://192.168.1.208:8080/` (LAN) → SPA "S9 AI Arena".
- Debe cargar `/assets/index-*.js` y renderizar el panel.

## 7. Probar Tailscale

```bash
tailscale status | grep s9-arena
curl -s -o /dev/null -w '%{http_code}\n' http://100.81.2.105:8080/healthz   # -> 200
```

## 8. Probar el dominio

Desde VM104 (proxy) por loopback, sin depender del hairpin NAT:
```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  --resolve s9arena.seccionnueve.duckdns.org:443:127.0.0.1 \
  https://s9arena.seccionnueve.duckdns.org/healthz          # -> 200
```
Desde Internet (equipo externo): `https://s9arena.seccionnueve.duckdns.org/`.

## 9. Actualizar desde Git (paso deliberado, con backup)

> Hoy VM108 corre `a5651ff` (rama `ronda2/entrypoints-servicios`), por detrás de `main`.
> Actualizar es una decisión consciente. **Antes**: sección 10 (backup) + snapshot nuevo.

```bash
cd /opt/s9-ai-arena
git -c safe.directory=/opt/s9-ai-arena fetch origin
git -c safe.directory=/opt/s9-ai-arena checkout main
git -c safe.directory=/opt/s9-ai-arena pull --ff-only origin main
cd infrastructure
docker compose --profile nucleo build          # reconstruye imágenes locales
docker compose --profile nucleo up -d
docker compose ps                              # verificar healthy
```

## 10. Backup antes de un despliegue

```bash
# 1) Snapshot Proxmox NUEVO (desde el host 192.168.1.152):
qm snapshot 108 pre-deploy-$(date +%Y%m%d) --description "antes de actualizar a main"

# 2) Dump de PostgreSQL (dentro de la VM, como s9arena):
docker exec infrastructure-postgres-1 pg_dumpall -U postgres > ~/pg-backup-$(date +%Y%m%d).sql

# 3) Copia del .env y secretos (NO publicar):
cp -a /opt/s9-ai-arena/infrastructure/.env ~/env-backup-$(date +%Y%m%d)
```

## 11. Volver al snapshot (rollback)

Desde el host Proxmox `192.168.1.152`:
```bash
qm rollback 108 pre-v2-20260717     # vuelve al estado v1 previo al redespliegue
```
> ⚠️ Se pierde TODO lo hecho en VM108 desde 2026-07-17 (datos incluidos). Último recurso.
> Preferir siempre `git checkout <commit>` + rebuild antes que un rollback de VM.

## 11 bis. Volumen `arena_replays`: propiedad y montajes (B7)

Incidencia real (2026-07-17 → 2026-07-27): `arena_replays` se creó `root:root`,
el `replay-service` corre como `node` (uid 1000) y **cada ingesta moría con
`EACCES: permission denied, open '/data/replays/...'`**. El contenedor seguía
`healthy` (su `/healthz` no toca el disco) y el volumen llevaba diez días vacío:
el servicio **nunca** había guardado un replay. Se desbloqueó a mano con
`chown 1000:1000` sobre el punto de montaje — un parche que se pierde si el
volumen se recrea.

Desde B7 no hace falta ninguna intervención manual:

1. Las imágenes que montan el volumen **traen `/data/replays` ya creado y con la
   propiedad correcta** (uid 1000). Docker copia esa propiedad al volumen la
   primera vez que se monta vacío, así que un despliegue desde cero nace bien
   sea cual sea el primer contenedor en montarlo.
2. La imagen genérica de servicios Node arranca por
   `infrastructure/docker/node-service/entrypoint.sh`, que **ajusta la propiedad
   de los directorios listados en `ARENA_DATA_DIRS` y baja a `node` con
   `su-exec`** antes de ejecutar el servicio. Nada de `privileged`,
   `docker.sock` ni `network_mode: host`.

   El paso privilegiado está acotado, y conviene saber **exactamente** qué
   acepta, porque corre como uid 0 y lo gobierna una variable de entorno. Una
   ruta se admite solo si cumple **todo**: cuelga de `/data/` con al menos un
   componente propio (nunca `/data` a secas ni `/dataOtraCosa`); todos sus
   componentes son reales (ni vacíos por `//`, ni `.`, ni `..`); **ningún
   componente del camino es un enlace simbólico** — el guard de prefijo por sí
   solo no impide salir de `/data`, porque `chown` sigue los enlaces; no
   contiene metacaracteres de patrón (`*`, `?`, `[`); y reconstruida componente
   a componente es idéntica a la recibida (sin barras finales ni formas
   equivalentes). Además: **la lista se valida entera antes de tocar el disco**
   (una entrada inválida al final no deja chowneadas las anteriores), la lista
   no se expande como patrón (`set -f`), y el `chown` no es recursivo y lleva
   `-h` (no sigue enlaces). Cualquier otra cosa **aborta el arranque**; nunca se
   ignora en silencio.
3. `replay-service` y `tournament-worker` **comprueban al arrancar** que su
   directorio de datos es escribible de verdad (escriben y borran un fichero) y,
   si no lo es, **se niegan a arrancar** con un diagnóstico accionable
   (`dir`, `uid`, motivo y remedio) en vez de perder replays en silencio. Un
   contenedor en bucle de reinicio es visible; un `healthy` que traga EACCES, no.

Montajes del volumen y por qué (verificado contra el código, no supuesto):

| Servicio | Modo | Justificación |
|---|---|---|
| `replay-service` | rw | `ingestReplay`/`loadStored` (`apps/replay-service/src/store.ts`). |
| `tournament-worker` | rw | `finishBattle` → `ingestReplay(replaysDir, …)` y guarda la ruta en `battles.replay_ref` (`apps/tournament-worker/src/battle-runner.ts`). **Añadido en B7: antes no lo montaba**, así que escribía en el sistema de ficheros efímero del contenedor y nadie más veía ese `replay_ref`. |
| `api` | **ro** | `getReplay`/`verifyReplay` hacen `readFile(battle.replay_ref)` (`apps/api/src/routes/battles.ts`). **Añadido en B7**: sin él, la descarga y la verificación de replays de torneo daban siempre 404 «Replay no disponible». La API no escribe replays: su ingesta va por HTTP al `replay-service`. |
| `streamer` | rw | modo grabación E11.M escribe clips en `/data/replays/video`. **B13**: protegido con el mismo mecanismo (ver abajo). |
| `backup` | ro | copia de seguridad. |
| `arena-engine` | — | **B13: montaje RETIRADO** (junto con `arena_maps` y `arena_logs`). Ningún fichero de `apps/arena-engine` toca `/data`. |

### B13 · lo que quedaba suelto

1. **`streamer`** (escribe vídeo en `/data/replays/video` en modo `record`):
   comparte ahora el **mismo** entrypoint que la imagen genérica
   (`infrastructure/docker/node-service/entrypoint.sh`, parametrizado con
   `ARENA_SERVICE_USER=streamer`) y declara **`ARENA_DATA_DIRS=/data/replays`**,
   además de hacer el preflight de escritura al arrancar. Antes podía repetir el
   fallo de VM108 con el agravante de que quien escribe es FFmpeg: moría en bucle
   mientras `/healthz` seguía respondiendo 200.
   **Por qué `/data/replays` y no `/data/replays/video`**: la invariante que B7
   escribió en la cabecera de `entrypoint.sh` prohíbe rutas de más de un
   componente dentro de un volumen compartido (el componente intermedio sería
   escribible por otro contenedor durante la ventana entre validar y hacer
   `chown`, y `chown -h` no cubre los intermedios). B13 **cierra** esa ventana en
   vez de ensancharla: el entrypoint ahora **rechaza** las rutas profundas y el
   subdirectorio `video/` lo crea el propio servicio, sin privilegios, en su
   preflight. Funciona porque `streamer` es uid:gid `1000:1000` igual que `node`,
   y el build de la imagen lo comprueba con `stat`.
2. **`map-service`**: verificado que **no escribe** en `/data/maps` — su almacén
   es en memoria (`apps/map-service/src/service.ts`). **No** se le añade
   preflight; hay un centinela en `infrastructure/tests/b13-data-volumes.test.ts`
   que se pone rojo el día que empiece a escribir. Su montaje rw de `arena_maps`
   sigue ahí y **hoy no lo usa nadie**: por el mismo criterio con el que se
   retiraron los tres de `arena-engine`, sobra — **no se retira en B13** porque
   `map-service` es el dueño declarado de ese volumen y su almacenamiento real
   está pendiente (E10); queda anotado para quien lo implemente. Aviso sobre el
   centinela: solo ve rutas literales entre comillas, así que una escritura
   construida desde una variable de entorno le pasaría inadvertida.
3. **`arena-engine`**: montajes retirados (ver arriba). `arena_logs` queda
   declarado pero **sin montar en ningún servicio**: los logs salen por stdout.
4. **CI**: `streamer`, `backup` y `bot-runtime-python` no las construía ningún
   job, y `web` se construía con un Dockerfile distinto al del despliegue. La
   matriz de `build-images` ya cubre las once imágenes del Compose y un test
   (`infrastructure/tests/ci-image-matrix.test.ts`) impide que vuelva a
   descuadrarse.

## 12. Qué NO hacer

- ❌ Ejecutar Docker/Compose como `root`.
- ❌ `docker compose down -v` / borrar volúmenes.
- ❌ `docker system prune` (global).
- ❌ Tocar otros proyectos del host o de VM104.
- ❌ Abrir puertos nuevos en el router.
- ❌ Modificar el vhost `arena.seccionnueve.duckdns.org` (es otro proyecto, VM107).
- ❌ Reiniciar la VM sin avisar.
- ❌ Usar el `docker-compose.demo.yml` de la RAÍZ (es v1 legacy) para producción.
