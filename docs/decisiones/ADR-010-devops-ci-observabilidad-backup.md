# ADR-010 — Decisiones de DevOps: workspace, versionado, observabilidad y copias

- **Estado:** Propuesto (pendiente de ratificación del operador)
- **Fecha:** 2026-07-16
- **Autor:** E10 · DevOps, Despliegue y Observabilidad
- **Cierra:** decisiones que el dosier deja abiertas en 22.1 (tooling de workspace), 22.2 (versionado), T10.3 (stack de observabilidad) y T10.4 (herramienta de backup)

## D10.1 · Tooling de workspace: npm workspaces

**Decisión.** npm workspaces, declarado en `package.json` raíz (`packages/*`, `sdks/javascript`).

**Justificación.** El lockfile real del proyecto es `package-lock.json` (npm); toda la
suite E1–E5 se instala y ejecuta con npm. Adoptar pnpm obligaría a regenerar el lockfile
y revalidar E1–E5 sin beneficio inmediato.

**Notas.**
- `pnpm-workspace.yaml`, `docker-compose.yml` (raíz), `apps/arena-server`,
  `apps/arena-viewer` y `bots/*` son restos del prototipo previo: usan el protocolo
  `workspace:*` de pnpm (incompatible con npm) y quedan **fuera** del workspace y del
  `tsconfig.json` raíz. Se propone retirarlos en un PR de limpieza aprobado por el
  operador (no los borra E10).
- Los `apps/*` nuevos se incorporan al workspace cuando su equipo les dé `package.json`.

## D10.2 · Versionado semántico por paquete: changesets

**Decisión.** `@changesets/cli` (devDependency raíz, `.changeset/config.json`). Cada PR
que cambie un paquete versionable añade un changeset; `npm run version-packages` aplica
los bumps según `docs/compatibilidad.md`.

## D10.3 · Stack de observabilidad: Prometheus + Grafana + Loki (+ Promtail, cAdvisor, node-exporter)

**Decisión.** Perfil `observability` del Compose único (`infrastructure/docker-compose.yml`):
Prometheus (métricas y alertas), Alertmanager (notificación por webhook/email del operador),
Grafana (dashboards aprovisionados desde el repo), Loki + Promtail (logs JSON estructurados),
cAdvisor + node-exporter (CPU/RAM por servicio y disco). Es opcional: la plataforma
funciona sin el perfil.

**Contrato de logging (cap. 24).** Todos los servicios emiten JSON por stdout con campos
`ts`, `level`, `service`, `msg` y, cuando apliquen, `battle_id`, `bot_id`, `user_id`,
`correlation_id`. El gateway genera `X-Correlation-Id` si no llega y lo propaga; cada
servicio lo copia a sus logs y a las llamadas salientes. La instrumentación dentro de
cada servicio pertenece a su equipo; E10 define el contrato y lo explota en Loki/Grafana.

## D10.4 · Copias de seguridad: pg_dump + restic

**Decisión.** Backup lógico diario con `pg_dump` (formato custom, comprimido) y `restic`
para los volúmenes `arena_maps`, `arena_bot_sources`, `arena_replays` (solo oficiales,
según retención) y los secretos (cifrados por el propio repositorio restic). Destino:
`RESTIC_REPOSITORY` que designe el operador (NAS/ZFS del servidor). Cron dentro del stack
(servicio `backup` del Compose) con métrica de última ejecución y alerta a las 26 h.

**Alternativas descartadas.** pgBackRest (PITR innecesario para el tamaño actual; se
reevaluará si la BD crece), duplicity/borg (restic tiene cifrado+dedup+verify y es el
estándar del homelab).

## D10.5 · Política de ramas y protección (22.2) — pasos del operador

Este ADR NO cambia configuración del repositorio en GitHub; la aplica el operador:

1. Settings → Branches → Add branch protection rule para `main`:
   - Require a pull request before merging + Require approvals (1).
   - **Require review from Code Owners** (activa `.github/CODEOWNERS`).
   - Require status checks: `lint-format-types`, `unit`, `contracts`,
     `regression-battles`, `build-images`, `scan`.
   - Do not allow bypassing the above settings.
2. Settings → Environments: crear `staging` y `production`; en `production` añadir
   **Required reviewers** (esa aprobación es la "promoción manual" de la etapa 8).
3. Crear el equipo `@pjclavero/e6-seguridad` y sustituir `@pjclavero` en las rutas [E6]
   de `.github/CODEOWNERS`.
4. Verificación (DoD T10.1): abrir un PR canario que rompa un esquema de E1 o un golden
   de E2 y comprobar que queda bloqueado; abrir otro que toque `packages/protocol/` sin
   revisión de E6 y comprobar que no se puede fusionar.
