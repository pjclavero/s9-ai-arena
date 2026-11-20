# Desarrollo de S9 AI Arena

## Resumen

Guía para quien va a **cambiar el código**: preparar el entorno, entender el monorepo, hacer un
cambio de principio a fin (rama → tests → controles negativos → documentación → PR → CI → review →
merge → despliegue), y conocer las suites de tests, la CI y cómo se publican las imágenes.

**Para quién es:** desarrolladores. Quien sólo quiere jugar o escribir bots no necesita nada de esta carpeta:
la [guía del jugador](../user/index.md) es autosuficiente. Quien administra un servidor tiene su propio manual en
[../operations/index.md](../operations/index.md).

Revisión del 2026-11-02 (`main` `e3bf2fa`): se comprobó que los scripts `npm` citados en `setup.md`,
`testing.md` y `workflow.md` existen en `package.json` y que los jobs de `ci.md` son los de
`.github/workflows/ci.yml`; los informes de cierre de octubre se movieron a
[../audits/](../audits/README.md). Cada documento conserva su tabla «Verificación» con la fecha en que se
comprobó su contenido.

## Índice

- [Por dónde empezar](#por-dónde-empezar)
- [Documentos](#documentos)
- [Reglas que no se negocian](#reglas-que-no-se-negocian)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Por dónde empezar

1. [setup.md](setup.md): Node ≥ 22.15, `npm ci`, PostgreSQL embebido para tests.
2. [repository.md](repository.md): qué hay en `apps/`, `packages/`, `sdks/`, `runtimes/`,
   `infrastructure/`, `tests/`, `scripts/`.
3. [workflow.md](workflow.md): «soy nuevo, ¿cómo hago un cambio correctamente?».

## Documentos

| Documento | Para qué |
|---|---|
| [setup.md](setup.md) | entorno local reproducible |
| [repository.md](repository.md) | estructura real del monorepo |
| [workflow.md](workflow.md) | el ciclo completo de un cambio |
| [testing.md](testing.md) | suites, cómo ejecutarlas, flags, límites conocidos |
| [ci.md](ci.md) | workflows de GitHub Actions, jobs, semáforo, rojos conocidos |
| [releases.md](releases.md) | imágenes, etiquetas, `BUILD_COMMIT`, runtimes en GHCR |
| [contributing.md](contributing.md) | cómo proponer cambios (PR, review, CODEOWNERS) |
| [conventions.md](conventions.md) | idioma, commits, estilo de código y de documentación |
| [contract-compatibility.md](contract-compatibility.md) | versionado y cambio de contratos (`protocol`, catálogo, mapas, OpenAPI) |

### Dónde está el resto del material de desarrollo

| Material | Dónde |
|---|---|
| Cómo está construido (API, motor, bots, replays, base de datos…) | [../technical/index.md](../technical/index.md) |
| Evidencias de pruebas, simulacros y checklists | [../testing/index.md](../testing/index.md) |
| Auditorías e informes de cierre (cierre funcional y *Production Readiness* de 2026-10) | [../audits/README.md](../audits/README.md) |
| Decisiones de arquitectura | [../adr/index.md](../adr/index.md) |
| Estado, deuda técnica y pendientes | [../roadmap/index.md](../roadmap/index.md) |
| Historia (diseños, rondas, entregas) | [../history/index.md](../history/index.md) |

## Reglas que no se negocian

- **Node ≥ 22.15** (`engines`); con Node 20 falla la compresión zstd de replays.
- **Un verde sólo cuenta si se puede poner rojo**: todo cambio de seguridad o de una garantía va con
  su control negativo o mutante ([workflow.md](workflow.md#4-controles-negativos-y-mutaciones)).
- **CI: se cuentan todas las conclusiones**; `skipped`/`neutral` no son éxito ([ci.md](ci.md)).
- **Determinismo del motor**: nada de reloj de pared ni E/S en `apps/arena-engine/src/sim/`
  (`npm run lint` lo comprueba).
- **BUILD y DEPLOY separados** (ADR-017): no se construye en el host productivo
  ([../operations/upgrades.md](../operations/upgrades.md)).
- **Repositorio público**: nunca IPs, hosts internos, secretos ni datos personales en código o
  documentación ([conventions.md](conventions.md#seguridad-documental)).

## Estado actual

- **FUNCIONA ACTUALMENTE:** suite unitaria y de BD con PostgreSQL embebido, CI con semáforo,
  publicación de imágenes por commit, mutantes de los gates de infraestructura.
- **También:** E2E de navegador real (`tests/browser`, golden path) y E2E con Docker en la CI como
  checks obligatorios de la protección de rama de `main` ([ci.md](ci.md#protección-de-rama)).
- **PARCIAL:** los tests unitarios de la web usan la API simulada (el golden path es el que la usa real);
  la nightly sigue en rojo ([TD-018](../roadmap/technical-debt.md#td-018),
  [TD-019](../roadmap/technical-debt.md#td-019)).

## Documentación relacionada

[../technical/index.md](../technical/index.md) · [../technical/architecture.md](../technical/architecture.md) ·
[../operations/index.md](../operations/index.md) · [../adr/index.md](../adr/index.md) ·
[../roadmap/technical-debt.md](../roadmap/technical-debt.md) · [../DOC-MIGRATION-MAP.md](../DOC-MIGRATION-MAP.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| `engines.node >=22.15`; Node 20 sin `zstdCompressSync` | CODE_VERIFIED | `package.json`; `scripts/check-node.mjs:1-30` |
| `npm run lint` = linter de determinismo | CODE_VERIFIED | `package.json` scripts; `apps/arena-engine/scripts/lint-determinism.mjs` |
| CI con semáforo `if: always()` | CODE_VERIFIED | `.github/workflows/ci.yml` job `semaforo` |
