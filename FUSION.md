# S9 AI Arena — monorepo (E1 + E2 fusionados)

Este zip es el resultado de fusionar la entrega de **E1 (Contratos y Especificación)** y **E2 (Motor de Simulación)** en un único árbol, sin duplicados. Descomprímelo directamente sobre la raíz de `s9-ai-arena`.

## Regla de fusión aplicada

E1 es la **fuente de verdad** de todo lo que es contrato. Donde E2 tenía una copia de trabajo de un contrato (porque la necesitaba para poder programar sin esperar a E1), esa copia se ha descartado y se ha dejado únicamente la de E1.

| Ruta | Origen | Motivo |
|---|---|---|
| `docs/decisiones/ADR-000-*.md` | E1 | Contrato: las 9 decisiones fundacionales |
| `docs/compatibilidad.md` | E1 | Contrato: política de versionado |
| `packages/protocol/schemas/*.json` | E1 | Contrato: los 6 mensajes de `arena/1` |
| `packages/protocol/examples/` | E1 | Ejemplos válidos/inválidos del contrato |
| `packages/protocol/scripts/validate.js` | E1 | Validador del contrato |
| `packages/module-catalog/schema/*.json` | E1 | Contrato: módulo y loadout |
| `packages/map-schema/map.schema.json` | E1 | Contrato: formato de mapa |
| `apps/api/openapi.yaml` | E1 | Contrato: API HTTP (53 operaciones) |
| `packages/game-rules/constants.ts` | E1 | Contrato: constantes del ADR-000 |
| `packages/game-rules/constants.test.ts` | E1 | Test de coherencia del contrato |
| `packages/game-rules/index.ts` | **E2** | NO es un contrato: son rulesets y tabla de degradación que E2 construyó *encima* de `constants.ts`. E1 no tenía este archivo. |
| `apps/arena-engine/` | E2 | Motor: código propio de E2, no toca ningún contrato |
| `tests/golden/` | E2 | Escenarios golden de física del motor |

`packages/protocol/` y `packages/game-rules/constants.ts` que traía el zip de E2 (su copia de trabajo) **no están en este zip**: son exactamente iguales a los de E1 (verificado con `diff`), así que conservarlos habría sido duplicar el mismo archivo en el mismo sitio sin ningún beneficio.

## Un ajuste necesario para que ambas partes convivan

El motor de E2 es ESM/TypeScript y necesita `"type": "module"` en el `package.json` raíz. Los scripts de validación de E1 (`validate.js`, `validate-catalog.js`) son CommonJS (`require`). Node resuelve esto de forma estándar con un `package.json` anidado que fija el tipo de módulo solo para esa carpeta:

- `packages/protocol/scripts/package.json` → `{"type": "commonjs"}`
- `packages/module-catalog/scripts/package.json` → `{"type": "commonjs"}`

No ha hecho falta tocar ni una línea de código de ninguno de los dos equipos.

## Verificación tras la fusión

Todo lo siguiente se ha ejecutado sobre este árbol ya fusionado, no sobre los zips por separado:

```bash
npm install

# Contratos de E1
node packages/protocol/scripts/validate.js              # 19 válidos + 22 inválidos
node packages/module-catalog/scripts/validate-catalog.js # 6 válidos + 11 inválidos

# Motor de E2
npm test                                                  # 81 pruebas
npm run lint                                              # lint de determinismo
```

Resultado: **cero duplicados de contrato**, **81/81 tests del motor en verde**, los dos validadores de E1 en verde. Cada archivo de contrato (`*.schema.json`, `constants.ts`, `openapi.yaml`) aparece exactamente una vez en todo el árbol.

## Siguiente equipo

E3 (Sistema Modular de Vehículos) es el que sigue. Su catálogo real sustituirá al andamio provisional de `apps/arena-engine/src/fixtures.ts`, y las pruebas del motor no deberían cambiar cuando lo haga.
