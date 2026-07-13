# S9 AI Arena — monorepo

Estado actual: **E1 (Contratos y Especificación)** y **E2 (Motor de Simulación)** completados.

- Cómo se fusionaron estas dos entregas, y qué prevalece sobre qué: **[FUSION.md](FUSION.md)**
- Detalle de la entrega de E1: **[docs/entrega-E1.md](docs/entrega-E1.md)**
- Detalle de la entrega de E2: **[docs/entrega-E2.md](docs/entrega-E2.md)**
- Decisiones fundacionales (ADR-000): **[docs/decisiones/ADR-000-decisiones-fundacionales.md](docs/decisiones/ADR-000-decisiones-fundacionales.md)**

## Arranque rápido

```bash
npm install

# Contratos (E1)
node packages/protocol/scripts/validate.js
node packages/module-catalog/scripts/validate-catalog.js

# Motor (E2)
npm test
npm run lint
```

## Próximo equipo

**E3 · Sistema Modular de Vehículos** — catálogo de módulos, validador de ensamblaje de loadouts y balance. Sustituirá el catálogo provisional de `apps/arena-engine/src/fixtures.ts`.
