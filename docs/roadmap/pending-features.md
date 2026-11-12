# Funciones pendientes — S9 AI Arena

## Resumen

Este documento contiene sólo lo que **falta por construir, integrar o activar**. Revisado el
**2026-11-12** contra `main` `f590947`.

Reglas:

- **PARCIAL:** hay código/diseño y falta integración, activación o cierre.
- **PENDIENTE:** no existe todavía.
- **DESIGN_ONLY:** existe diseño aprobado pero no implementación.
- Lo terminado sale de esta lista y pasa al histórico.
- Lo roto se sigue en [technical-debt.md](technical-debt.md), no aquí.

## Parciales

| Función | Qué existe | Qué falta | Referencia |
|---|---|---|---|
| **Autorización de /run** | `POST /battles/{id}/run` encola trabajo de forma idempotente | restringir el encolado al dueño o moderación según la política final | TD-039 |
| **OLA 2 / hardening del motor** | MD #271, MA #272, MB #273, MC #276, MF #270 y ME #268 terminados/revisados en sus ramas | integrar en una sola rama, resolver caracterizaciones/goldens y obtener `ENGINE_HARDENING_READY=PASS` | PRs #268/#270/#271/#272/#273/#276 |
| **Espectador público** | rutas públicas, ticket WS, #274 y ajuste runtime de MG #269 | en producción está activado; conservar gate/seguridad y política efectiva | #269, #274 |
| **Replays públicos** | rutas y ajuste runtime desde la admin | activación por decisión del operador; producción sigue OFF | #269 |
| **Streaming V1** | RTMPS/YouTube real verificado, credencial sellada, relé interno, render gate, grabación, retención y administración | limitaciones de orquestación que se resuelven en Streaming V2 | [streaming.md](../operations/streaming.md) |
| **Streaming V2 / Broadcast Manager** | MS-1 #275: arquitectura, modelos, D1-D4 y plan MS-2…MS-8 | implementación: sesión/programa separados, start sincronizado, cola, handoff, OBS, replays/listas y UI unificada | PR #275 (DESIGN_ONLY) |
| **Observabilidad con alertas** | perfil compose y reglas de alerta | desplegar/ensayar el perfil completo y comprobar alertas de extremo a extremo | TD-007 |
| **2FA en la web** | API/TOTP e inicio de sesión | pantallas de activación/desactivación | TD-012 |
| **Recuperación de cuenta** | endpoints recover/reset | canal de entrega y pantallas | TD-012 |
| **Formatos de torneo** | seis formatos aceptados y scheduler | E2E de worker+API para todos y deudas específicas como CTF | TD-015, TD-070 |
| **Administración web de operación** | estado, auditoría, roles, streaming y acceso público | backup, restore, readiness, drift y otras tareas siguen en CLI | TD-023 |
| **Fases visuales posteriores** | sprites/efectos/panel de estadísticas | sonido, texturas, niebla/sombreado determinista, shaders, CDN | pospuesto |
| **Futuro de map-service** | servicio sigue en compose; código reutilizado como librería | decidir retiro o autoridad de mapas | TD-017 |

## Pendientes

| Función | Estado | Nota |
|---|---|---|
| **prepare-battle / retención pre-start** | parte de la necesidad será cubierta por MS-3 | no declarar implementado hasta que exista el StartGate/hold de Streaming V2 |
| **Matchmaking** | no existe | diseño histórico, separado de Streaming V2 |
| **Auto-run general de torneos/batallas** | no existe como función general | Streaming V2 sólo automatizará el inicio de los ítems de una emisión bajo su gate |
| **Gestión de sesiones de cuenta en web** | API existe; UI no | — |
| **SDK .NET** | plantilla | post-MVP |
| **SDK Java** | plantilla | post-MVP |

## Streaming V2: qué deberá poder hacer el usuario cuando termine

La implementación final debe permitir desde **Administración → Retransmisión**:

1. emitir una batalla suelta, preparando primero la emisión y arrancando manualmente cuando `BROADCAST_READY`;
2. emitir un torneo completo en una única sesión YouTube, con las batallas en serie y sin perder el principio;
3. cambiar/seleccionar la batalla emitida sin reiniciar necesariamente RTMP;
4. obtener una URL/fuente independiente por batalla para OBS/vMix o realización externa;
5. emitir un replay individual;
6. crear y emitir una lista de replays;
7. ver cola, estados, errores y diagnóstico en un único menú;
8. mantener las batallas retenidas si una emisión se abandona; nunca arrancarlas como efecto lateral.

Hasta que MS-2…MS-8 se integren, esta sección es **DESIGN_ONLY**.

## OLA 2: cambios que deberán reflejarse al integrarse

- replay v2 y verificación reforzada;
- una única frontera de proyección pública y ids públicos por audiencia;
- equipamiento privado por defecto en la proyección pública;
- contrato de daño sin doble aplicación HE y torreta dependiente de la montura;
- catálogo veraz: `weapon.rangeM` y `radio.rangeM` reales, campos decorativos retirados;
- lifecycle idempotente y reaper de recursos;
- actualización de caracterizaciones/goldens que representaban defectos ya corregidos.

La guía de usuario marca estos cambios como **pendientes de integración** hasta que el gate conjunto pase.

## Descartadas por decisión

Siguen vigentes las decisiones anteriores:

- WebRTC para espectadores: no se implementa salvo nueva decisión y demanda medida.
- Sharding intra-batalla: descartado; el sharding es entre batallas.
- Calor/recarga de armas: fuera del modelo fundacional.
- Actualización directa de Rapier: sólo mediante evaluación controlada con golden replays.

## Completadas (ya no son pendientes)

Además de las completadas históricas, en noviembre de 2026:

- PR #274: proxy interno de `web` para que `/broadcast` llegue a API/WS reales.
- PR #269: ajustes runtime de espectador/replays públicos desde la administración, persistentes, auditados y aplicados en caliente.
- Streaming real a YouTube validado en producción: `BATTLE_VISIBLE_ON_STREAM=PASS` (registro del operador).

El histórico completo está en [../history/status/completadas-2026-11.md](../history/status/completadas-2026-11.md).

## Reglas vigentes

- Una función diseñada no se marca como terminada.
- Features experimentales detrás de su gate/flag.
- Un bloque funcional por PR, con tests y mutantes/no-vacuidad.
- Sin `docker.sock` ni `privileged` para código no confiable.
- `main`, ramas de integración y producción son planos distintos.

## Documentación relacionada

- [Estado actual](current-status.md)
- [Problemas conocidos](known-issues.md)
- [Deuda técnica](technical-debt.md)
- [Administración](../user/administration.md)
- [Streaming operativo](../operations/streaming.md)

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| #269 está en main | CODE_VERIFIED | `main=f590947` |
| PRs OLA 2 siguen fuera de main | CODE_VERIFIED | GitHub PRs, 2026-11-12 |
| MS-1 es diseño y MS-2 no está implementado | CODE_VERIFIED | PR #275 draft |
| YouTube real funciona | REPORTADO_RUNTIME | `BATTLE_VISIBLE_ON_STREAM=PASS`, 2026-11-12 |
