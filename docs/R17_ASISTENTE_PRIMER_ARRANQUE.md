# R17 · Asistente de primer arranque

Qué es: un recorrido ordenado por los trece dominios de los que depende una
instalación, que responde "¿qué me falta y por qué?" con **efecto observado**,
no con colores. Vive en `packages/first-run/` y consume el motor de readiness
de `packages/readiness/`.

## Cuatro capas, sin mezclar

```
configuration  →  evidence  →  readiness  →  activation
```

- **configuration**: qué se declara (modelo de claves, `packages/readiness/config.ts`).
- **evidence**: sondas que adquieren hechos. No deciden.
- **readiness**: decide con esos hechos. No adquiere.
- **activation**: acto explícito y separado (`activation.ts`). Nunca es
  consecuencia automática de que algo salga verde.

## Los trece dominios

| # | Dominio | Se satisface demostrando |
|---|---|---|
| 1 | Sistema | La imagen en ejecución existe en el daemon y viene del commit que declara |
| 2 | Administrador | Hay identidad administrativa y no procede de credenciales del repo |
| 3 | Base de datos | La consulta se ejecutó y vio el canario |
| 4 | Almacenamiento | El proceso escribió y releyó en el directorio de datos |
| 5 | Almacenamiento de bots | Ídem en el árbol de bots, diciendo con qué uid/gid |
| 6 | Almacenamiento de replays | Ídem en el árbol de replays |
| 7 | Copias | La ÚLTIMA ejecución terminó bien, escribió bytes y no es rancia |
| 8 | Restauración | Un simulacro devolvió bytes y el canario |
| 9 | Seguridad | El secreto está montado y legible dentro del proceso |
| 10 | Ejecución | La puerta está APAGADA en entorno y en runtime |
| 11 | Spectator | La puerta está APAGADA en entorno y en runtime |
| 12 | Preflight | La configuración declarada no tiene errores |
| 13 | Readiness | Todo lo anterior, sin lagunas sin declarar |

Un dominio cuyos requisitos no están satisfechos queda `blocked` **aunque su
propia evidencia esté verde**: no se da por terminado un piso sobre cimientos
sin demostrar.

## Las siete confusiones, como comprobaciones

Cada una se observó de verdad en este proyecto y está en `confusions.ts` con la
pregunta que hay que responder y la trampa que hace que una comprobación
ingenua salga verde:

| Confusión | Pregunta que exige el asistente |
|---|---|
| HEALTHY != READY | ¿El trabajo que justifica el servicio se ejecutó y produjo efecto? |
| BACKED_UP != RECOVERY_VERIFIED | ¿Un simulacro devolvió bytes **y** el canario? |
| TAG != DEPLOYED VERSION | ¿La image ID en ejecución existe y viene del commit declarado? |
| SECRET EXISTS != SECRET MOUNTED | ¿El proceso lee bytes del secreto en su propio montaje? |
| STORAGE EXISTS != STORAGE WRITABLE | ¿Qué **proceso** (uid/gid) escribió, releyó y obtuvo lo mismo? |
| PROCESS ALIVE != JOB SUCCESS | ¿Código de salida y efecto de la **última** ejecución? |
| COMMAND EXIT 0 != EFFECT VERIFIED | ¿Magnitud del efecto (filas, bytes), distinguida de cero? |

`CHECK_COVERAGE` (en `domains.ts`) dice qué comprobación cubre qué confusión.
Una comprobación que el asistente no conoce **no cubre nada**: ese es el defecto
seguro, y permite que otros carriles añadan comprobaciones sin tocar este
código. Si una confusión no la cubre ninguna comprobación **verificada**, el
veredicto no puede ser READY, aunque ningún dominio esté en rojo.

## Nada se aprueba por omisión

- Comprobación ausente del informe → `unknown` (y se lista en `missingChecks`).
- `not_exercised` → `unknown`. Un "skipped" nunca es un aprobado.
- Excepción en una sonda → `not_exercised`, nunca "saltada".
- Cada comprobación declara `proves` y `doesNotProve`.

## Activación: qué hace falta, y qué no basta

`requestActivation()` **decide y deja traza; no aplica nada**. Rechaza en este
orden:

1. `gate_blocked_by_operator` — hoy `S9_ENABLE_REAL_BATTLE_RUNS` y
   `S9_PUBLIC_SPECTATE_ENABLED` están BLOQUEADAS por decisión del operador.
   Ninguna combinación de verdes las concede, y esto se comprueba **antes** de
   mirar readiness.
2. `gate_unknown` — no se activa lo que no está modelado.
3. `no_explicit_act` — hacen falta actor, motivo y la frase exacta
   `ACTIVAR <PUERTA> CON RESPONSABILIDAD DEL OPERADOR`.
4. `not_ready` — el verde es necesario, nunca suficiente.
5. `stale_evidence` — evidencia de más de 60 min no sostiene una activación.

## Calibración

`node scripts/r17-first-run-mutants.mjs` muta el **código de producción** (no
las sondas) y exige que la suite se ponga roja con cada mutación: quitar el
bloqueo de puertas, aprobar sin saber qué proceso escribió, aceptar cero bytes
como "escribible", ignorar los errores de configuración… Una comprobación que
no puede fallar no es una comprobación.
