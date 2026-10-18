# Funciones pendientes — S9 AI Arena

## Resumen

Este documento recoge lo que **no existe todavía** en el producto y está previsto. Reúne el
contenido vigente de los antiguos `ROADMAP.md`, `BACKLOG_POST_PROGRAMA.md` y
`NEXT_PHASE_R10_R11_R12.md`, archivados en `docs/history/`, más los gates de los Carriles I y J.
Cada elemento se ha comprobado contra el código de `27f70bb`, para no listar como pendiente algo
que ya exista.

Categorías:
- **DISEÑADA, NO IMPLEMENTADA:** hay un documento de diseño y no hay código.
- **MEJORA PREVISTA:** hay piezas en el código y falta completarla o activarla.
- **IDEA:** sin diseño.
- **DESCARTADA:** decisión registrada de no hacerla. Se lista para que nadie la reabra por error.

Lo que está roto **no** es una función pendiente: es deuda y está en [technical-debt.md](technical-debt.md).

## Índice

- [Diseñadas, no implementadas](#diseñadas-no-implementadas)
- [Mejoras previstas](#mejoras-previstas)
- [Ideas](#ideas)
- [Descartadas por decisión](#descartadas-por-decisión)
- [Reglas que siguen vigentes](#reglas-que-siguen-vigentes)
- [Verificación](#verificación)

## Diseñadas, no implementadas

| Función | Diseño | Comprobado que no existe | Depende de |
|---|---|---|---|
| **prepare-battle** desde un match de torneo (puente match → batalla preparada) | `docs/history/disenos/R12_PREPARE_BATTLE_MATCHMAKING.md` §1 | no hay operación en `apps/api/openapi.yaml` (`grep prepare` vacío) | TD-001, TD-002 |
| **Matchmaking** (tickets, estados, `#/matchmaking`) | mismo documento, §2 | no hay tabla en `apps/api/src/db/migrations.ts` ni operación en el contrato | prepare-battle |
| **Autorización proporcional en `/run`** (sólo el dueño o un rol ≥ moderador; gate I-9) | `docs/history/disenos/CARRIL_I_EXECUTION_GATE.md` §8 | `runBattle` sigue con `x-min-role: user` | TD-002 |
| **Cierre del ciclo de vida en el camino real** (gate I-8: `finished`, hashes, `replay_ref` y `battle_stats` desde la API) | mismo documento, §8 | el launcher no escribe el cierre (`battles.ts:735-739`) | TD-002 |
| **Gobernanza de lectura anónima de replays**, con candado de superficie | `docs/history/disenos/CARRIL_J_GATE_SPECTATOR.md` §6.b | sólo en una rama remota sin integrar; nada en `main` | TD-004 |

## Mejoras previstas

| Mejora | Qué existe hoy | Qué falta | Deuda / gate |
|---|---|---|---|
| Guardado del editor de mapas | API `saveMapDraft` (`x-min-role: user`) | que la web lo use, reabrir y duplicar | [TD-010](technical-debt.md#td-010) |
| Ejecución real de batallas en producción | implementada e integrada: el `tournament-worker` ejecuta el artefacto firmado de cada bot (cierre funcional) | desplegar el compose de la integración con su gate (proxy del host, clave pública) | [TD-002](technical-debt.md#td-002) · [current-status.md](current-status.md#blocked) |
| Espectador público | capability `S9_PUBLIC_SPECTATE_ENABLED` (apagada), `#/live`, `GET /public/battles/live` | gate del Carril J; TD-009 y TD-028 | [TD-028](technical-debt.md#td-028) |
| Replays públicos | capability `S9_PUBLIC_REPLAYS_ENABLED` (apagada) | coherencia con el borde (TD-004) | [TD-004](technical-debt.md#td-004) |
| Auto-run real de torneos y batallas desde la UI | ninguna pieza activa | bloqueado: requiere autorización del operador y validación en el host | — |
| Observabilidad con alertas | perfil compose `observability` (Prometheus, Alertmanager, Grafana, Loki, Promtail y exporters); métricas de la API tras `S9_METRICS_ENABLED` (apagada) | desplegar el perfil y la alerta del backup | [TD-007](technical-debt.md#td-007) |
| Streaming a plataformas (RTMPS) | servicio `streamer` (perfil `streaming`) y `BroadcastPage` | no desplegado; la página de emisión comparte el defecto de TD-009 | [TD-009](technical-debt.md#td-009) |
| 2FA y gestión de sesiones en la web | operaciones de API (`enable2fa`, `listSessions`, `revokeSession`) | pantallas web | [TD-012](technical-debt.md#td-012) |
| Recuperación de cuenta con canal | `POST /auth/recover` crea el token; `POST /auth/reset` lo consume | canal de entrega (email) y UI | [TD-012](technical-debt.md#td-012) |
| Formatos de torneo `league`, eliminación simple/doble, `swiss`, `teams` | generadores en `apps/tournament-worker/src/formats.ts` | `teams` es inalcanzable (TD-011); en la web sólo está verificado `round_robin` | [TD-011](technical-debt.md#td-011) |
| Administración web de operación (sólo lectura) | CLI de readiness y drift; scripts del host | vistas web | [TD-023](technical-debt.md#td-023) |
| Fases visuales posteriores a R16.3 | atlas procedural actual | alcance por fijar | — |

## Ideas

- **SDK .NET y SDK Java:** `sdks/dotnet` y `sdks/java` sólo contienen un README de plantilla ("post-MVP"). Los SDK reales son JavaScript y Python.
- **Decidir el futuro de `map-service`:** retirarlo o hacerlo autoridad de mapas. Ver [TD-017](technical-debt.md#td-017).
- **Guía de onboarding** en la web, con enlace al SDK. Ver [TD-022](technical-debt.md#td-022).

## Descartadas por decisión

| Función | Decisión | Dónde |
|---|---|---|
| WebRTC para espectadores | no se implementa; la alternativa es el fan-out por el gateway WS. Se reabre sólo con demanda medida y autorización de infraestructura | `docs/adr/ADR-R14-webrtc.md` |
| Sharding intra-batalla | rechazado; el sharding es inter-batalla por `battleId` | `docs/history/disenos/R13_5_SAVE_SHARDING.md` |
| Calor y recarga de armas | fuera del modelo por decisión fundacional | `docs/adr/ADR-000-decisiones-fundacionales.md` |
| Actualizar Rapier directamente | prohibido; sólo una rama de evaluación con golden replays | `docs/history/disenos/R13_ENGINE_RUNTIME_QUALITY.md` |

## Reglas que siguen vigentes

Estas reglas vienen del roadmap anterior y siguen aplicándose a toda función nueva:

- Las funciones experimentales están **apagadas por defecto** y se activan con su gate.
- Ningún servicio monta `docker.sock` ni corre `privileged`. El código no confiable sólo se ejecuta en contenedores aislados, a través del proxy Docker del host.
- No se declara terminado lo que sólo está diseñado. En la documentación, lo diseñado se marca DESIGN_ONLY.
- Un bloque funcional por PR, con tests y mutaciones de no-vacuidad.

## Documentación relacionada

- [current-status.md](current-status.md) · [technical-debt.md](technical-debt.md)
- [docs/technical/battles.md](../technical/battles.md) · [docs/technical/tournaments.md](../technical/tournaments.md)
- [docs/adr/](../adr/)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| prepare-battle no existe | CODE_VERIFIED | `grep -n prepare apps/api/openapi.yaml` (vacío) |
| matchmaking no existe | CODE_VERIFIED | `grep -n matchmaking apps/api/openapi.yaml apps/api/src/db/migrations.ts` (vacío) |
| `saveMapDraft` existe | CODE_VERIFIED | `apps/api/openapi.yaml:518-520` |
| El editor no lo usa | CODE_VERIFIED | `apps/web/src/pages/MapEditorPage.tsx:14-16` |
| Recuperación sin canal | CODE_VERIFIED | `apps/api/src/routes/auth.ts:384-410` (crea el token; no lo envía) |
| Formatos de torneo en código | CODE_VERIFIED | `apps/tournament-worker/src/formats.ts:423-441` |
| SDK .NET/Java vacíos | CODE_VERIFIED | `sdks/dotnet/README.md`, `sdks/java/README.md` |
| Perfil `observability` | CODE_VERIFIED | `infrastructure/docker-compose.yml` (servicios prometheus…postgres-exporter) |
| Diseños citados | DESIGN_ONLY | documentos de diseño archivados |
