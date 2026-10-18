# Cómo hacer un cambio correctamente

## Resumen

«Soy un desarrollador nuevo, ¿cómo hago un cambio correctamente?». El ciclo completo, en orden:
rama → cambio → tests → controles negativos y mutaciones → documentación → PR → CI → review →
merge → construcción con identidad → despliegue → verificación. Cada paso dice qué comando usar y
qué evidencia dejar.

## Índice

- [1. Rama](#1-rama)
- [2. Cambio](#2-cambio)
- [3. Tests](#3-tests)
- [4. Controles negativos y mutaciones](#4-controles-negativos-y-mutaciones)
- [5. Documentar](#5-documentar)
- [6. Pull request](#6-pull-request)
- [7. CI](#7-ci)
- [8. Review](#8-review)
- [9. Merge](#9-merge)
- [10. Construcción y despliegue](#10-construcción-y-despliegue)
- [Lista de comprobación](#lista-de-comprobación)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## 1. Rama

```bash
git fetch origin && git switch -c <tipo>/<tema-corto> origin/main
git rev-parse HEAD     # anota la base
```

Tipos habituales: `feat/`, `fix/`, `docs/`, `test/`, `infra/`, `chore/`. Un cambio por rama; si
dependes de otro PR, apila la rama sobre la suya y **no borres la rama base al mergear** el
primero (cerraría el PR apilado).

## 2. Cambio

- Lee antes el contrato que tocas: `apps/api/openapi.yaml`, `packages/protocol`, `packages/module-catalog`,
  `packages/map-schema` ([contract-compatibility.md](contract-compatibility.md)).
- Si cambias el esquema de la base de datos, añade una migración nueva en
  `apps/api/src/db/migrations.ts` (Knex, ADR-E7-001); nunca edites una ya publicada.
- En `apps/arena-engine/src/sim/` no uses reloj de pared, aleatoriedad no sembrada ni E/S
  (determinismo).
- Sin secretos, IPs ni nombres de máquinas reales en código, tests o fixtures: usa rangos
  `192.0.2.x`/`203.0.113.x` y `example.internal`.

## 3. Tests

```bash
npm run check:node
npm run typecheck
npm run lint                 # determinismo del motor
npm run format:check         # o npm run format
npm run test:pure            # sin BD
npm run test:db              # suites con PostgreSQL embebido
```

Para una zona concreta: `npx vitest run apps/api/src/<fichero>.test.ts`. Antes del PR, `npm test`
completo. Detalle de suites y flags en [testing.md](testing.md).

Registra en el PR **el código de salida real** de cada comando (no el de una tubería con `tail`).

## 4. Controles negativos y mutaciones

Una prueba que nunca se ha visto en rojo no demuestra nada. Para cada garantía nueva o tocada:

1. **Control positivo**: el caso válido pasa.
2. **Control negativo**: rompe a propósito lo que la garantía protege (quita la comprobación, cambia
   el valor) y comprueba que el test se pone **rojo por el motivo correcto**; luego revierte.
3. Si la zona tiene arnés de mutantes, ejecútalo y comprueba que **ninguna mutación sobrevive**:

| Zona | Arnés |
|---|---|
| Gates de despliegue | `node infrastructure/scripts/{deploy-contract,backup-stack,tag-override,compose-canonical,runtime-drift,scan-status}-mutations.mjs` |
| Deriva de imagen | `node infrastructure/scripts/mutate-image-drift.mjs` |
| Readiness / primer arranque | `packages/readiness/mutations.ts`, `node scripts/r17-first-run-mutants.mjs` |
| Degradación del worker | `bash scripts/worker-degradation-mutants.sh` |
| Gates con autoprueba | `node infrastructure/scripts/<gate>.mjs --self-test` |

Commitea antes de ejecutar arneses que restauran el árbol con `git checkout`: lo no commiteado se
pierde. Comprueba que la mutación cae en código que el sujeto realmente ejecuta.

## 5. Documentar

- Si cambia el comportamiento, actualiza **el documento canónico** del tema (uno por tema; ver
  [../DOC-MIGRATION-MAP.md](../DOC-MIGRATION-MAP.md) y [../README.md](../README.md)), con su sección
  `## Verificación` (ruta:línea o comando).
- Si añades o resuelves deuda, actualiza [../roadmap/technical-debt.md](../roadmap/technical-debt.md).
- Si es una decisión de arquitectura, añade un ADR en [../adr/](../adr/index.md).
- No escribas como existente algo que sólo está diseñado (marca DESIGN_ONLY).
- Estilo: [conventions.md](conventions.md#documentación).

## 6. Pull request

```bash
git push -u origin <rama>
gh pr create --base main --title "<tipo>(<ámbito>): <qué cambia>" --body-file pr.md
```

El cuerpo incluye: qué y por qué, base (`git rev-parse` de origen), comandos ejecutados con su
código de salida, controles negativos realizados, documentos tocados y riesgos/deuda. Detalle en
[contributing.md](contributing.md).

## 7. CI

La CI corre en cada PR y en cada push a `main` ([ci.md](ci.md)). Criterio para dar un PR por
verde:

- se cuentan **todas** las conclusiones de **todos** los checks (`gh pr checks <n>`), no el final
  de un `gh run watch`;
- `skipped`, `neutral` o en curso **no** son éxito; un recuento vacío no es verde;
- el job `semaforo` resume: 🔴 bloquea, 🟡 hubo trabajo omitido (p. ej. staging), 🟢 todo ejecutado;
- `functional-e2e` (golden path real: navegador + build en sandbox + batalla + replay, y E2E Docker)
  es obligatorio en todo PR: si sale rojo, el PR rompe el núcleo funcional y no se mergea. Su
  evidencia está en el artifact `functional-e2e-golden-<n>` ([ci.md](ci.md#gate-funcional-functional-e2e));
- la protección de rama de `main` lo impone: `semaforo` y los dos jobs de `functional-e2e` son
  checks obligatorios, la rama debe estar al día y la regla incluye a los administradores
  ([ci.md](ci.md#protección-de-rama)). Si un check obligatorio falla, GitHub no deja mergear.

## 8. Review

Cambios en motor, protocolo, sandbox y runtimes requieren revisión según `.github/CODEOWNERS`. El
revisor comprueba que los tests prueban el comportamiento (no un texto), que hay control negativo
y que la documentación canónica dice la verdad.

## 9. Merge

Merge a `main` con CI verde (recuento completo, `semaforo` y `functional-e2e` incluidos) y review
aprobada. Antes de un release, gate manual `functional-e2e` (`workflow_dispatch`) sobre el commit. No reescribas `main`. Si el PR
forma parte de una pila, reapunta los PR dependientes antes de borrar la rama.

## 10. Construcción y despliegue

1. El merge a `main` dispara `build-images`: todas las imágenes se publican en GHCR con
   `BUILD_COMMIT=<sha>` y etiqueta `sha-<sha>` ([releases.md](releases.md)).
2. El job `deploy-staging` **no despliega nada** hoy ([ci.md](ci.md#deploy-staging-y-smoke-and-promote)).
3. El despliegue en una instalación lo hace un operador con el procedimiento de
   [../operations/upgrades.md](../operations/upgrades.md): verificar procedencia de la imagen,
   `up -d --no-build --no-deps <servicios>`, migraciones si las hay, health, versión e informe.

## Lista de comprobación

- [ ] Rama desde `origin/main` actualizado; base anotada.
- [ ] `check:node`, `typecheck`, `lint`, `format:check`, `test:pure`, `test:db` con rc=0 registrado.
- [ ] Control negativo / mutantes de la garantía tocada, en rojo por el motivo correcto.
- [ ] Documento canónico y `## Verificación` actualizados; deuda/ADR si aplica.
- [ ] Nada de topología, secretos ni datos personales.
- [ ] PR con evidencia; CI con todas las conclusiones en `success`.
- [ ] Despliegue (si aplica) por el procedimiento de operación, con verificación de versión.

## Documentación relacionada

[testing.md](testing.md) · [ci.md](ci.md) · [releases.md](releases.md) · [contributing.md](contributing.md) ·
[conventions.md](conventions.md) · [../operations/upgrades.md](../operations/upgrades.md) ·
[ADR-016](../adr/ADR-016-identidad-de-build.md) · [ADR-017](../adr/ADR-017-contrato-de-release.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Scripts `check:node`, `typecheck`, `lint`, `format:check`, `test:pure`, `test:db` | CODE_VERIFIED | `package.json` |
| Arneses de mutación listados existen | CODE_VERIFIED | `infrastructure/scripts/*-mutations.mjs`, `mutate-image-drift.mjs`, `scripts/r17-first-run-mutants.mjs`, `scripts/worker-degradation-mutants.sh`, `packages/readiness/mutations.ts` |
| Regla de recuento de conclusiones | CODE_VERIFIED | ADR-017 §10; `infrastructure/scripts/ci-gate.mjs` |
| `build-images` publica `sha-<sha>` sólo en `main` | CODE_VERIFIED | `.github/workflows/ci.yml:374-377` |
| `deploy-staging` no despliega | CODE_VERIFIED | `.github/workflows/ci.yml:930-947` (`ssh` comentado) |
| Migraciones en `apps/api/src/db/migrations.ts` con Knex | CODE_VERIFIED | fichero; ADR-E7-001 |
