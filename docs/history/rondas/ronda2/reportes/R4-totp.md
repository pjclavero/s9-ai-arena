# R4 — TOTP estable bajo carga

## Síntoma

La verificación TOTP (período de 30 s) fallaba de forma intermitente cerca del
borde del período: un código generado a t≈29 s y validado 1-2 s después caía en
el paso temporal siguiente y se rechazaba. Bajo carga (latencia de red + cola de
peticiones) la probabilidad de cruzar el borde crece → "flaky".

## Causa

`otplib` v13 usa **tolerancia 0 por defecto** (`epochTolerance: 0`): solo acepta
el paso actual. Cualquier desfase de reloj o retardo entre generación y
validación superior a lo que queda de período rechaza un código legítimo.

## Corrección (`apps/api/src/auth/totp.ts`)

- Ventana **simétrica de ±1 paso** (`epochTolerance = 30 s`): se aceptan el paso
  anterior, el actual y el siguiente (`delta ∈ {-1, 0, +1}`). Es el estándar de
  facto (Google Authenticator) y la práctica RFC 6238 recomendada.
- `verifyTotpDetailed()` devuelve `{ valid, timeStep, delta }` y acepta:
  - `epoch` (segundos Unix) — **reloj inyectable** para tests deterministas.
  - `afterTimeStep` — **anti-replay**: rechaza `timeStep <= afterTimeStep`.
- `verifyTotp()` mantiene la firma booleana anterior (compatible) con la ventana ya aplicada.
- Los caminos de fallo no registran nunca el secreto ni el token.

## Tests con reloj controlado (`apps/api/src/auth/totp.test.ts`)

Ninguno usa `Date.now()`; el instante se inyecta por `epoch`. Cubren los bordes:
período anterior / actual / siguiente / fuera de ventana / borde 29→31 s /
token malformado / **replay** (mismo código con `afterTimeStep` = paso ya
consumido ⇒ rechazado) / código de período posterior sí aceptado.

## Producción — estado

- **Rate limit + bloqueo por intentos fallidos: YA en producción.** El login
  (incluido el fallo de TOTP) pasa por `FailedLoginGuard` (20 fallos ⇒ bloqueo
  temporal + `audit_log`) y `rateLimit` por IP/usuario
  (`apps/api/src/middleware/rate-limit.ts`, `routes/auth.ts`). El fallo de TOTP
  llama a `loginGuard.recordFailure`.
- **No reutilización del mismo timestep — contrato listo, wiring PENDIENTE.** La
  capacidad existe y está probada a nivel de librería (`afterTimeStep` +
  `timeStep`). Su activación en el flujo de login exige persistir el último paso
  aceptado por usuario:
  1. Migración additiva: `users.totp_last_step bigint NULL`.
  2. En el login, tras un TOTP válido: rechazar si
     `res.timeStep <= user.totp_last_step`; si pasa, `update totp_last_step`.
  No se cablea en este PR para no alterar el camino de auth desplegado sin poder
  ejecutar `test:db` (embedded-postgres, sin red en VM102). Es un cambio pequeño
  y aislado que debe validarse contra la suite de BD antes de fusionar.

## NO EJECUTADO aquí

`npm run test:db` (auth E2E con PostgreSQL embebido) requiere descarga de binario
sin red disponible en VM102. Los tests de la librería TOTP (`test:pure`) sí se
ejecutan y pasan.
