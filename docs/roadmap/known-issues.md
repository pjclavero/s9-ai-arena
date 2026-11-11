# Problemas conocidos — S9 AI Arena

## Resumen

Síntomas **vigentes** que puede ver un usuario u operador. Revisado el **2026-11-10** contra
`main` y producción RC8 `b254e3d`.

Los defectos históricos ya cerrados no se repiten aquí.

## Prioridad alta

| Síntoma | Estado / causa | Dónde | Seguimiento |
|---|---|---|---|
| Una retransmisión real de una batalla en vivo puede llegar a YouTube como imagen completamente blanca aunque el relay esté publicando | investigación abierta sobre la cadena Phaser/WebGL → Chromium → Xvfb → FFmpeg → relay | producción RC8 | [#256](https://github.com/pjclavero/s9-ai-arena/issues/256) |
| La gestión de Bots mezcla navegación por anclas/scroll con otra vista por pestañas; visibilidad, directo y retransmisión aparecen fragmentados | deuda UX confirmada en el código actual | producción y `main` | [#255](https://github.com/pjclavero/s9-ai-arena/issues/255) |

## Usuario web

| Síntoma | Estado / causa | Dónde |
|---|---|---|
| No hay flujo completo de recuperación de contraseña desde la web | la API dispone de piezas, pero falta el canal/UX completo | producción y `main` |
| La gestión de 2FA/sesiones no está cerrada completamente en UI | funciones backend parciales frente a UX | producción y `main` |
| Un torneo puede quedar condicionado por incidencias de sus batallas | limitaciones conocidas del cierre de torneo | producción y `main` |
| CTF en torneos conserva limitaciones de compatibilidad de bandos/reglas | validación conocida | producción y `main` |
| No existe borrado normal de mapas/versiones de mapa desde la UI | operación no implementada | producción y `main` |
| La página de Bots todavía requiere demasiada navegación vertical | rediseño #255 pendiente | producción y `main` |

## Operador

| Síntoma | Estado / causa | Dónde |
|---|---|---|
| El streaming RTMPS puede estar técnicamente conectado pero visualmente inválido | #256: falta gate de contenido visual válido | producción |
| La clave de emisión utilizada antes de la rotación debe tratarse como comprometida | requiere revocación/rotación en YouTube y reemplazo desde la web | operación |
| Backup/restore/readiness siguen teniendo parte de su operación fuera de la UI | administración operativa parcial | producción y `main` |
| El perfil completo de observabilidad y alertas requiere seguimiento operativo | configuración existente, despliegue/validación operativa parcial | producción |

## Privacidad / replays

Los replays públicos están actualmente desactivados en producción. Esto no se considera una solución
arquitectónica definitiva: si se habilitan, la salida pública deberá usar una **proyección saneada** y
nunca exponer el replay crudo por defecto.

El proyecto visual en curso también debe revisar fugas por inferencia (por ejemplo, deducir equipamiento
por velocidad/efecto de proyectiles) y diferencias según el perfil del observador.

## Trabajo no integrado

El proyecto `mejoras-visuales` / PR #253 sigue en FASE 0. Sus documentos y hallazgos no describen
funcionalidad disponible en RC8 hasta que una fase sea revisada, aceptada e integrada explícitamente.

## Documentación relacionada

- [Estado actual](current-status.md)
- [Funciones pendientes](pending-features.md)
- [Deuda técnica](technical-debt.md)
- [Streaming](../operations/streaming.md)
- [Histórico](../history/status/)
