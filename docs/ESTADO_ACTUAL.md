# Estado actual — S9 AI Arena (fuente de verdad operativa)

> **Fecha de revisión:** 2026-07-18
> **Revisado por:** auditoría real de VM108 + VM104 (SSH) y del repositorio.
> **Commit de repo revisado:** `origin/main` = `5cade21` (merge PR #32, integración Ronda 2/3).
> **Commit desplegado en VM108:** `a5651ff` (rama `ronda2/entrypoints-servicios`).
>
> Este documento **manda** sobre cualquier otro cuando haya contradicción sobre el estado
> desplegado. Documentos con estado antiguo (`README.md` cabecera 2026-07-16,
> `docs/estado-proyecto.md`, `docs/despliegue.md`) quedan matizados aquí.

---

## 1. Resumen ejecutivo

- **La v1 (prototipo de tanques) YA NO está desplegada** como stack principal. Se retiró de
  VM108 el 2026-07-17 y su código de despliegue se movió a `/opt/_v1-prototipo-backup-20260717`.
- **La v2 está desplegada en su perfil `nucleo`** (7 servicios) y **funciona**: los 7
  contenedores están `healthy`, con 0 reinicios, sirviendo la SPA "S9 AI Arena".
- El acceso **LAN** (`192.168.1.208:8080`) y **Tailscale** (`100.81.2.105:8080`) responden 200.
- El **dominio público correcto es `s9arena.seccionnueve.duckdns.org`** y su vhost en VM104
  está configurado, válido y proxeando a VM108 (verificado por loopback en VM104).
- **`arena.seccionnueve.duckdns.org` NO es este proyecto** (apunta a VM107, otro proyecto). No tocar.
- Existe un **snapshot Proxmox de rollback**: `pre-v2-20260717`.

> ⚠️ **Corrección de una confusión frecuente:** afirmaciones como *"solo está desplegada la v1"*
> o *"la v2 aún no está desplegada de extremo a extremo"* (README/estado-proyecto de 2026-07-16)
> **ya no son ciertas**. Lo desplegado hoy es el **núcleo de la v2**.

---

## 2. VM108 — `s9-arena`

| Dato | Valor |
|---|---|
| VMID / hostname | 108 / `s9-arena` |
| IP LAN | `192.168.1.208` |
| IP Tailscale | `100.81.2.105` |
| SO | Debian 12 Bookworm |
| Docker CE | 29.6.1 |
| Docker Compose plugin | v5.3.0 |
| RAM | 15 GiB (≈1.2 GiB en uso) |
| Ruta del proyecto | `/opt/s9-ai-arena` (dueño usuario `s9arena`) |
| Backup v1 | `/opt/_v1-prototipo-backup-20260717` |
| Onboot | `1` (arranca sola) |

### 2.1 Estado Git en la VM (⚠️ discrepancia con el repo)

- Rama desplegada: **`ronda2/entrypoints-servicios`**, commit **`a5651ff`**.
- **No hay cambios locales** sin commitear (working tree limpio).
- `a5651ff` es **ancestro de `origin/main`** (todos sus commits ya están en main), pero
  `origin/main` está **52 commits por delante** del commit desplegado.
- **Implicación:** VM108 corre una foto anterior a la integración Ronda 2/3 (PR #32) y anterior
  a R-DEPLOY (PR #38, pendiente). El núcleo funciona, pero el despliegue **no refleja `main`**.
  Actualizar VM108 a `main` es un paso deliberado con backup previo (ver `OPERACION_VM108.md`).

### 2.2 Qué está desplegado (perfil `nucleo`)

Proyecto Compose: **`infrastructure`**, fichero **`/opt/s9-ai-arena/infrastructure/docker-compose.yml`**.

| Servicio (contenedor) | Imagen | Estado | Puertos |
|---|---|---|---|
| `infrastructure-gateway-1` | `s9arena/gateway:local` | Up, healthy | `0.0.0.0:8080->80`, `0.0.0.0:8443->443` |
| `infrastructure-web-1` | `s9arena/web:local` | Up, healthy | interno (80, 3000) |
| `infrastructure-api-1` | `s9arena/api:local` | Up, healthy | interno |
| `infrastructure-tournament-worker-1` | `s9arena/tournament-worker:local` | Up, healthy | interno (WS espectador :8081) |
| `infrastructure-replay-service-1` | `s9arena/replay-service:local` | Up, healthy | interno |
| `infrastructure-postgres-1` | `postgres:16-alpine` | Up, healthy | interno (5432) |
| `infrastructure-queue-1` | `redis:7-alpine` | Up, healthy | interno (6379) |

- **Único servicio expuesto al exterior de la VM: el `gateway`** (8080 → 80, 8443 → 443).
- Imágenes de aplicación: `s9arena/*:local`, **construidas en la propia VM108** (no vienen de GHCR).
- **Política de reinicio:** `unless-stopped` en los 7 → sobreviven a reinicio de la VM.
- **No hay unidad systemd**: el stack se levantó **manualmente** (`docker compose --profile nucleo up -d`
  ejecutado como `s9arena`). `.env` **no** fija `COMPOSE_PROFILES`.

### 2.3 Qué NO está desplegado (definido en el Compose pero fuera de `nucleo`)

- `arena-engine` — **no es un servicio de red**: el motor se instancia por batalla dentro del
  `tournament-worker`. Su presencia en el Compose es para perfiles `development`/`production`.
- `bot-manager`, `map-service` — perfiles `development`/`production`; fuera del núcleo.
- `streamer` (perfil `streaming`), `bot-runtime-template` (perfil `bots`), `backup`
  (`production`), toda la observabilidad (`prometheus`, `grafana`, `loki`, `promtail`,
  `alertmanager`, `cadvisor`, `node-exporter`, `postgres-exporter` — perfil `observability`).
- `bot-build-worker` — **no existe todavía en el Compose de `main`**; sí está en la rama de
  R-DEPLOY (PR #38, pendiente de merge).

### 2.4 Enrutado interno del gateway (nginx `default.conf`)

| Ruta | Destino |
|---|---|
| `/healthz` | responde `ok` local (no proxeado) |
| `/api/v1/` | → `api` |
| `/ws/` | → `tournament-worker` (WS espectador) |
| `/replays/` | → `replay-service` |
| `/grafana/` | → grafana (solo si perfil observability) |
| `/` | → `web` (SPA) |

> Nota: **no existe `/api/health`**; una petición a esa ruta cae al fallback del SPA (200 con
> HTML). El health real del gateway es `/healthz`. El health de la API vive bajo `/api/v1/`.

### 2.5 Redes y volúmenes (no borrar)

- Redes del proyecto: `infrastructure_public`, `infrastructure_platform`, `infrastructure_data`.
- Red suelta `arena-escape`: **residuo de las pruebas de sandbox de R6.1**; inofensiva.
- Volúmenes con datos: `infrastructure_postgres_data`, `infrastructure_queue_data`,
  `infrastructure_arena_replays` (+ 3 volúmenes anónimos). **Nunca `docker compose down -v`.**

---

## 3. VM104 — proxy inverso (Nginx)

| Dato | Valor |
|---|---|
| IP LAN | `192.168.1.204` |
| Rol | Nginx reverse proxy, termina TLS público |
| Certificado | wildcard `*.seccionnueve.duckdns.org` (`/etc/letsencrypt/live/seccionnueve.duckdns.org/`) |

- vhost **`s9arena.seccionnueve.duckdns.org.conf`** (habilitado): 80 → 301 https;
  443 → `proxy_pass http://192.168.1.208:8080`, con `location /ws/` para WebSocket y
  `client_max_body_size 64m`. Copia previa: `/root/s9arena-vhost-v1-backup-20260717.conf`.
- `nginx -t` → **OK**. `curl` por loopback (SNI) a `s9arena…/` y `/healthz` → **200**;
  `/ws/` → **426** (Upgrade Required, correcto).
- vhost **`arena.seccionnueve.duckdns.org.conf`**: proyecto DISTINTO → `proxy_pass
  http://192.168.1.207:8080` (VM107). **No modificar.**
- Ambos nombres resuelven al mismo IP público DuckDNS (`207.188.136.103`); se separan por
  `server_name`. No hay conflicto de `server_name`.

---

## 4. Snapshot de rollback

| Dato | Valor |
|---|---|
| Nombre | `pre-v2-20260717` |
| Fecha | 2026-07-17 09:58:36 |
| Descripción | "Antes de redespliegue v2 limpio (ronda2/r-p0-bloqueantes)" |
| Tipo | Snapshot de Proxmox de VM108 (host `192.168.1.152`) |
| Revertir | `qm rollback 108 pre-v2-20260717` desde el host Proxmox |
| Riesgo | Vuelve al estado v1 previo al redespliegue: **se pierde todo lo hecho en VM108 desde el 2026-07-17** (datos de PostgreSQL/replays incluidos). Usar solo como último recurso. |

---

## 5. Acceso — resultados de la prueba (2026-07-18)

| Vía | URL | `/` | `/healthz` |
|---|---|---|---|
| LAN | `http://192.168.1.208:8080` | 200 | 200 |
| Tailscale | `http://100.81.2.105:8080` | 200 | 200 |
| Dominio (loopback VM104) | `https://s9arena.seccionnueve.duckdns.org` | 200 | 200 |
| WebSocket | `…/ws/` | 426 (upgrade) | — |

> El acceso público **no se pudo probar desde fuera de la LAN** en esta auditoría (el host de
> auditoría no tiene ruta al IP público — sin hairpin NAT). Cadena Internet→VM104→VM108
> verificada por tramos. Pendiente: una prueba real desde Internet/navegador (ver checklist).

---

## 6. Diferencias repo ↔ despliegue

1. **Rama/commit:** VM108 en `a5651ff` (`ronda2/entrypoints-servicios`); `main` va 52 commits
   por delante. R-DEPLOY (entrypoints `bot-manager`/`map-service`, `bot-build-worker`,
   docker-proxy systemd) **no está en `main`**: vive en `integration/ronda2-ronda3` (PR #38 OPEN).
2. **Compose:** VM108 usa `infrastructure/docker-compose.yml` (v2). El `docker-compose.yml` de
   la **raíz es la v1 legacy** y **no** se usa en producción (ver `DESPLIEGUE_DOMINIO.md` y
   `MIGRACION_V2.md`).
3. **Dominio en docs:** `docs/despliegue.md` todavía dice `arena.seccionnueve.duckdns.org`
   (INCORRECTO). El correcto es `s9arena.…`.
4. **Imágenes:** el Compose sugiere GHCR, pero VM108 corre `s9arena/*:local` construidas en la VM.

---

## 7. Próximos pasos bloqueantes

1. **Merge de PR #38** (integración Ronda 2/3 + R-DEPLOY) a `main` — con CI en verde. Hoy la
   CI de esa rama está `UNSTABLE`. Hasta entonces `main` no tiene los entrypoints ni el worker.
2. **Decidir si VM108 se actualiza a `main`** tras el merge (con backup + snapshot nuevos).
   Hoy el despliegue va por detrás.
3. **Prueba real de extremo a extremo** desde Internet y desde navegador (visor + WebSocket +
   una batalla real). Nunca se ha lanzado una batalla contra el stack desplegado.
4. **R1.7/R6.2**: containerizar el `agentResolver` para poder desplegar `bot-manager`; hasta
   entonces el pipeline de bots rechaza por diseño (fail-closed).

Ver la lista ejecutable en [`CHECKLIST_VALIDACION_V2.md`](CHECKLIST_VALIDACION_V2.md).
