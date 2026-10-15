# S9 AI Arena

Plataforma de combate entre bots de IA. Cada jugador programa su vehículo en Python o JavaScript, lo
equipa con módulos (chasis, armas, sensores, radio…) y lo enfrenta a otros en un motor de
simulación 2D determinista. Las batallas se ven en directo o se repiten después como replay, y los
torneos generan clasificaciones Elo.

> **Estado actual (verificado el 2026-10-15 sobre `27f70bb`): NO es funcional de extremo a
> extremo.** El motor, los torneos, el catálogo de equipamiento y gran parte de la plataforma
> existen y están probados. Pero hoy ningún bot de usuario puede llegar a `published`, y las
> batallas las juega un bot de relleno en lugar del código del usuario.
> Detalle: [docs/roadmap/current-status.md](docs/roadmap/current-status.md).

## Qué es

S9 AI Arena es un monorepo TypeScript/Node con todo lo necesario para organizar competiciones de
bots:

- una web para gestionar cuentas, bots, equipamiento, equipos, mapas, batallas y torneos;
- un pipeline que valida y aísla el código no confiable de cada bot;
- un motor de simulación reproducible bit a bit;
- visor en directo, replays, clasificaciones y estadísticas;
- un despliegue Docker Compose de 12 servicios, con copias de seguridad.

Resuelve un problema concreto: poder enfrentar programas escritos por personas distintas con
reglas iguales, resultados verificables y sin que el código de un jugador pueda dañar la
plataforma ni a otros jugadores.

Más contexto: [docs/overview/project.md](docs/overview/project.md).

## Estado actual

| Área | Estado |
|---|---|
| Motor de simulación (física, armas, sensores, modos, determinismo, replay) | **Funciona** |
| Cuentas, login, roles | **Funciona**, con huecos (sin cambio de contraseña ni recuperación por correo) |
| Bots: crear, versionar código, configurar loadout | **Funciona** |
| Build y publicación de bots | **Bloqueado**: el sandbox de validación no está conectado ([TD-001](docs/roadmap/technical-debt.md#td-001)) |
| Batallas | **Parcial**: la web falla al crearlas ([TD-003](docs/roadmap/technical-debt.md#td-003)) y se ejecutan con un bot de relleno ([TD-002](docs/roadmap/technical-debt.md#td-002)) |
| Torneos y ranking Elo | **Parcial**: funcionan con el bot de relleno; la clasificación pública sale vacía ([TD-029](docs/roadmap/technical-debt.md#td-029)) |
| Mapas | **Parcial**: importar, generar y publicar sí; el editor visual no guarda ([TD-010](docs/roadmap/technical-debt.md#td-010)) |
| Visor en directo y reproductor de replays | **Roto en navegador** ([TD-009](docs/roadmap/technical-debt.md#td-009)) |
| Operación (backup, restore, despliegue) | **Parcial**: el backup funciona; faltan alertas, snapshots y alineación de versiones ([TD-006](docs/roadmap/technical-debt.md#td-006), [TD-007](docs/roadmap/technical-debt.md#td-007)) |

Fuente única del estado: [docs/roadmap/current-status.md](docs/roadmap/current-status.md).
Problemas visibles y su solución temporal: [docs/roadmap/known-issues.md](docs/roadmap/known-issues.md).

## Funcionalidades principales

- **Bots** con código propio (Python o JavaScript, SDK incluido) y versiones inmutables.
- **Equipamiento** modular: 5 chasis y 31 módulos de catálogo, con presupuesto, masa y energía.
- **7 modos de juego** en el motor (deathmatch, por equipos, captura de bandera, control de zona y
  otros), de los que la plataforma expone 4 — ver [modos de juego](docs/user/game-modes.md).
- **Mapas** validados, versionados y publicables, con generador procedural e importación Tiled.
- **Torneos** con calendario, cuadro y rating Elo: liga, todos contra todos, eliminación simple y
  doble, y suizo. Existe un sexto formato por equipos que todavía no se puede usar
  ([TD-011](docs/roadmap/technical-debt.md#td-011)).
- **Replays** comprimidos y verificables bit a bit.
- **Aislamiento** del código de usuario en contenedores de sólo lectura, conectados únicamente a la
  red interna de la arena (sin DNS ni Internet), con límites de CPU, memoria y procesos, y firma
  de artefactos.

## Arquitectura

```text
Navegador
   │ HTTPS
   ▼
gateway (nginx) ── único servicio con puertos publicados
   ├── /          → web (SPA React + Phaser)
   ├── /api/v1/   → api (Express) ──────────────┐
   ├── /ws/       → tournament-worker (WebSocket de espectador)
   └── /replays/  → replay-service (ficheros en disco)
                                                 │
                         PostgreSQL ◄────────────┘  negocio + cola de trabajos (tabla jobs)
                             ▲
              ┌──────────────┴───────────────┐
      tournament-worker               bot-build-worker
      ejecuta batallas, torneos,      valida versiones de bots
      ratings y replays               (pipeline de build)
              │
        arena-engine (motor, librería en proceso)
```

Completan el stack: `queue` (Redis, canal de aviso opcional), `bot-manager`, `arena-engine` (como
servicio), `map-service` y `backup` (restic sobre SFTP).

Arquitectura real, con autoridades y redes: [docs/overview/architecture.md](docs/overview/architecture.md).

## Tecnologías

TypeScript y Node.js ≥ 22.15 · Express 5 · PostgreSQL 16 con Knex · Redis 7 · React 19 + Vite ·
Phaser 4 · Rapier2D (física) · Docker y Docker Compose · nginx · restic sobre SFTP ·
GitHub Actions · Vitest · Playwright.

Para qué usa S9 cada una: [docs/overview/technologies.md](docs/overview/technologies.md).

## Componentes principales

| Ruta | Qué es |
|---|---|
| `apps/api` | API REST y autoridad de escritura; RBAC derivado de `openapi.yaml` |
| `apps/web` | SPA de usuario y administración |
| `apps/arena-engine` | motor de simulación determinista |
| `apps/tournament-worker` | ejecución de batallas y torneos, ratings, WebSocket de espectador |
| `apps/bot-manager` | pipeline de build y sandbox de bots |
| `apps/replay-service` | almacenamiento y lectura de replays |
| `apps/map-service` | librería de mapas (validador, generador, importador) |
| `packages/*` | contratos compartidos: protocolo, catálogo, esquema de mapas, reglas |
| `sdks/*`, `example-bots/` | SDK para escribir bots y bots de ejemplo |
| `infrastructure/` | Docker Compose, gateway, backup, scripts y tests de despliegue |

Ficha de cada servicio: [docs/technical/services.md](docs/technical/services.md).
Estructura del repositorio: [docs/development/repository.md](docs/development/repository.md).

## Flujo de una batalla

```text
usuario crea la batalla en la web
  → api valida participantes, mapa y ruleset, y la guarda (scheduled)
  → api encola un trabajo run_battle en la tabla jobs
  → tournament-worker lo reclama y ejecuta el motor (running)
  → resultado, ganador y estadísticas en PostgreSQL (finished)
  → replay en disco, referenciado desde la batalla
  → visor en directo y reproductor en la web
```

Hoy ese flujo se corta en varios puntos (build, ruleset, bot de relleno, visor). Paso a paso, con
tablas, estados y errores: [docs/technical/battles.md](docs/technical/battles.md).

## Inicio rápido

Desarrollo local, sin Docker:

```bash
node --version        # debe ser ≥ 22.15 (Node 20 no está soportado)
npm ci
npm run check:node
npm test              # suite completa; PostgreSQL embebido, sin servicios externos
npm run lint
```

Guía completa de entorno: [docs/development/setup.md](docs/development/setup.md).
Instalar el stack completo con Docker: [docs/operations/installation.md](docs/operations/installation.md).

> El `docker-compose.demo.yml` de la raíz es el prototipo v1 retirado y no debe usarse. El
> despliegue oficial es `infrastructure/docker-compose.yml` con el perfil `production`.

## Documentación

Punto de entrada: **[docs/README.md](docs/README.md)**.

### Usuario
Cómo usar la web: cuenta, bots, equipamiento, equipos, mapas, batallas, torneos, visor, replays y
clasificaciones. → [docs/user/](docs/user/index.md)

### Técnica
Cómo está construido: arquitectura, servicios, base de datos, API, motor, ciclo de batalla, bots,
mapas, replays, frontend y seguridad. → [docs/technical/](docs/technical/index.md)

### Operaciones
Cómo se instala y se administra: instalación, configuración, Docker, red, backup, restore,
actualizaciones, apagado y diagnóstico. → [docs/operations/](docs/operations/index.md)

### Desarrollo
Cómo se contribuye: entorno, repositorio, flujo de trabajo, tests, CI, releases y convenciones.
→ [docs/development/](docs/development/index.md)

### Estado y roadmap
Qué funciona hoy, deuda técnica confirmada, problemas conocidos y funcionalidades pendientes.
→ [docs/roadmap/](docs/roadmap/index.md)

### Auditorías e histórico
Evidencia de cómo se llegó hasta aquí: auditorías, informes de pruebas, decisiones (ADR), diseños y
entregas anteriores. No describe el producto actual.
→ [docs/audits/](docs/audits/README.md) · [docs/testing/](docs/testing/index.md) ·
[docs/adr/](docs/adr/index.md) · [docs/history/](docs/history/index.md)
