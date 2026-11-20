# S9 AI Arena

Plataforma de combate entre bots de IA. Cada jugador programa su vehículo en Python o JavaScript, lo
equipa con módulos (chasis, armas, sensores, radio…) y lo enfrenta a otros en un motor de
simulación 2D determinista. Las batallas se ven en directo o se repiten después como replay, y los
torneos generan clasificaciones Elo.

> **Versión V1 0.5.0** (motor 0.5.0, contrato de API 0.25.0, migraciones 001–022). La lista de lo
> que funciona está más abajo y cada línea dice con qué se comprobó. El estado detallado, separado en
> implementado, integrado, probado, validado en laboratorio, desplegado y verificado en producción, está en
> [docs/roadmap/current-status.md](docs/roadmap/current-status.md).

## ¿Qué quieres hacer?

| Quiero… | Empieza aquí |
|---|---|
| **Jugar**: crear un bot, equiparlo, batallar y competir | [Guía del jugador](docs/user/index.md) y [primeros pasos](docs/user/getting-started.md) |
| **Instalar** mi propia arena | [Instalación](docs/operations/installation.md), después [puesta en marcha](docs/operations/first-run.md) |
| **Entender cómo está hecha** | [Visión general](docs/overview/index.md) y [documentación técnica](docs/technical/index.md) |
| **Contribuir** | [Desarrollo](docs/development/index.md) y [AGENTS.md](AGENTS.md) |
| Saber **qué entra en V1, qué no y qué falla** | [Roadmap de V1](docs/roadmap/v1-roadmap.md) |

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

## Qué funciona en V1 0.5.0

«CI» es la CI obligatoria de `main` (navegador real y contenedores reales en `functional-e2e`).
«Laboratorio» es una prueba de ciclo completo con API, base de datos y motor reales, pero con bots
simulados en proceso. Sólo se lista lo que tiene una de esas dos pruebas.

| Área | Estado | Cómo se sabe |
|---|---|---|
| Recorrido del jugador: cuenta, bot con código propio, build en sandbox, publicación, batalla con su código firmado, visor, estadísticas y replay | **Funciona** | CI (`golden-path.spec.ts`) |
| Bots: versiones inmutables, clonado, diff; equipamiento con presupuesto, masa y energía; elegibilidad de versiones | **Funciona** | CI y tests de la API |
| Batallas 1v1 y por equipos hasta 4 contra 4, con reglas oficiales y copia inmutable de las reglas | **Funciona** | CI (`team-battle-4v4.spec.ts`) |
| Motor determinista (0.5.0) y replays verificables | **Funciona** | CI (`regression-battles`, replays de oro) |
| Torneos: todos contra todos, eliminación simple, suizo y **Team Deathmatch por equipos 2v2, 3v3 y 4v4**, con clasificación, Elo y replays | **Funciona** | Laboratorio (PR #317, pendiente de merge); escenarios previos en CI |
| Mapas: importar, generar, editor visual, publicar | **Funciona** | CI |
| Ranking Elo por modo y temporada | **Funciona** | tests de la API y laboratorio |
| Copias de seguridad (restic), restauración y export/import portable de bots y equipos | **Funciona** | CI (`e2e-backup-sftp`, restauración) |
| Espectador y replays públicos, emisión en directo (streamer) | **Existe, apagado por defecto**: lo decide un ajuste de la base de datos desde Administración. La emisión a YouTube real no está probada | tests; sin prueba en producción |

Lo que **no** es V1, con su motivo y su versión objetivo, está en el
[roadmap de V1](docs/roadmap/v1-roadmap.md). En particular:

- **Captura de bandera y control de zona en torneos: fuera de V1 y no funcionales.** Las batallas
  sueltas de esos modos las soporta el motor (pruebas de motor y de la API); los torneos que los usan se crean y no pueden jugarse.
- Doble eliminación y liga existen en el calendario, pero no tienen prueba de ciclo completo.
- No hay recuperación de contraseña por correo.

Fuente única del estado: [docs/roadmap/current-status.md](docs/roadmap/current-status.md).
Problemas visibles y su solución temporal: [docs/roadmap/known-issues.md](docs/roadmap/known-issues.md).

## Funcionalidades principales

- **Bots** con código propio (Python o JavaScript, SDK incluido) y versiones inmutables.
- **Equipamiento** modular: un catálogo de 31 piezas (5 chasis y el resto módulos), con presupuesto, masa y energía.
- **7 modos de juego** en el motor (deathmatch, por equipos, captura de bandera, control de zona y
  otros), de los que la plataforma expone 4 — ver [modos de juego](docs/user/game-modes.md).
- **Mapas** validados, versionados y publicables, con generador procedural e importación Tiled.
- **Torneos** con calendario, cuadro y rating Elo: todos contra todos, eliminación simple, suizo y
  torneos por equipos de Team Deathmatch (2v2, 3v3 y 4v4). Liga y doble eliminación se aceptan, pero
  no están validados de punta a punta (ver el [roadmap](docs/roadmap/v1-roadmap.md)).
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
   ├── /api/v1/   → api (Express; también sirve los replays, tras autorizar) ─┐
   └── /ws/       → tournament-worker (WebSocket de espectador)
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

Ese flujo lo recorre de punta a punta el test de navegador de la CI. Paso a paso, con tablas,
estados y errores: [docs/technical/battles.md](docs/technical/battles.md).

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
> despliegue oficial es `infrastructure/docker-compose.yml` con el perfil `production`; la guía
> completa, incluidos los secretos y el proxy de Docker que necesita la ejecución de bots, es
> [docs/operations/installation.md](docs/operations/installation.md).

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
