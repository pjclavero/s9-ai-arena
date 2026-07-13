# Informe de balance v1 — banco de simulación espejo

Generado por `packages/module-catalog/balance/run.ts`. Arquetipos de `packages/module-catalog/balance/archetypes.ts`, motor headless de E2 (`Battle`), `HunterBot` en ambos lados, ruleset `dm_practice@1`, arena vacía (`emptyArena()`). Semilla determinista por batalla: `bal_v1_<emparejamiento>_<índice>`.

| Emparejamiento (A vs B) | Batallas | Winrate A | IC95% | Daño medio A | Daño medio B | Ticks medios | Empates | ¿En 45–55%? |
|---|---|---|---|---|---|---|---|---|
| scout_vs_gunner | 200 | 46.5% | ±6.9 pp | 281.8 | 245.2 | 413 | 0 | ✅ |
| scout_vs_heavy | 200 | 51.8% | ±6.9 pp | 374.7 | 240.1 | 517 | 1 | ✅ |
| gunner_vs_heavy | 200 | 48.0% | ±7.0 pp | 368.2 | 295.0 | 910 | 4 | ✅ |

## Semillas (reproducibilidad)
- **scout_vs_gunner**: `bal_v1_scout_vs_gunner_0000` … `bal_v1_scout_vs_gunner_0199`
- **scout_vs_heavy**: `bal_v1_scout_vs_heavy_0000` … `bal_v1_scout_vs_heavy_0199`
- **gunner_vs_heavy**: `bal_v1_gunner_vs_heavy_0000` … `bal_v1_gunner_vs_heavy_0199`

