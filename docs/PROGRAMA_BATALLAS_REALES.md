# Programa · Ejecución real de batallas (R6.2/R9 → A)

Cierra el último hueco entre "la plataforma está desplegada" y "se puede lanzar una
batalla". Arranca sobre `main@f66ddb7`, con la instancia de VM108 ya poblada
(catálogo, ruleset, mapa y nueve bots en tres equipos).

## Estado de partida (auditado, no supuesto)

**Ya existe y funciona:**

| Pieza | Estado |
|---|---|
| `s9-docker-proxy` (allowlist, host-only) | activo en VM108, escuchando en `172.17.0.1:2375` |
| Red Docker `arena` | creada, nombre exacto exigido por `compliance.mjs` |
| Imágenes de runtime de bots (python/node) y `s9-smoke-bot` | construidas |
| Orquestador `runContainerBattle()` + `ProtocolServer` + `ProxyContainerRunner` | implementados y probados en CI con runner mock |
| Endpoint `POST /battles/{id}/run` + botón de UI | implementados y gateados |
| Los 3 bugs del intento de 2026-07-18 (seccomp, nombre de red, digest) | corregidos y mergeados |

**Lo que falta**, y que este programa cubre:

1. **El servicio `arena-engine` no existe como servicio.** Su `SERVICE_ENTRY` apunta a
   `apps/arena-engine/src/cli.ts`, un CLI que ejecuta y termina — por eso el contenedor
   queda en `Restarting (0)`. Su healthcheck espera un `/healthz` en el puerto 8081 que
   nadie sirve. El comentario del Compose lo reconoce: `PENDIENTE (E2/E9)`.
2. **El launcher no está implementado.** `BattleRunLauncher` (`apps/api/src/battle-run.ts`)
   es solo una interfaz; ningún fichero la implementa, así que el endpoint responde
   `503 runner_unavailable` incluso con la flag encendida.
3. **Los bots no están firmados.** Los nueve creados están en `draft`; el endpoint exige
   `bot_not_ready`/`bot_not_signed` con `artifact_hash` real.
4. **Validación operativa nunca ejecutada.** Sería la primera vez que se ejecuta código no
   confiable con Docker real en el servidor.

## Decisión de arquitectura

`arena-engine` **ya está en la red `arena`** y su hostname (`arena-engine`) es exactamente
el `ENGINE_HOST` por defecto que asumen el arnés y la documentación. Es, por tanto, el
sitio natural del `ProtocolServer`: los contenedores de los bots lo alcanzan por esa red
interna sin Internet.

`bot-manager` **no** está en la red `arena` (solo `platform` y `build`), así que no puede
hospedar el `ProtocolServer` sin cambiar la topología de red. Se descarta.

Cadena resultante, sin que la API toque Docker jamás:

```
API  --HTTP(platform)-->  arena-engine  --HTTP-->  s9-docker-proxy  -->  contenedores de bots
                              |                                              (red arena)
                              +-- ProtocolServer (WebSocket, red arena) <-----+
```

## Bloques

Un bloque por PR. Cada uno: auditoría → diseño mínimo → rama y worktree propios →
implementación → tests → **mutaciones de no-vacuidad** → **Supervisor independiente**
(nunca supervisa su propia PR) → corrección de observaciones → CI verde → merge sin
bypass → CI post-merge → checkpoint.

| # | Bloque | Alcance | Toca producción |
|---|---|---|---|
| **B1** | Servicio `arena-engine` | Entrypoint HTTP real: `/healthz` + endpoint interno de ejecución. Runner **inyectado**; por defecto ninguno. Arregla el `Restarting (0)`. | no |
| **B2** | Launcher cableado | `ProxyContainerRunner` real en el servicio (gateado por env) + implementación de `BattleRunLauncher` en la API que habla con `arena-engine` por HTTP, e inyección en `createApp`. Flag sigue **off**. | no |
| **B3** | Bots firmados | Llevar los bots de `draft` a `published` con `artifact_hash` real por el pipeline de bot-manager. Sin saltarse la sandbox. | no |
| **B4** | Validación operativa | Ejecución real en VM108: snapshot previo, rechazos del proxy verificados en vivo, batalla smoke con contenedores reales, replay verificable. | **sí — requiere autorización explícita** |

## Invariantes (no negociables)

- La API **no** habla con Docker, no monta `docker.sock`, no usa `privileged` ni
  `network_mode: host`. Todo pasa por el proxy con allowlist.
- Nada de `docker compose down -v`, `docker system prune` ni borrado de volúmenes.
- No se falsean tests con skips, allowlists ni catches vacíos.
- No se marcan bots como validados a mano: la sandbox no se salta.
- Las flags sensibles (`S9_ENABLE_REAL_BATTLE_RUNS`, `S9_PUBLIC_SPECTATE_ENABLED`) siguen
  apagadas hasta B4, y su activación es decisión del operador.
- **B4 no se ejecuta sin autorización explícita**: es la primera ejecución de código no
  confiable con Docker real.

## Criterio de cierre

B1–B3 mergeados con CI verde, Supervisor conforme y mutaciones demostradas. B4 produce
evidencia real (dos contenedores, batalla terminada, replay que `verify()` reproduce bit a
bit, contenedores limpiados, núcleo sano) o un dictamen honesto de por qué no.
