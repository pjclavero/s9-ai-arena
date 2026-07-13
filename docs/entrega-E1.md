# E1 · Contratos y Especificación — entrega v0.1

Salida completa del Equipo E1 (tareas T1.1 a T1.4 del Dosier de tareas).
Es la **puerta del hito M0**: ningún otro equipo escribe código de producto hasta que esto esté firmado.

## Contenido

```
docs/
  decisiones/ADR-000-decisiones-fundacionales.md   T1.1 · las 9 decisiones del cap. 27.1, cerradas
  compatibilidad.md                                E1.M · semver, lockstep de SDKs y proceso de cambio
packages/
  game-rules/constants.ts                          T1.1 · constantes derivadas del ADR-000
  game-rules/constants.test.ts                     T1.1 · tests de coherencia entre constantes
  protocol/schemas/*.json                          T1.2 · envelope + 6 mensajes de arena/1
  protocol/examples/valid|invalid/                 T1.2 · 18 válidos + 21 inválidos (con _why)
  protocol/scripts/validate.js                     T1.2 · validador CLI y suite
  protocol/README.md                               T1.2 · ciclo de vida y las 5 reglas duras
  module-catalog/schema/module.schema.json         T1.3 · las 10 categorías con sus propiedades
  module-catalog/schema/loadout.schema.json        T1.3 · forma del loadout (legalidad la valida E3)
  module-catalog/scripts/validate-catalog.js       T1.3 · validador y suite de módulos/loadouts/mapas
  map-schema/map.schema.json                       T1.3 · formato interno de mapa (cap. 14.2)
apps/
  api/openapi.yaml                                 T1.4 · 53 operaciones, todas con x-min-role
```

## Cambios sobre v0.1 (patch, no rompe compatibilidad)

**D7 — presupuesto de créditos ahora configurable por ruleset.** A petición del usuario: `budgetCredits` deja de ser una constante fija del motor y pasa a ser un campo opcional de `WELCOME.rules` (esquema de protocolo) y de `TournamentInput` (OpenAPI), con `BUDGET_CREDITS_MVP = 1000` como valor por defecto si el ruleset no lo declara. Permite ajustar la dificultad por competición (p. ej. una liga "skirmish" a 600, una "asedio" a 2000) sin tocar motor, catálogo ni protocolo. Es **compatible hacia atrás**: al ser opcional con valor por defecto, un `WELCOME` sin el campo sigue siendo válido (ejemplo `welcome-ctf.json`, sin cambios). Sigue **fuera de alcance** cualquier progresión de cuenta/campaña: el presupuesto de una batalla oficial depende solo del ruleset elegido, nunca del historial del bot, para no romper la comparabilidad del rating (E9/T9.3). Ver D7 en el ADR-000 para el razonamiento completo.

Archivos tocados: `ADR-000-decisiones-fundacionales.md`, `game-rules/constants.ts` (+`BUDGET_CREDITS_MIN/MAX`), `game-rules/constants.test.ts`, `protocol/schemas/welcome.schema.json`, `protocol/examples/valid/welcome-custom-budget.json` (nuevo), `protocol/examples/invalid/welcome-budget-out-of-range.json` (nuevo), `apps/api/openapi.yaml` (`TournamentInput.budgetCredits`).

## Verificación

```bash
node packages/protocol/scripts/validate.js            # 18 OK + 21 rechazados
node packages/module-catalog/scripts/validate-catalog.js  # 6 OK + 11 rechazados
npx vitest run packages/game-rules                    # coherencia de constantes
npx spectral lint apps/api/openapi.yaml               # lint del contrato HTTP
```

## Estado de la DoD

| Tarea | Criterio | Estado |
|---|---|---|
| T1.1 | ADR-000 con las 9 decisiones (valor, justificación, impacto) | Hecho |
| T1.1 | Constantes exportadas con test de coherencia | Hecho |
| T1.1 | Firmado por E2, E3 y E5 | **Pendiente** (revisión humana) |
| T1.2 | 6 esquemas validan sus ejemplos y rechazan los inválidos | Hecho (41/41) |
| T1.2 | Envelope rechaza versiones de protocolo desconocidas | Hecho |
| T1.2 | Tipos TS generados desde los esquemas en build | **Pendiente** (script de build) |
| T1.2 | CHANGELOG y política de compatibilidad | Hecho (compatibilidad.md) |
| T1.3 | Esquema cubre las categorías con sus propiedades | Hecho |
| T1.3 | Loadout MVP de ejemplo valida | Hecho |
| T1.3 | Checksum de mapa con serialización canónica documentada | Documentado; **falta implementarlo** (E4/T4.1) |
| T1.4 | Todos los endpoints con x-min-role | Hecho (53/53) |
| T1.4 | spectral lint sin errores | **Pendiente** (ejecutar en CI de E10) |
| T1.4 | Cliente TS generado que compila | **Pendiente** (E10 monta el pipeline) |

Lo pendiente depende de que E10 monte el monorepo y la CI (T10.1): son pasos de tooling, no decisiones de contrato.
