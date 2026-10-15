# Backlog post-programa — Programa de continuación

**Estado: COMPLETADO — 7/7 ítems ejecutables con GATE-PASS (PRs #68–#74).** Veredicto
global: **PROGRAMA-A**. Arrancó sobre `main@11048d6` (cierre del programa de 9 bloques,
`docs/PROGRAMA_9_BLOQUES.md`); main al cierre: `8755c24`. Ejecutado con las mismas
mecánicas: Organizador/Director, implementadores especialistas, **Supervisor
independiente** (nunca supervisa su propia PR) y control de calidad, un ítem por rama/PR,
puerta entre bloques, merge automático con CI verde + Supervisor CONFORME.

## Resultado por bloque

| # | Ítem | Dictamen | PR | Merge en main |
|---|---|---|---|---|
| N1 | Métricas Prometheus (API) | GATE-PASS | [#68](https://github.com/pjclavero/s9-ai-arena/pull/68) | `3383cd1` |
| N2 | Latencia simulada (motor) | GATE-PASS | [#69](https://github.com/pjclavero/s9-ai-arena/pull/69) | `7294fb4` |
| N3 | R13.5 slice 2 — spike Rapier | GATE-PASS (dictamen: viable, no implementar) | [#70](https://github.com/pjclavero/s9-ai-arena/pull/70) | `1501a15` |
| N4 | R10 slice 2 — borrador de mapas | GATE-PASS | [#71](https://github.com/pjclavero/s9-ai-arena/pull/71) | `a900fe7` |
| N5 | R11 — estado público por batalla | GATE-PASS | [#72](https://github.com/pjclavero/s9-ai-arena/pull/72) | `2f603cb` |
| N6 | R12 — `#/ranking` + diseño matchmaking | GATE-PASS | [#73](https://github.com/pjclavero/s9-ai-arena/pull/73) | `b8eac1f` |
| N7 | R16.3 — panel táctico del HUD | GATE-PASS | [#74](https://github.com/pjclavero/s9-ai-arena/pull/74) | `8755c24` |

Cada bloque llevó Supervisor independiente (6× SUPERVISOR-CONFORME, incluidos los que
recogieron observaciones no bloqueantes antes del merge) y CI post-merge verde. Defectos
reales cazados por el ciclo antes de mergear: un byte NUL espurio que hacía binario un
fichero fuente (N1), un bug de propagación de la cabecera de replay que rompía `verify()`
con latencia activada (N2, corregido por el propio implementador), y varios huecos de
cobertura de mutación cerrados con tests reforzados (N1, N2, N6). El único fallo de CI del
programa (N7) fue un timeout transitorio de Docker Hub ajeno al cambio, resuelto con
rerun; **ninguna CI roja se mergeó**.

### Mecánicas (referencia)

Cada bloque sigue el ciclo del programa anterior: auditoría de `main` → diseño mínimo →
rama y worktree propios desde main fresco → implementación → tests → **mutaciones de
no-vacuidad** → Supervisor independiente → corrección de observaciones → PR con CI verde →
merge sin bypass → CI post-merge verde → checkpoint → siguiente. Un bloque por PR, nunca
mezclados. Se respetan todas las invariantes (sin tocar VM108/VM104, sin desplegar, sin
abrir puertos, sin `privileged`/`network_mode: host`/`docker.sock`, sin falsear tests).

## Orden de ejecución (ítems ejecutables) — plan original

Todos completados; ver "Resultado por bloque" arriba para el dictamen y el merge.

| # | Ítem | Naturaleza | Estado |
|---|---|---|---|
| N1 | Métricas Prometheus (observabilidad) | endpoint off por defecto | ✅ hecho |
| N2 | Latencia simulada | motor, sin alterar tick lógico | ✅ hecho |
| N3 | R13.5 slice 2 — spike snapshot Rapier | investigación (gate del propio slice) | ✅ hecho (dictamen) |
| N4 | R10 slice 2 — persistencia backend del editor de mapas | endpoint + validación | ✅ hecho |
| N5 | R11 — estado público por batalla (solo lectura) | API + UI, gateado por flag | ✅ hecho |
| N6 | R12 — `#/ranking` (solo lectura) + diseño prepare-battle | lectura + diseño | ✅ hecho |
| N7 | R16.3+ — siguiente fase visual | procedural, sin assets/CDN | ✅ hecho |

### N1 · Métricas Prometheus
Etiqueta original de R13.2 nunca implementada (`docs/R13_2_HARDENING.md` la dejó como
slice futuro). Endpoint de observabilidad `/metrics` en formato texto Prometheus, **off
por defecto** (flag), sin cardinalidad de usuario, sin secretos. No altera el motor.

### N2 · Latencia simulada
Simulación opcional de latencia/pérdida de comandos para pruebas de robustez de bots.
**Restricción dura**: no altera el tick lógico ni el hash canónico — la latencia es una
capa sobre la entrega de comandos, determinista y sembrada, no un reloj de pared. Off por
defecto.

### N3 · R13.5 slice 2 — spike de snapshot nativo de Rapier
El slice 1 (checkpoint por resimulación) ya está en main. El slice 2 (serialización
nativa `takeSnapshot()/restoreSnapshot()`) estaba **gateado a un spike** que demuestre
que `solverFingerprint()` se reproduce bit-exacto tras `restoreSnapshot()`. Este bloque
ejecuta ESE spike y reporta: si es bit-exacto, se implementa el slice 2; si no, se
documenta el resultado negativo y el slice 2 queda cerrado. No se promete el resultado.

### N4 · R10 slice 2 — persistencia backend del editor de mapas
El editor de mapas (R10 slice 1) es solo cliente. Este bloque añade el backend:
endpoint de borrador de mapa + validación en map-service. Sin auto-publicación.

### N5 · R11 — estado público por batalla (solo lectura)
Continuación de R11: exponer estado público por batalla, reutilizando el gateway WS
existente, gateado por la flag existente `S9_PUBLIC_SPECTATE_ENABLED` (off por defecto).
Solo lectura. El auto-run real sigue fuera de alcance (ver bloqueados).

### N6 · R12 — `#/ranking` (solo lectura) + diseño de prepare-battle
Página `#/ranking` de solo lectura sobre datos ya disponibles + **documento de diseño**
de prepare-battle/matchmaking. La ejecución real de prepare-battle NO se implementa aquí:
depende de la validación en VM108 (ver bloqueados).

### N7 · R16.3+ — siguiente fase visual
Siguiente fase del upgrade visual, procedural dentro del atlas existente, sin assets
binarios, sin deps nuevas, sin CDN, sin `Math.random`. Alcance concreto a fijar en la
auditoría del bloque.

## Bloqueados (NO se ejecutan — requieren autorización o rompen reglas duras)

**Respetados durante todo el programa: ninguno se ejecutó.** Siguen pendientes de una
autorización explícita y separada del operador.

- **Auto-run real de R11/R12 (torneos/batallas desde UI)** — gateado a validación en
  **VM108**. Regla dura: no se toca VM108 sin autorización expresa. Las flags
  `S9_PUBLIC_SPECTATE_ENABLED` y `S9_ENABLE_REAL_BATTLE_RUNS` siguen off por defecto.
- **Upgrade directo de Rapier** — prohibido; solo rama de evaluación separada, sin merge
  (`docs/R13_ENGINE_RUNTIME_QUALITY.md`).
- **Despliegue de cualquier ítem** — ningún bloque incluye despliegue; la activación de
  flags en cualquier entorno es decisión del operador.

## Higiene (fuera del programa — requieren confirmación explícita del operador)

**No tocada durante el programa; sigue pendiente del OK del operador.**

- **9 worktrees en `/home/ia02/s9-worktrees/`** (dosier E1–E12, otro proyecto): todos en
  `main` y limpios, pero ajenos a este programa y posiblemente en uso por otras sesiones.
  No se borran sin OK explícito.
- **`package-lock.json` local sucio** en el checkout principal: marcado "no tocar"
  (ajeno). Bloquea el `git pull` del checkout local (estancado en un commit previo al
  programa); `origin/main` es la fuente de verdad y todos los worktrees ramifican de ahí,
  así que la implementación no se vio afectada.

## Criterio de éxito

Cada ítem ejecutable mergeado con CI verde, Supervisor independiente conforme, mutaciones
de no-vacuidad demostradas y sin regresión de determinismo (goldens y candados R13.0
intactos). Al cierre: veredicto global del programa de continuación y actualización de
este documento con el resultado de cada bloque.
