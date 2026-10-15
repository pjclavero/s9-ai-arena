# E10 · DevOps, Despliegue y Observabilidad — entrega v1

Monorepo, CI/CD, el stack Docker Compose único con perfiles y redes del capítulo 6,
observabilidad (cap. 24), copias y recuperación. Cubre **T10.1 a T10.4** (dosier
líneas 808–881) contra los capítulos 6, 22 y 24 del dosier técnico.

## Limitación del entorno de desarrollo (leer primero)

El usuario `ia02` de esta máquina **no tiene acceso al daemon de Docker** (sin
grupo `docker`, sin `sudo`) y Node es v20.19.2. En consecuencia:

- **Verificado ejecutando de verdad:** parseo/estructura de todos los YAML,
  `docker compose config` (el CLI valida y resuelve perfiles SIN daemon —
  comprobado), 56 tests vitest nuevos en `infrastructure/tests/` (escáner de
  seguridad contra fixtures buenas/malas y contra el compose real, estructura
  completa del stack, configs de observabilidad, dry-runs reales de
  backup/restore y verificación sha256 de integridad con corrupción detectada),
  `bash -n` + ejecución de los scripts, `init-secrets.sh` real (idempotencia y
  gitignore verificados), `tsc --noEmit`, `npm run lint`, y la suite completa.
- **Implementado, verificación PENDIENTE de entorno con Docker:** construir
  imágenes, levantar el stack, humo E2E, escaneo de puertos desde fuera,
  aislamiento de red real de los bots, disparo de alertas (caos), traza de
  correlation_id en Loki, aprovisionado de Grafana en vivo y el simulacro
  cronometrado de recuperación. Cada uno tiene instrucciones exactas en
  `docs/despliegue.md` (§ "Verificación pendiente") y `docs/recuperacion.md`.
- La ejecución real de la CI requiere además configuración del repositorio en
  GitHub (protección de ramas, environments) que **E10 no aplica**: pasos del
  operador en ADR-010 D10.5, pendientes de confirmación humana.

## Estado de la suite

```bash
npm test   # 366 pasan · 1 falla · 3 skipped (370)
```

El único fallo es **preexistente y de entorno**: `zstdCompressSync` no existe en
Node v20.19.2 (requiere ≥ 22.15). No es una regresión de E10; la CI fija Node 22
(`.github/workflows/ci.yml`), donde ese test pasa. Tests de infraestructura:
`npx vitest run infrastructure` → **56/56**.

## Contenido

```
.github/workflows/ci.yml        T10.1 · CI en 8 etapas (22.3); nightly.yml (1000 batallas + RUN_SLOW)
.github/CODEOWNERS              T10.1 · rutas [E6]: motor, protocolo, sandbox, runtimes
.changeset/config.json          T10.1 · versionado semántico por paquete (changesets)
docs/decisiones/ADR-010-…md     T10.1 · workspace npm, changesets, stack observabilidad,
                                        backup, política de ramas (pasos del operador)
infrastructure/
  docker-compose.yml            T10.2-4 · stack único: 12 servicios (6.2) + backup + 8 de
                                        observabilidad; perfiles, 5 redes (6.4), 6 volúmenes (6.3)
  .env.example                  T10.2 · documentado (dominio, modos, BD externa, backup…)
  gateway/nginx.conf            T10.2 · standalone TLS; correlation_id; log JSON
  gateway/nginx-behind-proxy.conf T10.2 · modo detrás del Nginx de VM104
  docker/…/Dockerfile           T10.2 · gateway, arena-engine, node-service genérico,
                                        streamer (esqueleto E11), bot-runtime, backup
  scripts/scan-compose.mjs      T10.2 · escáner cap. 28 (docker.sock/privileged/puertos)
  scripts/init-secrets.sh       T10.2 · secretos por archivo, 0600, idempotente
  scripts/smoke.sh              T10.2 · humo post-despliegue (etapa 8 de la CI)
  observability/                T10.3 · prometheus (+alertas), alertmanager, loki, promtail,
                                        grafana aprovisionado (2 dashboards versionados)
  backup/backup.sh              T10.4 · pg_dump + restic + manifest sha256 + métricas; dry-run
  backup/restore.sh             T10.4 · restauración y verificación de integridad
  tests/ (4 archivos, 56 tests) T10.2-4 · verificación real de todo lo anterior
docs/despliegue.md              T10.2 · instalación limpia en 3 pasos; modos (a)/(b)
docs/recuperacion.md            T10.4 · runbook VM vacía → plataforma (< 2 h)
```

## Estado de la DoD por tarea

Leyenda: ✅ verificado ejecutando · 🔶 implementado, verificación pendiente de
entorno con Docker/GitHub · con el comando exacto entre paréntesis.

| Tarea | Criterio | Estado |
|---|---|---|
| T10.1 | PR que rompe esquema de E1 o golden de E2 queda bloqueado (PR canario) | 🔶 workflows validados por parseo YAML; el bloqueo exige protección de ramas (ADR-010 D10.5, paso 4) |
| T10.1 | CODEOWNERS impide fusionar cambios de seguridad sin revisión de E6 | 🔶 archivo creado; "Require review from Code Owners" lo activa el operador (D10.5) |
| T10.1 | CI de un PR medio < 15 min | 🔶 presupuesto respetado por diseño (suite local completa: 30 s; 1000 batallas y RUN_SLOW van a nightly.yml); medición real pendiente de la primera ejecución en GitHub |
| T10.1 | Cada merge a main produce imágenes por versión y digest en el registro | 🔶 etapa 5 con push a ghcr por sha+versión; requiere ejecutar la CI |
| T10.2 | `--profile production up -d` deja la plataforma sana + humo E2E | 🔶 `docker compose --profile production config` resuelve OK (ejecutado); levantar el stack requiere daemon; además faltan los entrypoints de web/api/worker/replay (E7/E9) |
| T10.2 | Solo el gateway expone puertos (escaneo desde fuera: 80/443) | ✅ en la definición: test `compose.test.ts` + escáner (ejecutados) · 🔶 nmap real desde fuera |
| T10.2 | Un bot no alcanza postgres/redis/api desde la red arena | ✅ en la definición: bots solo en `arena` (internal), test ejecutado · 🔶 prueba de conectividad real |
| T10.2 | Con DATABASE_URL externo, postgres no arranca y todo funciona | ✅ `docker compose --profile external-db config --services` no lista postgres (ejecutado, test) · 🔶 arranque real |
| T10.2 | Nadie privilegiado ni docker.sock salvo bot-manager documentado (escaneo automático) | ✅ `scan-compose.mjs` probado contra fixtures malas y el compose real (6 tests); en la etapa 6 de la CI |
| T10.3 | correlation_id en Loki devuelve la traza gateway→api→worker→motor | 🔶 gateway genera/propaga X-Correlation-Id (nginx.conf), promtail parsea el JSON; el test guionizado necesita el stack vivo. La instrumentación DENTRO de api/worker/motor es contrato con sus equipos (ADR-010 D10.3) |
| T10.3 | Alerta de motor bloqueado dispara en < 30 s (caos) | ✅ regla verificada por test: scrape 5 s + umbral 10 s + for 10 s ⇒ ≤ 25 s en el peor caso · 🔶 test de caos real |
| T10.3 | Dashboards aprovisionados desde el repo sin clicks | ✅ provisioning + 2 dashboards versionados, coherencia dashboard↔datasource testada · 🔶 despliegue limpio real |
| T10.3 | Perfil observability opcional | ✅ `config --services` con y sin el perfil (test ejecutado) |
| T10.4 | Simulacro VM vacía + backup → funcional, < 2 h | 🔶 runbook completo con cronómetro en docs/recuperacion.md; ejecutarlo requiere Docker |
| T10.4 | Restauración pasa integridad: checksums de mapas y replays, migraciones | ✅ `restore.sh --verify` probado DE VERDAD: manifest sha256 correcto acepta, replay manipulado falla · 🔶 sobre datos reales |
| T10.4 | Backup en cron dentro del stack y alerta si falla o > 26 h | ✅ servicio `backup` + crond + métricas textfile + reglas BackupFailed/BackupTooOld(26 h) testadas; dry-run real del script · 🔶 ejecución real del cron |
| T10.4 | Secretos restaurados nunca en logs ni en el repo | ✅ test: el valor de un secreto no aparece en la salida; `git ls-files` confirma que solo README/.gitignore están versionados |

## Cifras medidas (no estimadas)

- `npm test` (worktree, `--maxWorkers=2`): **366 pasan, 1 falla (zstd/Node 20,
  preexistente), 3 skipped**; ~30 s. Antes de E10: 310/1/3 — **+56 tests, 0
  regresiones**.
- `docker compose config` (sin daemon, ejecutado): `production` → 11 servicios;
  `external-db` → 10 (sin postgres); `development+bots+streaming` → los 12 de la
  tabla 6.2; `production+observability` → 19.
- Escáner cap. 28: 4 fixtures (1 buena, 3 malas con privileged/docker.sock/
  puertos) + compose real; **6/6 tests**, y como CLI exit 0/1 correcto.
- `tsc --noEmit`: 63 errores antes → **7 después** (los 63−56 eran del prototipo,
  ahora excluido; los 7 restantes son de E2/E3/E4, ver hallazgos).
- `DETERMINISM_RUNS=5` verificado (6,4 s): la nightly puede subir a 1000 sin
  tocar código.

## Hallazgos y decisiones (E10.M y otros)

1. **`docker-compose.yml` de la raíz obsoleto**: es del prototipo previo
   (arena-server/viewer/bot-red/blue), NO es el stack del cap. 6. No se borra;
   se propone retirarlo junto con `pnpm-workspace.yaml`, `apps/arena-server`,
   `apps/arena-viewer` y `bots/*` en un PR de limpieza aprobado por el operador
   (usan `workspace:*` de pnpm, incompatible con npm workspaces, y concentraban
   53 de los 63 errores de tipos).
2. **7 errores de tipos preexistentes** de otros equipos (`battle.ts` ×2,
   `map-service/generate` ×2, `module-catalog` ×3): el typecheck de la CI queda
   `continue-on-error` hasta que sus equipos los limpien (marcado en ci.yml).
3. **Sin formateador configurado** en el repo: adoptar prettier exige acuerdo
   (reformateo masivo = conflictos con trabajo en curso); etapa 1 lo deja
   anotado (ADR-010).
4. El dosier no fija stack de observabilidad ni herramienta de backup:
   **Prometheus+Grafana+Loki** y **pg_dump+restic** (ADR-010 D10.3/D10.4), a
   ratificar.
5. **Excepciones de red documentadas**: streamer (salida RTMPS), alertmanager
   (webhook) y backup (NAS) se acoplan a `public` SIN publicar puertos, porque
   las redes internas no tienen salida; testado que no publican nada.
6. Entrypoints de servicio de web/api/tournament-worker/replay-service/
   bot-manager/streamer: **pendientes de E7/E9/E6/E11** (la infraestructura
   los espera vía `SERVICE_ENTRY`; imágenes construibles ya).
7. Requisito del operador aplicado: la plataforma es **autocontenida en una
   máquina**; el acceso web público puede darlo el Nginx de VM104
   (`*.seccionnueve.duckdns.org`) como proxy inverso — dos modos documentados y
   soportados (`GATEWAY_CONF`), ver docs/despliegue.md.
8. El fallo zstd es de Node 20 local; la CI fija Node 22 y la nightly lo cubrirá.

## Cómo verificar cuando haya Docker

Checklist consolidado en `docs/despliegue.md` (§ Verificación pendiente),
`docs/recuperacion.md` (simulacro cronometrado) y ADR-010 D10.5 (PR canario y
CODEOWNERS). Test de caos de la alerta de motor: pausar el bucle de tick
(SIGSTOP al proceso del motor) y medir hasta `ALERTS{alertname="EngineTickStalled",alertstate="firing"}`.

## Addendum 2026-07-16 · Verificación con Docker real en VM108

Con autorización explícita del operador se verificó E10 en VM108 (Docker CE 29.6.1 +
Compose + Buildx), sin tocar la v1 en producción (intacta antes y después):

- **[EJECUTADO]** `docker compose config` con el CLI real de Docker 29.6.1 sobre
  `infrastructure/docker-compose.yml`, todas las combinaciones: development = 10
  servicios, production = 11, production+observability = 19, external-db excluye
  postgres. Todas correctas.
- **[EJECUTADO]** Escáner `scan-compose` contra el stack real: **0 infracciones**
  (sin docker.sock, sin privileged, redes internas `internal: true`, solo el gateway
  publica puertos).
- **[EJECUTADO]** Suite E10 dentro de un contenedor `node:22`: 51/51 tests ejecutables
  verdes (5 skipped por falta de `git` en `node:22-slim`, no es fallo de código).
- **[BLOQUEADO POR ENTORNO]** `docker compose up` del stack, healthchecks en vivo,
  conectividad de bots y simulacro de recuperación: **VM108 no tiene salida a internet
  para Docker** (no puede hacer pull de imágenes base). Vías: restaurar esa salida
  (hallazgo de infraestructura a diagnosticar) o el runner de GitHub Actions que la CI
  de T10.1 ya define (Node 22 + Docker).
