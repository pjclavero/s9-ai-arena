# ADR-021 · Reglas de batalla: presets, personalizado y copia inmutable (motor sigue en 0.3.0)

**Estado:** propuesto (2026-10-29) · **Ámbito:** `packages/game-rules` (`index.ts`, `battle-rules.ts`), `apps/arena-engine` (`sim/battle.ts`, `sim/modes.ts`, `sim/vehicle.ts`), `apps/api` (POST /battles, rules-check, migración 015), `apps/tournament-worker` (`engine-executor.ts`), `apps/replay-service` (stats), `apps/web` (`BattleNewPage.tsx`)

## Contexto

Auditoría de la FASE 1 (fuera del repo, resumida aquí):

- Las reglas del motor (`RULESETS`) son objetos en código y la plataforma sólo guarda `battles.ruleset_id`. El ruleset del motor se **resolvía al ejecutar** (`resolveBattleRuleset` en el worker): una batalla creada se jugaba con las reglas vigentes al arrancar, no con las de su creación.
- No existía respawn limitado ni vidas; la victoria por eliminación sólo existía con respawn apagado. El desempate al agotar el tiempo era fijo (más puntos; si no, empate): un duelo sin respawn acababa siempre 0-0 ⇒ empate.
- El presupuesto de créditos se validaba al guardar el loadout (contra `mvp-default`); ninguna batalla validaba créditos ni masa, ni había topes por equipo.

## Decisión

1. **Dos capas.** `RulesParams` (lo que elige el jugador: respawn ninguno/limitado/ilimitado con `respawnsPerBot` = REAPARICIONES, retardo en s, victoria, límite de bajas, minutos, topes de créditos/masa por bot y por equipo, fuego amigo) y el `Ruleset` del motor. `engineRulesetFor()` traduce de forma determinista.
2. **Motor: dos campos OPCIONALES** en `Ruleset`:
   - `respawn.maxRespawns`: agotadas las reapariciones el vehículo queda eliminado; con respawn limitado la batalla termina por eliminación. El contador entra en el hash de estado (`rsp`) sólo cuando el campo existe. Evento público `vehicle_eliminated` (replay/espectador; NO se reparte a los bots porque el esquema EVENT de arena/1 no lo declara) y `respawnsLeft` en el snapshot público, ambos sólo con el campo.
   - `timeoutTiebreak`: lista ordenada de criterios (`score`, `lives`, `hull`) en una tabla; todo empate ⇒ `draw`.
   Sin los campos, el código de 0.3.0 se ejecuta tal cual.
3. **Presets oficiales v1** (`duel`, `combat`, `endurance`, `team_elimination`, `team_limited_respawn`, `team_deathmatch`, `team_endurance`), versionados e inmutables. CTF y control de zona siguen como rulesets «clásicos».
4. **Copia inmutable** (`battles.rules`, migración `015_battle_rules`, jsonb nullable): preset/personalizado/clásico, parámetros, topes, catálogo, ruleset COMPLETO del motor y versión del motor. POST /battles la crea siempre (también sin `rules`: copia de lo que el worker habría resuelto); el worker juega esa copia y su catálogo. Batallas sin copia (anteriores y de torneo) siguen el camino de 0.3.0.
5. **Validación en servidor** (`RULES_LIMITS`): enteros en rango, claves desconocidas rechazadas, combinaciones incompatibles rechazadas (400 `rules_invalid`); NvN exacto (400 `rules_team_size`); topes de créditos/masa con los loadouts REALES (422 `composition_invalid`, informe por bando y bot). Coste = chasis + módulos (la regla del presupuesto del loadout); masa = la física del motor (`resolveVehicle().massKg`, incluye munición embebida). `POST /battles/rules-check` hace las mismas comprobaciones sin crear nada.

## Versión del motor: NO se sube (0.3.0)

La regla de ADR-019/020 obliga a subir `engine.version` cuando cambia la simulación de una configuración **ya grabable en producción**. Ningún ruleset grabable hoy declara `maxRespawns` ni `timeoutTiebreak`, así que todas simulan exactamente igual:

- `rules-respawn-tiebreak.test.ts` fija los hashes medidos con el motor de `9aaad79` (`git archive origin/main`) para DM 1v1, TDM 1v1/2v2/4v4 con respawn, TDM 4v4 sin respawn y CTF 1v1: idénticos.
- Los golden (`replay-golden`, `determinism`, `spawn-4v4`, `fix-4v4-spawn-hash-identity`) siguen verdes **sin regenerar**.
- Subir la versión invalidaría la verificación de TODOS los replays 0.3.0 grabados (RC5.2/RC5.3) a cambio de nada.

**Riesgo aceptado:** si se vuelve atrás a la RC5.3, un replay grabado con `maxRespawns`/`timeoutTiebreak` lo re-simularía un motor que ignora esos campos y daría «no coincide» en vez de `engine_version_mismatch`. Mitigación: no hay vuelta atrás sin restaurar copia (el procedimiento de despliegue la hace), y los replays nuevos se identifican porque su cabecera lleva el ruleset con los campos nuevos.

## Qué NO cambia

- Límite de 8 participantes y 4 por bando; RAM; regla arma↔munición; minas (`resolveFiring` sigue saltando `deployMine` sin `fire`).
- API existente: `rules` es opcional en POST /battles; GET /rulesets, GET /battles/{id} y /stats sólo AÑADEN campos.
- Replays históricos: la re-simulación ya usaba `header.ruleset`; las stats leen el límite de respawns de la cabecera.

## Alternativas descartadas

- **Presets como filas de BD**: exigen sembrar en cada despliegue y un operador podría editarlos; en código son versionados y revisables, y la batalla guarda su copia igualmente.
- **Resolver al ejecutar con el preset actual**: es exactamente la reinterpretación silenciosa que prohíbe el encargo.
- **`lives` en vez de `respawns`**: se eligió `respawnsPerBot` como dato y la UI muestra siempre las dos lecturas («2 reapariciones (3 vidas)»).
- **Enviar `vehicle_eliminated` a los bots**: ampliaría el contrato EVENT de arena/1 (enum cerrado) para un dato que el bot ya puede deducir del WELCOME (`rules.respawn.maxRespawns`) y de sus `respawned`.
