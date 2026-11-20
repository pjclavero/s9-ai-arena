# AGENTS.md · S9 AI Arena

**Qué es.** Monorepo TypeScript/Node (>=22.15, npm workspaces: `packages/*` y `sdks/javascript`) de un motor 2D determinista de combate para torneos de bots de IA: API Express+Knex/PostgreSQL, motor a 30 Hz con Rapier2D, visor React/Vite + Phaser, bot-manager con sandbox Docker, replays, torneos/Elo, streaming y observabilidad. El producto es `apps/*` (salvo el prototipo v1), `packages/*`, `sdks/`, `runtimes/` e `infrastructure/`. `apps/*` no son workspaces de npm; el `pnpm-workspace.yaml` de la raíz es residual y no se usa (el gestor real es npm, con `package-lock.json`). `bots/` contiene bots de ejemplo/oficiales, `sdks/` los SDK para autores de bots y `runtimes/` las imágenes de ejecución de bots; el prototipo v1 (`apps/arena-server`, `apps/arena-viewer`, `docker-compose.demo.yml`) es legado.

**Comandos** (scripts de `package.json`):
- `npm run lint` (determinismo del motor) · `npm run typecheck` · `npm run format:check`
- `npm test` (vitest) · `npm run test:pure` · `npm run test:db` (PostgreSQL embebido, `docs/adr/ADR-E7-002-postgres-embebido-en-tests.md`) · `npm run test:visual` (Playwright, `acceptance/visual`)
- CI en `.github/workflows/`: `ci.yml`, `acceptance.yml`, `e6-security.yml`, `functional-e2e.yml`, `nightly.yml`, `runtimes-publish.yml`. Los contextos obligatorios para fusionar los fija la protección de `main` (no esta lista).
- Compose oficial: `infrastructure/docker-compose.yml` (perfil `nucleo`). En la raíz sólo existe `docker-compose.demo.yml` (legado v1): no es el compose a usar.

**Dónde está**
| Tema | Ruta |
|---|---|
| Índice de la documentación | `docs/README.md` |
| Estado actual y roadmap | `docs/roadmap/current-status.md`, `docs/roadmap/` (contrastar con `git log`) |
| Desarrollo (preparación, flujo, contribución, pruebas, CI) | `docs/development/` (`setup.md`, `workflow.md`, `contributing.md`, `testing.md`, `ci.md`) |
| Arquitectura y contratos | `docs/technical/`, `docs/overview/`; contratos en `packages/protocol`, `packages/map-schema`, `apps/api/openapi.yaml` |
| Decisiones técnicas | `docs/adr/` (`index.md`) |
| Operación y despliegue | `docs/operations/` (procedimientos que ejecuta el operador con autorización expresa; un agente no los lanza por iniciativa propia) |
| Uso del producto | `docs/user/` |
| Auditorías | `docs/audits/` |
| Histórico | `docs/history/`; equivalencia de rutas antiguas en `docs/DOC-MIGRATION-MAP.md` |
| Pruebas | `tests/e2e`, `acceptance/`, `docs/testing/` |

**Reglas para agentes**
- Flujo de rama y PR: ver `docs/development/contributing.md` y `docs/development/workflow.md`. En resumen: rama propia (worktree) desde `main` actualizado por ítem, PR con CI verde, revisión independiente (nunca quien implementó) y mutaciones de no vacuidad antes de dar un test por válido. No se hace push directo a `main`.
- No tocar el legado (`docker-compose.demo.yml`, `apps/arena-server`, `apps/arena-viewer`). El contenido base se crea con `apps/api/src/db/cli.ts bootstrap`, nunca con `seed`.
- Activar módulos o ejecución automática de batallas en producción, o cambiar de versión Rapier, requiere autorización explícita del propietario del proyecto.
- Decisiones nuevas = ADR en `docs/adr/`; la evidencia de pruebas va en `docs/testing/` o en el documento de la tarea; al cerrar, actualizar `docs/roadmap/current-status.md`.
- Repo público: no incluir topología interna (IPs, nombres de máquinas, usuarios de servicio, rutas locales) ni credenciales.

**Prohibiciones explícitas para agentes**
- Nunca `git push --force`, `git reset --hard`, `git clean` ni `git checkout -f`; nunca borrar ramas o worktrees ajenos.
- Nunca mergear sin CI verde y revisión independiente conforme, ni hacer push directo a `main`.
- Nunca modificar ni desplegar en producción sin autorización expresa del propietario. El diagnóstico en producción es sólo de lectura.
- Nunca relajar, saltar ni borrar tests o gates para que pasen.
- Nunca leer, imprimir ni registrar secretos, ni pasarlos por argv.
