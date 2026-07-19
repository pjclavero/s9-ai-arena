# Checklist de validación V4 — R10 / R11 / R12 (foundations)

> Se rellena al IMPLEMENTAR cada foundation (este dossier es solo diseño). Estado: ✅ pasa ·
> ❌ falla · ⏳ pendiente · ⚠️ parcial · 🔒 gateado/off por defecto.

## Comunes (toda PR de esta fase)

| # | Prueba | Comando/acción | Esperado | Estado |
|---|---|---|---|---|
| C1 | typecheck | `npx tsc --noEmit` (+`-p apps/web`) | 0 errores | ⏳ |
| C2 | lint/format | `npm run lint` · `npx prettier --check` | OK | ⏳ |
| C3 | tests | `npx vitest run` (área tocada) | verde | ⏳ |
| C4 | conformance | conformance.test | operaciones openapi = implementación | ⏳ |
| C5 | seguridad | greps docker.sock/privileged/host/unconfined | 0 en config productiva | ⏳ |
| C6 | frontend sin secretos | grep DOCKER_PROXY_URL/SECRET/TOKEN en apps/web | 0 | ⏳ |
| C7 | flags off | feature-flag experimental | disabled por defecto | 🔒 |
| C8 | no VM108 | — | VM108/runner/proxy intactos | ⏳ |

## R10 — Editor de mapas

| # | Prueba | Esperado | Estado |
|---|---|---|---|
| 10.1 | mapa válido pasa validación | valid | ⏳ |
| 10.2 | sin spawns / spawn fuera de bounds / wall fuera de bounds | invalid | ⏳ |
| 10.3 | publicar invalid | rechazado | ⏳ |
| 10.4 | versión published no editable | rechazado | ⏳ |
| 10.5 | render editor · crear/mover/borrar objeto · guardar draft | OK | ⏳ |
| 10.6 | export/import roundtrip | estable (mismo checksum) | ⏳ |

## R11 — Spectator público

| # | Prueba | Esperado | Estado |
|---|---|---|---|
| 11.1 | spectator disabled por defecto | `#/live` muestra disabled | 🔒 |
| 11.2 | live list vacía | estado vacío limpio | ⏳ |
| 11.3 | no expone secretos/rutas internas | payload público mínimo | ⏳ |
| 11.4 | replay público solo si enabled | gate respetado | 🔒 |
| 11.5 | render #/live + overlay · battle inexistente | error limpio | ⏳ |
| 11.6 | enlace a replay final si disponible | presente | ⏳ |

## R12 — Torneos/ranking/matchmaking

| # | Prueba | Esperado | Estado |
|---|---|---|---|
| 12.1 | crear torneo draft + entrants (RBAC admin) | OK | ⏳ |
| 12.2 | generar bracket single_elim/round_robin | correcto | ⏳ |
| 12.3 | preparar match SIN ejecutar | battle prepared, sin auto-run | ⏳ |
| 12.4 | leaderboard wins/losses/draws | correcto (desde standings) | ⏳ |
| 12.5 | matchmaking disabled por defecto | cola off | 🔒 |
| 12.6 | Run tournament disabled si `S9_ENABLE_REAL_BATTLE_RUNS=0` | botón disabled | 🔒 |
| 12.7 | NO auto-run real | ninguna batalla real automática | ⏳ |

## Gates VM108 (no en esta fase)

| # | Prueba | Esperado | Estado |
|---|---|---|---|
| V1 | R6.2/R9-A: ejecución real desde UI/torneo en VM108 | batalla+replay reales | ⏳ (gateado) |
| V2 | R7-A operativo: ingesta desde host VM108 + `GET /replays` | replay visible en `#/replays` | ⏳ (gateado) |
