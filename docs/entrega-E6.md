# E6 · Seguridad y Ejecución de Código — entrega v1

Trata todo código de bot como hostil. Cubre **T6.1 a T6.4** de los capítulos 17.1 y 18
del dosier técnico: el pipeline de publicación (build reproducible, análisis, pruebas,
firma), el sandbox de ejecución con los controles de la tabla 18.2, los runtimes fijados
por lenguaje, y la capa de auditoría/suspensión/hallazgos. Se apoya en el contrato de E1
(`apps/api/openapi.yaml`), el motor de E2 y el protocolo/SDK de E5, **sin reimplementar
nada** de esos equipos (importa `Battle`, los stubs de bot y el esquema real del protocolo).

## Limitación de entorno (condiciona toda la verificación)

La máquina de desarrollo (`ia02`) **no tiene acceso a Docker** (no está en el grupo
`docker`, sin `sudo`). No se pueden construir ni lanzar contenedores aquí. Por eso E6 se
entrega en **dos capas**, y la tabla de DoD distingue explícitamente cada ítem entre
**«verificado ejecutando X»** y **«implementado, verificación real pendiente de entorno
con Docker»**. Nunca se marca como verificado algo que no se ejecutó.

1. **Lógica verificable aquí con tests reales (vitest):** máquina de estados del pipeline
   con persistencia, validación de estructura/tamaño, análisis estático + dependencias +
   allowlist + lockfile, hashing/firma de artefactos, prueba de protocolo y partida de
   humo **en proceso** contra el motor real de E2 y el esquema real del protocolo de E5,
   escaneo de secretos, `audit_log` de solo inserción, `security_findings` con RBAC, y
   suspensión. Todo con tests que pasan.
2. **Artefactos Docker verificables solo por inspección:** el `DockerContainerRunner` con
   los flags exactos de la tabla 18.2, los `Dockerfile` de `runtimes/`, el perfil seccomp,
   la suite `tests/sandbox-escape/` con los 7 bots maliciosos, y los escaneos de imágenes.
   El **escáner del Compose sí es ejecutable** (opera sobre ficheros `.yml`) y tiene tests.

## Estado: suite en verde

```bash
npm test                              # suite completa del monorepo
npx vitest run apps/bot-manager       # solo E6: 66 tests, ~13 s
npx tsx scripts/scan-compose.ts       # escáner del Compose (cap. 28)
npx tsx scripts/verify-runtime-digests.ts   # runtimes fijados por digest (T6.3)
# Requieren Docker (NO ejecutables en ia02):
./tests/sandbox-escape/run-escape-suite.sh <imagen@digest>   # T6.2
./scripts/scan-runtime-vulns.sh                              # T6.3 (Trivy)
```

## Contenido

```
apps/bot-manager/
  src/
    types.ts             estados/etapas del contrato OpenAPI de E1 (no se inventan)
    config.ts            límites y allowlists CONFIGURABLES (10 MB / 200 MB, E6.M)
    store.ts             BuildStore: InMemory + JsonFile (decisión de persistencia, ver abajo)
    artifact.ts          T6.1 · empaquetado reproducible + hash sha256
    signing.ts           T6.1 · firma ed25519 + verificación previa a ejecución
    static-analysis.ts   T6.1/T6.3 · imports, dependencias, allowlist, lockfile
    secret-scan.ts       T6.4 · escaneo de secretos (AWS/GitHub/tokens/passwords)
    smoke-battle.ts      T6.1 · prueba de protocolo + partida de humo EN PROCESO (motor E2, esquema E5)
    pipeline.ts          T6.1 · orquestador de la máquina de estados de builds
    container-runner.ts  T6.2 · ContainerRunner + DockerContainerRunner (flags 18.2) + inspect
    launch-guard.ts      T6.2/T6.4 · solo bot-manager lanza; rehúsa suspendidos
    compose-scanner.ts   T6.2 · escáner de docker.sock/privileged/... del Compose
    sandbox-process.ts   T6.2 · runner con deadline (bucle infinito no cuelga)
    audit.ts             T6.4 · audit_log solo-inserción + security_findings con RBAC
    suspension.ts        T6.4 · SuspensionRegistry + DQ administrativa
    security-events.ts   T6.4 · puente de intentos de escape a findings
  tests/                 66 tests (13 ficheros)
  security/seccomp-bot.json    perfil seccomp restrictivo (allowlist de syscalls)
runtimes/
  python/Dockerfile, ALLOWED-PACKAGES.md, allowed-requirements.lock
  node/Dockerfile, ALLOWED-PACKAGES.md, allowed-package.json + lock
  DIGESTS.lock           imágenes fijadas por digest (no tag)
tests/sandbox-escape/    7 bots maliciosos + manifest + harness Docker + README
scripts/
  scan-compose.ts        CLI del escáner del Compose (CI)
  verify-runtime-digests.ts   CLI de verificación de digests (CI)
  scan-runtime-vulns.sh  Trivy sobre imágenes de runtime (CI, requiere Docker)
.github/workflows/e6-security.yml   CI: jobs sin-Docker (aquí) + con-Docker (runner)
```

## Definition of Done — evidencia por ítem

Leyenda: **[EJECUTADO]** = verificado corriendo tests/CLI reales en esta máquina ·
**[INSPECCIÓN]** = implementado con código completo, verificación real pendiente de un
entorno con Docker (ia02 sin grupo docker ni sudo).

### T6.1 — Pipeline de build y publicación

| DoD | Evidencia |
|-----|-----------|
| Build reproducible: dos builds del mismo commit → mismo hash (Python y JS) | **[EJECUTADO]** `artifact.test.ts` + `pipeline.test.ts` (build reproducible Python y JS). El empaquetado es función pura determinista; el hash es sha256 canónico. |
| Dependencia fuera de allowlist → Rechazado, señalando el paquete | **[EJECUTADO]** `pipeline.test.ts` («dependencia fuera de la allowlist… señalando el paquete»), `static-analysis.test.ts`. |
| La firma se verifica antes de cada ejecución; artefacto manipulado se rechaza | **[EJECUTADO]** `signing.test.ts` + `pipeline.test.ts` («artefacto manipulado lo rechaza»). |
| La partida de humo detecta un bot que compila pero incumple protocolo y lo rechaza | **[EJECUTADO]** `pipeline.test.ts` («detecta un bot que compila pero incumple protocolo»). El COMMAND se valida contra `command.schema.json` REAL de E5, partida sobre `Battle` REAL de E2. Caso de prueba incluido (`brokenProtocolCandidate`). |
| Pipeline de un bot Python sencillo < 3 min | **[EJECUTADO]** medido: **~321 ms** (pipeline completo con prueba de protocolo + partida de humo en proceso). Umbral 180 000 ms. |
| Build reproducible «en contenedor aislado sin red salvo proxy de dependencias» | **[INSPECCIÓN]** el aislamiento del build en contenedor y el proxy de dependencias con allowlist se concretan en `runtimes/` + `DockerContainerRunner`; el build real en contenedor requiere Docker. La allowlist/lockfile sí se verifican con tests. |

### T6.2 — Sandbox de ejecución de bots

| DoD | Evidencia |
|-----|-----------|
| Los 7+ bots maliciosos fallan su objetivo y quedan registrados | **[INSPECCIÓN]** `tests/sandbox-escape/` con los 7 vectores + `run-escape-suite.sh` (flags 18.2). **[EJECUTADO]** `sandbox-escape-suite.test.ts` verifica que la suite está completa y consistente; `security-events` → finding es ejecutado en `audit.test.ts`. La ejecución de los contenedores requiere Docker. |
| Ninguno afecta al tick de una batalla concurrente (métricas E2) | **[INSPECCIÓN]** requiere lanzar contenedores concurrentes con el motor; pendiente de Docker. |
| Bot en bucle infinito: solo su cuota de CPU, descalificado por timeouts, sin degradar el motor | **[EJECUTADO parcial]** `sandbox-process.test.ts`: un bucle infinito se mata al vencer el deadline sin colgar el harness (capa de proceso). La contención de CPU por cgroup es **[INSPECCIÓN]** (Docker `--cpus`). |
| Inspección de la config real: cero capabilities, read-only, seccomp, no-new-privileges (lee config vía inspect) | **[EJECUTADO]** `container-runner.test.ts`: `buildRunArgs()` genera todos los flags de la 18.2 y `analyzeInspect()` interpreta la salida de `docker inspect` (conforme vs no-conforme). Verificación contra un contenedor VIVO: **[INSPECCIÓN]**. |
| Escaneo CI que falla si el Compose monta docker.sock o corre privilegiado | **[EJECUTADO]** `compose-scan.test.ts` + `scripts/scan-compose.ts` (sale 1 ante infracción, 0 con el compose real del repo). |
| Solo bot-manager crea contenedores (ni web ni API pública) | **[EJECUTADO]** `launch-guard.test.ts`. |

### T6.3 — Runtimes fijados por lenguaje

| DoD | Evidencia |
|-----|-----------|
| Bot que importa un paquete no incluido → build falla identificando el import | **[EJECUTADO]** `runtimes.test.ts` + `static-analysis.test.ts`. |
| pip/npm install inoperativos dentro del contenedor | **[EJECUTADO parcial]** `runtimes.test.ts` verifica que los `Dockerfile` **deshabilitan** pip (uninstall + stub) y npm/pnpm/yarn/corepack (rm de binarios). Comprobación en el contenedor VIVO: **[INSPECCIÓN]**. |
| Imágenes reproducibles con digest fijado en el repo (CI) | **[EJECUTADO]** `verify-runtime-digests.ts` + `runtimes.test.ts`: `DIGESTS.lock` y los `FROM` están fijados por `@sha256`. El digest real tras `docker build` es **[INSPECCIÓN]** (placeholders hasta construir). |
| Escaneo de vulnerabilidades en CI que bloquea severidad crítica | **[INSPECCIÓN]** `scripts/scan-runtime-vulns.sh` (Trivy, `--exit-code 1 --severity CRITICAL`) + job en `e6-security.yml`; requiere Docker. |

### T6.4 — Auditoría, suspensión y hallazgos

| DoD | Evidencia |
|-----|-----------|
| Un intento de escape genera un security_finding consultable solo por admins (RBAC) | **[EJECUTADO]** `audit.test.ts` (admin lo ve; moderador y web reciben `Forbidden`). |
| Un bot suspendido no se lanza aunque esté inscrito; la batalla lo descalifica | **[EJECUTADO]** `suspension.test.ts` (`LaunchAuthority` rehúsa; `administrativeDisqualifications` lo DQ; inscripciones marcadas). |
| Código con clave AWS de ejemplo bloqueado con hallazgo registrado | **[EJECUTADO]** `audit.test.ts` + `secret-scan.test.ts` + `pipeline.test.ts`. |
| audit_log de solo inserción: sin endpoint ni permiso de borrado/edición | **[EJECUTADO]** `audit.test.ts`: `AuditLog` no expone `delete`/`update`/`remove` y `AUDIT_PERMISSIONS` no concede borrado a ningún rol. |

## Cifras reales medidas (2026-07-16, ia-server, Node v20.19.2)

- **E6 (`apps/bot-manager`): 66 tests, 13 ficheros, 100 % verdes** (~13 s).
- **Suite completa (`npm test --maxWorkers=2`): 376 pasan, 1 falla, 3 skipped (380).**
  - El único fallo es **PREEXISTENTE y de ENTORNO**: `zstdCompressSync is not a function`
    en `apps/arena-engine/tests/replay-golden.test.ts` (E2/T2.6), porque Node 20.19.2 <
    22.15. No es un bug de código ni una regresión de E6. Antes de E6 la base era 310
    pasan; E6 añade +66 → 376, sin romper nada.
- **Pipeline completo de un bot Python (con prueba de protocolo + partida de humo en el
  motor real): ~321 ms** (umbral de UX del dosier: 3 minutos).

## Decisiones de diseño (y por qué)

- **Persistencia de `builds`:** el dosier pide una «tabla builds». La BD PostgreSQL del
  cap. 23 es de E7 (T7.1) y aún no existe; `node:sqlite` solo está en Node ≥ 22 y aquí
  corre Node 20. Se define la interfaz `BuildStore` con dos implementaciones de misma
  semántica: `InMemoryBuildStore` (tests) y `JsonFileBuildStore` (persistencia real en
  disco). Cuando E7 levante la BD, basta una tercera implementación `PgBuildStore` sin
  tocar el pipeline.
- **Prueba de protocolo y partida de humo EN PROCESO:** en producción el «artefacto» es un
  contenedor que se conecta por WebSocket al `ProtocolServer` de E5. Sin Docker, el
  pipeline recibe un `CandidateAgentFactory` que produce un `BotAgent` en proceso, y la
  partida de humo monta un `Battle` **real** de E2 (mismo catálogo E3, mismo ruleset) con
  el COMMAND validado contra el **esquema real** del protocolo `arena/1`. Lo único que no
  se ejercita es el transporte WebSocket + el aislamiento del contenedor (eso es T6.2).
- **`budgetCredits`** permanece como parámetro configurable por ruleset (ADR-000); E6 no lo
  toca. Los límites de E6 (tamaño de fuente/artefacto, CPU/RAM/PIDs) son igualmente
  configurables vía `PipelineConfig`/`ContainerLimits`, no constantes escondidas.
- **No se reimplementa lógica ajena:** `smoke-battle.ts` importa `Battle` y los stubs de
  E2/E5 y el esquema de `packages/protocol`; el análisis estático es defensa en
  profundidad, no sustituye al sandbox de proceso (el motor ya es autoritativo sobre la
  física, pero el bot sigue siendo código arbitrario que se ejecuta).

## Mejoras y carencias detectadas (E6.M)

- **Aislamiento solo-Docker:** se recomienda planificar gVisor/Kata como endurecimiento
  posterior y, mientras, mantener el stack en una VM dedicada de Proxmox (cap. 27). El
  `ContainerRunner` es una interfaz precisamente para poder sustituir el runtime.
- **Proxy de dependencias:** concretado como allowlist explícita por runtime + lockfile
  obligatorio (`config.ts`, `runtimes/`), con proceso de alta documentado (issue +
  revisión de seguridad).
- **Escaneo de secretos:** añadido como etapa del pipeline (no estaba en el dosier);
  protege también al propio usuario.
- **Límites de tamaño:** 10 MB fuente / 200 MB artefacto como valores iniciales
  configurables (E6.M).
- **Pentesting interno del sandbox** antes de M4 (juego de guerra con bots hostiles
  nuevos, no los de la suite conocida): pendiente, requiere entorno con Docker.

## Lo que queda fuera / pendiente de entorno

Todo lo marcado **[INSPECCIÓN]** arriba se ejecutará en un runner con Docker (jobs
`runtime-vuln-scan` y `sandbox-escape` de `e6-security.yml`): construir las imágenes de
runtime y fijar sus digests reales, lanzar la suite de escape contra contenedores vivos,
inspeccionar la config real con `docker inspect`, medir el impacto en el tick de una
batalla concurrente, y el escaneo de vulnerabilidades con Trivy. La recomendación del
dosier de una **VM dedicada** para el stack de bots aplica también a ese runner.
