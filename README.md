# S9 AI Arena — monorepo

**Motor 2D modular y determinista de combate para torneos de bots de IA**, con plataforma
web, ejecución aislada de código no confiable, visor, replays, torneos, observabilidad y
streaming. Monorepo TypeScript/Node.

> **Estado (2026-07-18):** el **núcleo de la v2 está DESPLEGADO** en VM108 (perfil `nucleo`,
> 7 servicios `healthy`) y sirviendo en **`https://s9arena.seccionnueve.duckdns.org`** tras el
> proxy de VM104. La **v1 se retiró** de la ruta activa. La fuente de verdad operativa es
> **[docs/ESTADO_ACTUAL.md](docs/ESTADO_ACTUAL.md)**; para operar la VM,
> **[docs/OPERACION_VM108.md](docs/OPERACION_VM108.md)**.
>
> Las doce entregas del dosier (**E1–E12**) están implementadas e integradas en `main` (PR #38 y
> siguientes ya mergeadas). El **núcleo v2 está desplegado en VM108** y el **Hito A** (batalla E2E
> real con runners containerizados + replay verificado bit a bit) está validado; ver
> `docs/ESTADO_ACTUAL.md` para el estado operativo vigente. Detalle histórico de
> implementación en **[docs/estado-proyecto.md](docs/estado-proyecto.md)** (verificado 2026-07-16,
> anterior al despliegue).

## ⚠️ Hay dos versiones en este repo — no confundirlas

| | **v1 — prototipo (legacy)** | **v2 — plataforma (producto real)** |
|---|---|---|
| Qué es | Demo de tanques de 4 contenedores | Toda la plataforma E1–E12 |
| Código | `apps/arena-server`, `apps/arena-viewer` (Phaser 3), `bots/bot-red`, `bots/bot-blue` | `apps/api`, `apps/arena-engine`, `apps/web` (Phaser 4), `apps/bot-manager`, `apps/map-service`, `apps/replay-service`, `apps/tournament-worker`, `apps/streamer`, `packages/*`, `sdks/*`, `infrastructure/` |
| Despliegue | `docker-compose.demo.yml` (raíz) — demo/legado, **ya NO desplegado** (retirado de VM108 el 2026-07-17) | `infrastructure/docker-compose.yml` — **stack OFICIAL, DESPLEGADO en VM108** (perfil `nucleo`, 7 servicios) |
| Estado | **Retirada** — despliegue movido a `/opt/_v1-prototipo-backup-20260717` en VM108 | Canónico y en producción |

La v1 se conserva en el repo solo por historia. **El compose oficial de despliegue es
`infrastructure/docker-compose.yml`**; el de la raíz es legacy y no debe usarse en producción.
Estado real y operación: [docs/ESTADO_ACTUAL.md](docs/ESTADO_ACTUAL.md),
[docs/MIGRACION_V2.md](docs/MIGRACION_V2.md), [docs/DESPLIEGUE_DOMINIO.md](docs/DESPLIEGUE_DOMINIO.md).

## Arquitectura (v2, resumen)

- **Contratos (E1):** `packages/protocol`, `packages/module-catalog`, `packages/map-schema`, `apps/api/openapi.yaml` — esquemas versionados de los que dependen todos los servicios.
- **Motor (E2):** `apps/arena-engine` — bucle de tick fijo a 30 Hz, determinista (RNG con semilla, física Rapier2D fijada por checksum), snapshots y replays verificables.
- **Módulos y mapas (E3–E4):** catálogo de módulos como datos + validador de loadouts; pipeline de mapas Tiled, validador, servicio y generador procedural.
- **Protocolo y SDKs (E5):** servidor WebSocket motor↔bot, SDK Python y JavaScript, bots de ejemplo.
- **Seguridad (E6):** `apps/bot-manager`, `runtimes/` — pipeline de build, análisis, firma y sandbox Docker para código no confiable.
- **Plataforma (E7):** `apps/api` (Express + Knex/PostgreSQL, Argon2id, RBAC desde OpenAPI), `apps/web` (React + Vite, visor Phaser 4, editor de loadouts).
- **Visor y replays (E8):** canal de espectador, reproductor con velocidad variable, estadísticas.
- **Torneos (E9):** `apps/tournament-worker` — cola durable en PostgreSQL, 6 formatos, rating Elo.
- **DevOps (E10):** `infrastructure/` — Compose de 12 servicios, redes internas, secretos, observabilidad (Prometheus/Grafana/Loki), backups.
- **Streaming (E11):** `apps/streamer` — captura headless a RTMPS sobre la vista `/broadcast`.
- **QA (E12):** `tests/e2e`, `acceptance/`, `docs/gamedays` — suites de aceptación y caos.

## Arranque rápido (desarrollo local, sin Docker)

```bash
npm install

# Contratos (E1)
node packages/protocol/scripts/validate.js
node packages/module-catalog/scripts/validate-catalog.js

# Suite completa (motor, plataforma con PostgreSQL embebido, seguridad, torneos…)
npm test

# Lint de determinismo del motor
npm run lint
```

> Requiere **Node ≥ 22.15** (fijado en `package.json` `engines` y en la CI). La
> rama zstd de replays usa `zstdCompressSync`, ausente en Node 20: **Node 20 NO
> está soportado** — la suite falla en `replay-golden.test.ts`. Comprobación
> rápida antes de build/despliegue: `npm run check:node`.

## Documentación

| Documento | Para qué |
|---|---|
| **[docs/estado-proyecto.md](docs/estado-proyecto.md)** | Estado real por entrega, verificado con ejecuciones. **Fuente de verdad.** |
| **[docs/auditoria-consolidada-2026-07-16.md](docs/auditoria-consolidada-2026-07-16.md)** | Auditoría consolidada: errores, correcciones técnicas y mejoras. |
| **[docs/Dosier_tareas_S9_AI_Arena.md](docs/Dosier_tareas_S9_AI_Arena.md)** | Dosier de tareas E1–E12 + **Ronda 2** (remediación, integración, evolución y retirada de v1). |
| **[docs/decisiones/](docs/decisiones/)** | ADRs (decisiones fundacionales y por equipo). |
| **[docs/despliegue.md](docs/despliegue.md)** · **[docs/recuperacion.md](docs/recuperacion.md)** | Runbooks de despliegue y recuperación. |
| **[docs/historial/](docs/historial/)** | Archivo: informes de entrega E1–E12, `FUSION.md` y `ROADMAP.md`. Evidencia histórica (no usar como estado operativo). |

## Estado de despliegue

El **núcleo v2 está desplegado en VM108** (dominio `s9arena.seccionnueve.duckdns.org`, vía el
Nginx de VM104); la v1 (prototipo) fue retirada de la ruta activa. El **Hito A** —batalla E2E
real con runners containerizados y replay verificado bit a bit— está **validado**. La ejecución
real de batallas desde la UI/torneos sigue **gateada** (R6.2/R9-A) y no está activada.

> La fuente de verdad operativa (VMs, dominios, gates, PRs integradas) es
> **[docs/ESTADO_ACTUAL.md](docs/ESTADO_ACTUAL.md)**; este bloque es solo un resumen.
