# R13.1 · Runtime Inspector

> Implementado en la rama `feature/r13-1-engine-runtime-quality`, **sin mergear**. Verificado
> leyendo directamente `apps/arena-engine/src/inspector.ts`, `apps/arena-engine/src/cli.ts` y
> `apps/arena-engine/tests/inspector.test.ts`. Plan original en `docs/R13_ENGINE_RUNTIME_QUALITY.md`
> §2; este documento describe lo que **existe de verdad** en código.

## Qué es

Un servidor HTTP de **solo lectura**, construido con `node:http` (fuera de `src/sim/`, donde el
linter de determinismo prohíbe reloj de pared e I/O), que expone dos rutas: `/health` y
`/snapshot`. Sirve exclusivamente lo que ya devuelve `Battle.getPublicSnapshot()` — el mismo
snapshot público que usan replays y el protocolo de bots. No expone ninguna ruta de escritura, no
acepta comandos, no modifica el estado de la batalla.

Off por defecto: solo arranca si se pasa `--inspect` en la CLI.

## Cómo activarlo

```bash
# Inspector con puerto efímero (el SO elige uno libre), bind 127.0.0.1
npx tsx apps/arena-engine/src/cli.ts run --inspect

# Puerto e interfaz explícitos
npx tsx apps/arena-engine/src/cli.ts run --inspect --inspect-host 127.0.0.1 --inspect-port 8090

# Cámara lenta (0.1×) sin inspector
npx tsx apps/arena-engine/src/cli.ts run --speed 0.1

# Cámara lenta + inspector a la vez, para depurar visualmente en vivo
npx tsx apps/arena-engine/src/cli.ts run --inspect --speed 0.25
```

Al arrancar con `--inspect`, la CLI imprime la URL real:

```
  inspector escuchando en http://127.0.0.1:53214
```

**Incompatibilidad**: `--inspect` y `--speed` son incompatibles con `--out` (grabación de replay).
La CLI lanza error si se combinan:

```
error: --inspect y --speed no son compatibles con --out (grabación de replay)
```

## Contrato de endpoints

Solo `GET` y `HEAD`. Cualquier otro método (`POST`, `PUT`, `DELETE`, `PATCH`, …) devuelve `405` con
cabecera `Allow: GET`. Cualquier ruta que no sea `/health` o `/snapshot` devuelve `404`.

### `GET /health`

```json
{ "ok": true, "tick": 137, "uptimeMs": 4521 }
```

- `tick`: tick actual de la batalla (`battle.tick`).
- `uptimeMs`: milisegundos de reloj de pared desde que se creó el inspector.

### `GET /snapshot`

Devuelve exactamente `battle.getPublicSnapshot()` serializado a JSON, sin transformación:

```json
{
  "tick": 137,
  "vehicles": [
    {
      "id": "veh_1",
      "team": "red",
      "alive": true,
      "position": { "x": 12.5, "y": -3.2 },
      "heading": 1.047198,
      "turretHeading": 0.523599,
      "hullHp": 82.5,
      "hullHpMax": 100,
      "carryingFlag": false,
      "juggernaut": false,
      "modules": [{ "slot": "weapon_primary", "state": "ready" }]
    }
  ],
  "projectiles": [{ "id": "proj_42", "position": { "x": 14.1, "y": -2.9 } }],
  "score": { "red": 3, "blue": 1 },
  "objectives": []
}
```

Campos numéricos de posición/heading/hp redondeados a 6 decimales (`round6`), igual que el resto
del snapshot público del motor.

### Respuestas de error

| Caso | Status | Body |
|---|---|---|
| Ruta desconocida | `404` | `{ "error": "not_found" }` |
| Método distinto de GET/HEAD | `405` (cabecera `Allow: GET`) | `{ "error": "method_not_allowed" }` |

`HEAD` en `/health` o `/snapshot` responde con los mismos códigos y cabeceras que `GET` pero sin
cuerpo.

## Garantías de seguridad

- **Solo lectura**: no existe ninguna ruta que mute el estado del motor, ni acepte comandos de
  bots, ni controle la batalla (pausar, avanzar tick, terminar, etc.).
- **Bind local por defecto**: `127.0.0.1`, salvo que se pase explícitamente `--inspect-host` con
  otra interfaz. No hay autenticación — pensado para depuración en la misma máquina.
- **Sin estado privado**: el snapshot servido es idéntico a `battle.getPublicSnapshot()`, el mismo
  que ya consumen replays y el protocolo de bots. El test `inspector.test.ts` comprueba
  explícitamente que la respuesta serializada **no contiene** las claves `seed`, `rng`, `mines`,
  `velocity` ni `energyEU`. Las minas nunca se incluyen en el snapshot público (información oculta
  hasta que explotan); el propio `battle.ts` lo documenta así en `publicSnapshot()`.
- **Sin referencia mutable**: cada petición construye el snapshot en el momento (`battle.tick`,
  `battle.getPublicSnapshot()`); no hay caché ni handle sobre el estado interno vivo del motor.
- **Cierre limpio**: `inspector.close()` destruye todos los sockets abiertos (incluidos
  keep-alive) y cierra el servidor antes de resolver, para no dejar handles colgados al terminar
  el proceso. Cubierto por test (`close() deja el puerto cerrado y no hay handles colgados`).

## Semántica exacta de `--speed`

`--speed <n>` (`n` numérico finito y `> 0`) solo afecta a la **cadencia de reloj de pared** con la
que la CLI ejecuta `battle.step()` en el bucle `runPaced()` de `cli.ts`:

```
tickIntervalMs = (TICK_DT * 1000) / speed
```

- **No toca** `TICK_DT` (la constante de tick lógico del motor), ni el orden ni el contenido de
  las llamadas a `battle.step()`, ni el RNG, ni el cálculo de `stateHash()`.
- El determinismo queda intacto: el test `determinismo con pacing tick a tick` corre la misma
  semilla en modo normal (`battle.run()`) y en modo paced tick a tick, y comprueba que
  `finalStateHash` y `ticks` coinciden exactamente.
- `--speed` sin `--inspect` simplemente ralentiza (o acelera) la ejecución en tiempo real, sin
  servir nada por HTTP.
- `--inspect` sin `--speed` corre a ritmo real (1×) para que el inspector tenga ocasión de
  responder peticiones mientras la batalla avanza; con `--speed` explícito, usa ese valor.
- Un `--speed` inválido (no numérico, no finito, o `<= 0`) hace que la CLI falle con error antes
  de arrancar la batalla.

## Límites conocidos

- **Sin autenticación ni autorización**: pensado exclusivamente para uso local/depuración. No
  desplegar con bind distinto de `127.0.0.1` fuera de un entorno de confianza.
- **Sin streaming**: no hay WebSocket, SSE ni WebRTC. `/snapshot` es una foto puntual por petición;
  para observar la evolución hay que sondear (`polling`) repitiendo la petición.
- **Sin historial**: no expone snapshots pasados, solo el estado actual del motor en el instante
  de la petición.
- **Sin control remoto**: no se puede pausar, acelerar, ni enviar comandos a la batalla vía HTTP.
- **Sin persistencia**: nada de lo que sirve el inspector se guarda en disco ni en base de datos.
- **Incompatible con `--out`**: no se puede grabar replay y usar el inspector/`--speed` en la
  misma ejecución.

## Qué queda para R11 / R13.2

- **R11 (spectator público)**: un canal de observación en tiempo real para usuarios externos
  (WebSocket/streaming, UI, gateado por diseño propio) es un bloque **distinto** y **no
  implementado** por R13.1. El inspector de R13.1 es una herramienta de depuración local vía
  polling HTTP, no la base de un producto de espectadores.
- **R13.2 (métricas Prometheus)**: un endpoint `/metrics` con contadores/histogramas
  (`arena_ticks_total`, `arena_tick_duration_ms`, etc.) sigue **pendiente**; no existe en este
  bloque. Ver `docs/R13_ENGINE_RUNTIME_QUALITY.md` §3 para el diseño propuesto.
