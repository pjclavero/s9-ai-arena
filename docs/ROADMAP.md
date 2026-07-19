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
- **#52 dossier R10/R11/R12** — planificación (solo docs). **Mergeada** (CI verde).
- **#55 R13.0 Engine Regression Locks** — 3 ficheros de test (radio/acoustic/ammo/respawn/determinismo),
  15 candados, solo tests. **Mergeada** (`main@1fc8cee`, CI verde).
- **#53 R10 slice 1** — editor visual de mapas (foundation, **solo cliente**: SVG, CRUD add/select/
  mover/eliminar, validación cliente, import/export JSON). **Mergeada** (`main@bd26b0b`, CI verde).

## PRs activas

- Ninguna del plan multiequipo. **#41** (smoke-battle E2E, diseño rival) **cerrada como superseded**
  (cubierta por #42/#43/#44 en main; sin código exclusivo útil).

## Orden de trabajo (secuencia acordada 2026-07-19)

### Ahora

1. ~~#50 R7-A~~ — **hecho** (en main).
2. ~~#51 R6.2/R9-B~~ — **hecho** (en main).
3. ~~#52 dossier R10/R11/R12~~ — **hecho** (en main).
4. ~~**R13.0 — Engine Regression Locks**~~ ✅ **MERGED** (#55, `main@1fc8cee`): 3 ficheros de test
   (radio/acoustic/ammo), 15 candados verdes, **solo tests** (cero cambios de motor), determinismo
   intacto. Los tres fallos ya estaban corregidos en código; R13.0 los blinda. Ver
   `docs/ENGINE_REGRESSION_LOCKS.md`.

### Después

5. ~~**R10 — Editor visual de mapas**~~ **Slice 1 MERGED** (#53, `main@bd26b0b`): editor solo cliente
   (`#/maps/editor`, SVG, CRUD, validación, import/export JSON). Slice 2 pendiente (persistencia
   backend: endpoint de draft + validación map-service). Ver `docs/R10_MAP_EDITOR_SLICE1.md`.
6. **R13.1 — Inspector de estado + slow motion** — **mergeado en main (PR #59)**: inspector HTTP
   read-only (`--inspect`) y `--speed` (solo cadencia de pared, determinismo intacto). Ver
   `docs/R13_1_RUNTIME_INSPECTOR.md`.
7. **R11 — Spectator público interno** — **slice mínimo implementado**
   (`feature/r11-spectator`): `GET /public/battles/live` (contrato 0.4.0, 59 ops) +
   página `#/live`, capability `S9_PUBLIC_SPECTATE_ENABLED` apagada por defecto, reutiliza el
   gateway WS de espectador existente (sin WS nuevo, sin WebRTC). Sin estado público por batalla
   ni alias de replays todavía. Ver `docs/R11_SPECTATOR.md`. **Dependía de R7-A (#50, ya en
   main)**.
8. **R13.2 — Hardening runtime/espectador** — **implementado**
   (`feature/r13-2-runtime-spectator-hardening`): cuota anónima en `GET /public/battles/live`
   (cierra el TODO de R11), timeouts/maxConnections/no-store + opt-in `--inspect-allow-remote`
   en el inspector R13.1, `maxPayload` y tope de conexiones por batalla en el gateway WS,
   candados de regresión (ticket caducado, URLs raras). Ver `docs/R13_2_HARDENING.md`.
   **Nota**: la etiqueta original "Métricas Prometheus" queda como slice futuro independiente
   (no implementado en este bloque).
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
