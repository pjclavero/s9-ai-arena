# R13.2 · Hardening de runtime y espectador

> Implementado en la rama `feature/r13-2-runtime-spectator-hardening`. Verificado leyendo
> directamente `apps/arena-engine/src/inspector.ts`, `apps/arena-engine/src/cli.ts`,
> `apps/api/src/spectate/gateway.ts`, `apps/api/src/routes/battles.ts` y sus tests.
>
> **Nota de alcance**: el roadmap etiquetaba originalmente R13.2 como "Métricas Prometheus".
> Este bloque NO implementa métricas Prometheus — es un slice de **hardening** de las
> superficies expuestas por R13.1 (inspector) y R11 (endpoint público + gateway WS),
> priorizado tras la auditoría de esas dos entregas. La observabilidad Prometheus queda
> pendiente como slice futuro independiente.

## Qué cubre (8 elementos de la auditoría)

### 1. Cuota anónima en `GET /public/battles/live`

`docs/R11_SPECTATOR.md` dejaba como TODO explícito el rate limiting del único endpoint
público sin cuota del router. Ahora `listPublicLiveBattles` pasa por
`anonQuota(db, "public-live", quota)` (`apps/api/src/routes/battles.ts`), igual que el
resto de rutas anónimas (spectate-ticket, replay, replay-verify): por defecto 300
peticiones/hora por IP, respaldado por la tabla `api_usage`, respuesta 429 al exceder.
Sin cambios de contrato OpenAPI (siguen siendo 59 operaciones; la cuota es middleware).

### 2-3. Límites de servidor + `Cache-Control: no-store` en el inspector (R13.1)

`apps/arena-engine/src/inspector.ts`:

- `requestTimeout=10s`, `headersTimeout=12s`, `keepAliveTimeout=5s`, `maxConnections=32`
  — el inspector deja de ser un vector barato de slowloris/agotamiento de handles.
  Todos inyectables vía `createInspector()` para tests (que usan 300-500 ms).
- `connectionsCheckingInterval` se deriva del timeout más corto configurado: el default
  de Node (30 s) habría anulado en la práctica cualquier timeout menor.
- `Cache-Control: no-store` en `/health` y `/snapshot` (GET y HEAD): son snapshots
  vivos, jamás cacheables por un proxy intermedio.
- La cabecera del fichero documenta que la **ausencia de CORS y autenticación es
  deliberada** y solo aceptable porque el bind por defecto es loopback.

### 4. Opt-in explícito para host no-loopback (`--inspect-allow-remote`)

`validateInspectHost(host, allowRemote)` exportada en `apps/arena-engine/src/cli.ts`:
un `--inspect-host` que no sea `127.0.0.1`/`localhost`/`::1` sin
`--inspect-allow-remote` aborta con un error claro que explica el riesgo (servidor sin
auth escuchando en la red). Se añadió una guarda de entrypoint
(`fileURLToPath(import.meta.url) === process.argv[1]`) para poder importar el módulo en
tests sin ejecutar `main()`; el comportamiento del binario real no cambia.

### 5-6. Gateway WS: `maxPayload` y tope de conexiones por batalla

`apps/api/src/spectate/gateway.ts`:

- `maxPayload: 64 KiB` en el `WebSocketServer` propio — el canal es de solo lectura
  para el cliente, así que cualquier frame entrante grande es abuso, nunca protocolo
  legítimo; `ws` lo corta con close 1009.
- `maxClientsPerBattle` (default 100, configurable en `SpectateGatewayOptions`): la
  conexión que supera el tope recibe `close(4429, "too_many_spectators")` **antes** de
  registrarse en el feed; el jti del ticket se marca usado igualmente para que un
  ticket rechazado por saturación no sea reutilizable para amplificar el intento.

### 7-8. Candados de regresión solo-test

- Ticket caducado → `close(4401)` (candado sobre `verifySpectateTicket`, que ya era
  correcto; el candado impide regresiones).
- URLs raras contra el inspector (`//health`, `/health/`, `/HEALTH`, `/%2e%2e/…`) →
  comportamiento actual documentado por test. Nota de auditoría aceptada:
  `/%2e%2e/snapshot` responde 200 porque WHATWG URL normaliza `%2e%2e` a `..` y la
  resolución del path lo colapsa **según especificación**; no es un leak (no hay
  filesystem detrás — el pathname solo se compara contra dos rutas fijas).

## Tests y mutaciones

- `apps/arena-engine/tests/inspector.test.ts` (+4): `Cache-Control: no-store`,
  `maxConnections`, cierre por timeout de conexión ociosa, URLs raras.
- `apps/arena-engine/tests/cli-inspect-host.test.ts` (nuevo, 3): loopbacks pasan,
  no-loopback sin flag lanza error claro, con `--inspect-allow-remote` pasa.
- `apps/api/src/spectate/gateway-hardening.test.ts` (nuevo, 3, candado
  `R13.2 · REGRESSION LOCK`): frame sobredimensionado → 1009; límite por batalla →
  4429 (las conexiones previas siguen vivas); ticket con `exp` en el pasado → 4401.
- `apps/api/src/r11-public-spectate.test.ts` (+1): exceso de cuota anónima → 429.
- **7 mutaciones de no-vacuidad verificadas** (aplicar → ≥1 test falla → revertir →
  verde): quitar `anonQuota` (M1), quitar `no-store` (M2), neutralizar timeouts (M3),
  `validateInspectHost` siempre válida (M4), quitar `maxPayload` (M5), neutralizar
  `maxClientsPerBattle` (M6), aceptar tickets con `verifySpectateTicket` null (M7).

## Qué NO hace este bloque

- No implementa métricas Prometheus (etiqueta original de R13.2 en el roadmap).
- No cambia el contrato OpenAPI (59 operaciones intactas, `conformance.test.ts`).
- No toca la simulación (`src/sim/`) ni el determinismo (lint-determinism verde).
- No habilita el inspector remoto por defecto ni añade CORS/autenticación al
  inspector: solo hace explícito y opt-in lo que antes era posible en silencio.
- No despliega nada ni activa ninguna flag en ningún entorno.
