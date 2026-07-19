# S9 AI Arena — Roadmap

> Estado operativo real: `docs/ESTADO_ACTUAL.md`. Este roadmap resume hitos y el orden de trabajo.
> **Última actualización: 2026-07-19** (incorpora R13 motor/runtime, R14 WebRTC, R16 visual).

## Hecho / integrado en `main`

- **Núcleo v2** desplegado en VM108 (7 servicios), dominio `s9arena.seccionnueve.duckdns.org`.
- **Hito A**: batalla E2E real validada en VM108 con **runners containerizados** + **replay real
  verificado** (bit a bit). Pipeline seguro: bot-manager → s9-docker-proxy → red `arena` → replay-service.
- **R7** replay API/viewer/verify · **R8** admin consolidado · **R9** creación de batalla prepared/segura.
- **#50 R7-A** — ingesta operativa del replay + listado global `#/replays`. **Mergeada** (CI verde).
- **#51 R6.2/R9-B** — ejecución containerizada **gateada** desde UI (`POST /battles/:id/run`, apagado
  por defecto). **Mergeada** (CI verde) tras rebase sobre #50.
- **#52 dossier R10/R11/R12** — planificación (solo docs). **Mergeada** (CI verde). `main@e9438f9`.

## PRs activas

- **#53 R10 slice 1** — editor visual de mapas (foundation, **solo cliente**). Draft, CI verde.
- **#41** — smoke-battle E2E (otro agente). Draft.

## Orden de trabajo (secuencia acordada 2026-07-19)

### Ahora

1. ~~#50 R7-A~~ — **hecho** (en main).
2. ~~#51 R6.2/R9-B~~ — **hecho** (en main).
3. ~~#52 dossier R10/R11/R12~~ — **hecho** (en main).
4. **R13.0 — Engine Regression Locks** ⭐ **siguiente PR recomendado**. Antes de cualquier mejora
   profunda del motor: fija con tests los tres fallos críticos auditados (radio, acoustic, ammo).
   Ver `docs/ENGINE_REGRESSION_LOCKS.md`.

### Después

5. **R10 — Editor visual de mapas** (primer bloque grande tras los merges; #53 ya abre el slice 1).
6. **R13.1 — Inspector de estado + slow motion** (depuración, read-only, sin romper determinismo).
7. **R11 — Spectator público interno** (foundation, gateado). **Depende de R7-A (#50)**.
8. **R13.2 — Métricas Prometheus** (observabilidad del motor/servicios).
9. **R12 — Bracket/ranking foundation**. **Depende de #51**; auto-run/matchmaking real **además**
   de la validación VM108 (R6.2/R9-A).

### Luego (largo plazo)

10. **R16 — Visual upgrade básico** (sprites/efectos; empieza por lo básico, NO WebGL avanzado).
11. **R14 — WebRTC** (streaming P2P para espectadores). **Depende de R11 foundation**.
12. **R13.5 — Rapier evaluation** (rama separada, golden replays, comparación de `finalStateHash`).
13. **save/load, latencia simulada, sharding** — posterior por riesgo de determinismo.

## Dependencias y bloqueadores (resumen)

| Bloque | Depende de | Bloqueador duro |
|---|---|---|
| R13.0 | nada (main) | — (es el lock previo a todo lo demás del motor) |
| R10 | R8 maps (en main) | — |
| R13.1 | R13.0 recomendable | no debe alterar el tick lógico |
| R11 | R7-A (#50, en main) | flag `S9_PUBLIC_SPECTATE_ENABLED=0` |
| R13.2 | nada | — |
| R12 | #51 (en main) | **auto-run real → VM108 R6.2/R9-A** (gateado) |
| R16 | nada (puede empezar antes que R14) | rendimiento; sin CDN aún |
| R14 | **R11 foundation** + API pública read-only + modelo de eventos estable | sin abrir producción; feature flag |
| R13.5 | evaluación con golden replays | si cambia el hash ⇒ **cambio de versión física** |
| save/load · latencia · sharding | R13.0 + R13.2 | sharding: **alto riesgo de determinismo** |

## Invariantes permanentes (no negociables)

Sin `docker.sock`/`privileged`/`network_mode: host`/`seccomp=unconfined` en config productiva.
Ejecución de código no confiable siempre en contenedores aislados vía s9-docker-proxy. Firma/digest
obligatorios. Secretos nunca en el frontend; `DOCKER_PROXY_URL` jamás en frontend. Features
experimentales **off** por defecto. No abrir puertos ni cambiar dominios. VM108/VM104/runner/proxy: no tocar.

## Qué NO se debe hacer todavía

- No activar ejecución real desde UI ni auto-run real de torneos (gateado a VM108/R6.2-R9-A).
- No implementar RTMP/YouTube/Twitch (mucho después de R14).
- No adelantar R14 (WebRTC) a R11.
- No empezar R16 por WebGL avanzado/CDN; primero sprites/efectos básicos.
- No actualizar Rapier directamente; solo evaluación en rama separada (R13.5).
- No mezclar R10/R11/R12/R13/R14/R16 en una misma PR de código.
- No declarar como terminado lo que solo está diseñado.
