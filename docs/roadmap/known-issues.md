# Problemas conocidos — S9 AI Arena

## Resumen

Síntomas o limitaciones vigentes que puede notar un usuario u operador. Revisado el
**2026-11-12** contra `main` `f590947`.

No se incluyen aquí funciones que simplemente aún no existen; ésas están en
[pending-features.md](pending-features.md).

## Usuario web

| Síntoma | Estado / causa | Dónde |
|---|---|---|
| Recuperación de contraseña y gestión completa de 2FA/sesiones no están terminadas en la web | API parcial; falta UX/canal de entrega | main |
| Un torneo con una batalla fallida puede impedir el cierre normal | deuda histórica TD-015, pendiente de revalidación tras OLA 2 | main |
| CTF de torneo conserva una incompatibilidad de bandos A/B frente a red/blue | TD-070 | main |
| El filtro de replays «Abortada o con incidencia» no cubre todos los estados técnicos | TD-071 | main |
| Algunas listas de bots pueden devolver una página más corta que el límite pedido | TD-068 | main |
| Un error de filtro puede presentarse como cursor inválido | TD-067 | main |
| No hay borrado de mapas desde el producto | TD-042 | main |
| El cartel final puede mostrar «GANA RED» duplicado | REPORTADO; pendiente de reproducir y registrar con test | producción/prueba |

## Operador

| Síntoma / limitación | Estado / causa |
|---|---|
| Backup/restore/readiness/drift no están gestionados completamente desde la web | TD-023 |
| El perfil de observabilidad completo todavía requiere despliegue/ensayo | TD-007 |
| `map-service` sigue sin una decisión de producto clara | TD-017 |
| Streaming V1 no sincroniza el inicio de la batalla con `BROADCAST_READY` | diseño actual; Streaming V2/MS-3 |
| Un torneo con varias batallas simultáneas no garantiza emitirlas todas en una única salida | Streaming V2/MS-4 lo serializará cuando corresponda |
| No existen aún fuentes por batalla para OBS ni replay playlists como producto | Streaming V2/MS-6/MS-7 |

### Problemas de streaming que YA NO son vigentes

No reabrir como incidencias actuales:

- «YouTube no se ha probado»: **cerrado**, existe `BATTLE_VISIBLE_ON_STREAM=PASS`.
- «La clave aparece en el argv de FFmpeg»: **cerrado en código**, FFmpeg entrega FLV al relé interno y la clave permanece en el proceso Node.
- «/broadcast se queda siempre esperando porque web devuelve index.html»: **cerrado por #274**.
- «El arranque puede emitir una pantalla blanca»: #256 añade `BROADCAST_RENDER_READY` y watchdog; la prueba real pasó sin blanco.

## OLA 2: no confundir pendiente de integración con defecto de main

Los PR #268/#270/#271/#272/#273/#276 están revisados pero aún no forman una única versión integrada.
Sus cambios no deben describirse como comportamiento actual hasta obtener
`ENGINE_HARDENING_READY=PASS`.

## Documentación relacionada

- [Estado actual](current-status.md)
- [Funciones pendientes](pending-features.md)
- [Deuda técnica](technical-debt.md)
- [Streaming](../operations/streaming.md)

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| main actual | CODE_VERIFIED | `f590947`, 2026-11-12 |
| clave fuera de argv FFmpeg | CODE_VERIFIED | `apps/streamer/src/ffmpeg.ts` |
| MG en main | CODE_VERIFIED | PR #269 |
| limitaciones de Streaming V2 | DESIGN_VERIFIED | PR #275 |
| cartel «GANA RED» duplicado | REPORTADO | prueba del operador; falta test de reproducción |
