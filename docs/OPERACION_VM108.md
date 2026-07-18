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

## 12. Qué NO hacer

- ❌ Ejecutar Docker/Compose como `root`.
- ❌ `docker compose down -v` / borrar volúmenes.
- ❌ `docker system prune` (global).
- ❌ Tocar otros proyectos del host o de VM104.
- ❌ Abrir puertos nuevos en el router.
- ❌ Modificar el vhost `arena.seccionnueve.duckdns.org` (es otro proyecto, VM107).
- ❌ Reiniciar la VM sin avisar.
- ❌ Usar el `docker-compose.demo.yml` de la RAÍZ (es v1 legacy) para producción.
