# Migración v1 → v2 (runbook)

> Contexto y estado real: ver [`ESTADO_ACTUAL.md`](ESTADO_ACTUAL.md).
> Fecha de este documento: 2026-07-18.

## 1. De dónde veníamos

Hasta el 2026-07-17, en VM108 estaba desplegado el **prototipo v1**: los 4 contenedores del
`docker-compose.yml` de la **raíz** del repo:

- `arena-server` (WebSocket del juego, puerto 8081)
- `arena-viewer` (visor Phaser 3, nginx en puerto 3000)
- `bot-red`, `bot-blue` (dos bots de ejemplo)

Código de la v1: `apps/arena-server`, `apps/arena-viewer`, `bots/bot-red`, `bots/bot-blue`.
Era una demo de tanques, **no** la plataforma real.

## 2. Qué es la v2

La plataforma completa (E1–E12): `apps/api`, `apps/arena-engine`, `apps/web` (Phaser 4),
`apps/bot-manager`, `apps/map-service`, `apps/replay-service`, `apps/tournament-worker`,
`apps/streamer`, más `packages/*`, `sdks/*` e `infrastructure/`. Su despliegue vive en
**`infrastructure/docker-compose.yml`** con perfiles (`nucleo`, `development`, `production`,
`observability`, `streaming`, `bots`).

## 3. Qué se desplegó (2026-07-17)

- Se **retiró la v1** de la ruta activa: su despliegue se movió a
  `/opt/_v1-prototipo-backup-20260717` en VM108.
- Se levantó la v2 en **perfil `nucleo`** (7 servicios): `gateway`, `web`, `api`,
  `tournament-worker`, `replay-service`, `postgres`, `queue`. Todos `healthy`.
- El vhost de VM104 se reapuntó de la v1 (arena-viewer:3000 / arena-server:8081) al **gateway
  de la v2** (`192.168.1.208:8080`). Copia previa en `/root/s9arena-vhost-v1-backup-20260717.conf`.

> **Por qué "desplegar la v2" fue en realidad terminar E6/E7/E9:** el Compose de E10 se escribió
> sin Docker y nunca se había ejecutado; faltaban entrypoints de servicio de varias apps. Eso se
> resolvió en la rama `ronda2/entrypoints-servicios` (la que corre hoy VM108) y en R-DEPLOY.

## 4. Snapshot previo

Antes del redespliegue se hizo el snapshot Proxmox **`pre-v2-20260717`** (2026-07-17 09:58:36,
"Antes de redespliegue v2 limpio"). Es el punto de rollback de VM (ver `OPERACION_VM108.md` §11).

## 5. Qué falta para completar la v2

1. **Merge de PR #38** (`integration/ronda2-ronda3` → `main`) con CI verde: trae la integración
   Ronda 2/3 **y** R-DEPLOY (entrypoints reales de `bot-manager`/`map-service`, `bot-build-worker`
   en el Compose, unidad systemd `s9-docker-proxy`, TOTP con reloj fake, `check-node`≥22.15,
   dominio `s9arena`, aclaración del compose legacy). Hoy la CI de esa rama está `UNSTABLE`.
2. **Actualizar VM108 a `main`** tras el merge (hoy corre `a5651ff`, 52 commits por detrás).
3. **Desplegar los servicios que faltan del núcleo ampliado** cuando toque: `bot-manager`
   (bloqueado hasta R1.7/R6.2 — containerizar `agentResolver`), `map-service`, observabilidad.
4. **Prueba real de extremo a extremo**: batalla real contra el stack desplegado, visor en
   navegador y WebSocket desde Internet (nunca ejecutada contra producción).

## 6. Cómo validar la v2

Ver la lista ejecutable en [`CHECKLIST_VALIDACION_V2.md`](CHECKLIST_VALIDACION_V2.md). Mínimo:
- 7 servicios `healthy` (`docker compose ps`).
- `GET /healthz` = `ok`, `GET /` = 200 en LAN, Tailscale y dominio.
- `GET /api/v1/…` responde (no el fallback del SPA).
- `/ws/` hace upgrade (426 sin cabeceras; 101 con handshake real).

## 7. Cómo retirar definitivamente los restos de v1

> Hacer **solo** cuando la v2 esté validada de extremo a extremo y con backup hecho.

- El **código** de la v1 (`apps/arena-server`, `apps/arena-viewer`, `bots/`) puede permanecer en
  el repo por historia, pero deja de ser referencia operativa.
- El `docker-compose.yml` de la **raíz** (v1) está marcado como legacy en cabecera; **no moverlo
  de sitio** mientras el CI lo escanee como referencia (`scripts/scan-compose.ts`,
  `apps/bot-manager/tests/compose-scan.test.ts`, `acceptance/criteria.mjs`). La decisión de
  moverlo a `legacy/` debe ir acompañada de actualizar esas rutas en el mismo cambio.
- En VM108, `/opt/_v1-prototipo-backup-20260717` puede archivarse/comprimirse (no borrar sin backup).

## 8. Plan de rollback

| Escenario | Acción |
|---|---|
| El nuevo despliegue de la v2 falla al arrancar | `git checkout a5651ff` + `docker compose --profile nucleo up -d --build` (volver al commit que hoy funciona) |
| Corrupción/estado irrecuperable de la VM | `qm rollback 108 pre-v2-20260717` desde el host Proxmox (pierde datos desde 2026-07-17) |
| El vhost de VM104 queda mal | restaurar `/root/s9arena-vhost-v1-backup-20260717.conf` y `nginx -t && systemctl reload nginx` |
