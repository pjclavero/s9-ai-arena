# Ronda 2 — registro de ejecución

Historial legible del avance de la [Ronda 2 del dosier](../Dosier_tareas_S9_AI_Arena.md#15-ronda-2--remediación-integración-evolución-y-retirada-de-v1).
Cada apartado se implementa, se verifica, se documenta en `reportes/` y se commitea+empuja por separado.

Rama de trabajo: `ronda2/r-p0-bloqueantes`.

## Banda R-P0 · Errores bloqueantes

| Tarea | Descripción | Estado | Issue | Reporte | Commit |
|---|---|---|---|---|---|
| R1.1 | Munición: `resolveVehicle` propaga `entry.ammo` | ✅ Hecho | #15 | [R1.1-municion.md](reportes/R1.1-municion.md) | `8935c45` |
| R1.2 | Sensor acústico muerto + test vacuo | ✅ Hecho | — | [R1.2-sensor-acustico.md](reportes/R1.2-sensor-acustico.md) | `e1fa327` |
| R1.3 | Publicar `sensor.acoustic`/`sensor.proximity` en catálogo | ✅ Hecho | — | [R1.3-sensores-catalogo.md](reportes/R1.3-sensores-catalogo.md) | `67e2c04` |
| R1.9 | `zone_control` jugable + King of the Hill | ✅ Hecho | — | [R1.9-zone-control-koth.md](reportes/R1.9-zone-control-koth.md) | `a8652fd` |
| R1.4 | Secreto JWT: fallar cerrado + leer por archivo | ✅ Hecho (local; BD en CI) | #14 rel. | [R1.4-secreto-jwt.md](reportes/R1.4-secreto-jwt.md) | `7e23a39` |
| R1.5 | Sandbox: fallar cerrado sin runner | ✅ Hecho (local; API en CI) | #9 rel. | [R1.5-sandbox-fail-closed.md](reportes/R1.5-sandbox-fail-closed.md) | `80acf8d` |
| R1.6 | CI del sandbox: no pasar en verde sin probar | ⏸️ Pendiente (pausa) | — | — | — |
| R1.7 | Retirar el montaje de `docker.sock` | ⏸️ Pendiente (pausa) | — | — | — |
| R1.8 | Rate-limit y bloqueo de login tras proxy | ⏸️ Pendiente (pausa) | — | — | — |

> **Pausa 2026-07-17.** Se detiene R-P0 tras R1.5 para preparar el despliegue en el servidor
> (VM108). Quedan **R1.6, R1.7 y R1.8** (seguridad, verificación local parcial + CI). El sub-lote de
> **motor (R1.1, R1.2, R1.3, R1.9) está 100 % cerrado y verificado**; de seguridad están hechos
> **R1.4 y R1.5** (verificados en local, integración con BD pendiente de CI en Linux). Todo empujado
> a `origin/ronda2/r-p0-bloqueantes`. Se continuará desde el servidor.

**Leyenda:** ✅ hecho y verificado · 🔜 en curso · ⏳ pendiente.

Línea base del área de motor+catálogo al abrir la rama: **188 tests verdes** (`npx vitest run packages/module-catalog apps/arena-engine`).
