# Ronda 2 — registro de ejecución

Historial legible del avance de la [Ronda 2 del dosier](../Dosier_tareas_S9_AI_Arena.md#15-ronda-2--remediación-integración-evolución-y-retirada-de-v1).
Cada apartado se implementa, se verifica, se documenta en `reportes/` y se commitea+empuja por separado.

Rama de trabajo: `ronda2/r-p0-bloqueantes`.

## Banda R-P0 · Errores bloqueantes

| Tarea | Descripción | Estado | Issue | Reporte | Commit |
|---|---|---|---|---|---|
| R1.1 | Munición: `resolveVehicle` propaga `entry.ammo` | ✅ Hecho | #15 | [R1.1-municion.md](reportes/R1.1-municion.md) | `8935c45` |
| R1.2 | Sensor acústico muerto + test vacuo | 🔜 En curso | — | — | — |
| R1.3 | Publicar `sensor.acoustic`/`sensor.proximity` en catálogo | ⏳ Pendiente (dep. R1.2) | — | — | — |
| R1.9 | `zone_control` jugable + King of the Hill | ⏳ Pendiente | — | — | — |
| R1.4 | Secreto JWT: fallar cerrado + leer por archivo | ⏳ Pendiente | — | — | — |
| R1.5 | Sandbox: fallar cerrado sin runner | ⏳ Pendiente | — | — | — |
| R1.6 | CI del sandbox: no pasar en verde sin probar | ⏳ Pendiente | — | — | — |
| R1.7 | Retirar el montaje de `docker.sock` | ⏳ Pendiente | — | — | — |
| R1.8 | Rate-limit y bloqueo de login tras proxy | ⏳ Pendiente | — | — | — |

**Leyenda:** ✅ hecho y verificado · 🔜 en curso · ⏳ pendiente.

Línea base del área de motor+catálogo al abrir la rama: **188 tests verdes** (`npx vitest run packages/module-catalog apps/arena-engine`).
