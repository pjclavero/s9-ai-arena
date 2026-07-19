# S9 AI Arena — Roadmap

> Estado operativo real: `docs/ESTADO_ACTUAL.md`. Este roadmap resume hitos y lo siguiente.

## Hecho / integrado en `main`

- **Núcleo v2** desplegado en VM108 (7 servicios), dominio `s9arena.seccionnueve.duckdns.org`.
- **Hito A**: batalla E2E real validada en VM108 con **runners containerizados** + **replay real
  verificado** (bit a bit). Pipeline seguro: bot-manager → s9-docker-proxy → red `arena` → replay-service.
- **R7** replay API/viewer/verify · **R8** admin consolidado · **R9** creación de batalla prepared/segura.

## Integrado en main (2026-07-19)

- **#50 R7-A** — ingesta operativa del replay + listado global `#/replays`. **Mergeada** (CI verde).
- **#51 R6.2/R9-B** — ejecución containerizada **gateada** desde UI (`POST /battles/:id/run`,
  apagado por defecto; UI Run disabled salvo backend available). **Mergeada** (CI verde) tras
  rebase sobre #50. `main@6373e19`.

## Siguiente fase (diseño preparado — ver `docs/NEXT_PHASE_R10_R11_R12.md`)

- **R10** Editor avanzado de mapas (foundation) — independiente. → `R10-B`.
- **R11** Spectator público interno (foundation, gateado) — dependencia #50 **ya en main**. → `R11-B`.
- **R12** Torneos/ranking/matchmaking (foundation) — ranking pronto; run/matchmaking usan `runBattle`
  de #51 (**ya en main**) pero la ejecución real sigue gateada a la validación VM108 (R6.2/R9-A). → `R12-B`.

## Gates operativos pendientes (VM108, gateados)

- **R6.2/R9-A**: cablear el launcher real (bot-manager orquestador) + `S9_ENABLE_REAL_BATTLE_RUNS=1`
  y validar la ejecución containerizada real desde la UI/torneos en VM108.
- **R7-A operativo**: ingesta del replay desde el host en VM108 + acceso al replay-service.

## Invariantes permanentes

Sin `docker.sock`/`privileged`/`network_mode: host`/`seccomp=unconfined` en config productiva.
Ejecución de código no confiable siempre en contenedores aislados vía s9-docker-proxy. Firma/digest
obligatorios. Secretos nunca en el frontend. Features experimentales **off** por defecto.

## Orden recomendado

1. ~~Merge #50 → #51~~ (**hecho**, `main@6373e19`). 2. R10. 3. R11. 4. R12. 5. (VM108) R6.2/R9-A + R7-A operativo.
