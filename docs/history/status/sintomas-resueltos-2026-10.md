# Síntomas de octubre (resueltos)

> **DOCUMENTACIÓN HISTÓRICA**
> Estos documentos describen diseños, estados o procedimientos anteriores.
> No deben utilizarse como guía de funcionamiento actual.

## Resumen

Tabla que figuraba en `operations/troubleshooting.md` con el estado de la auditoría del 2026-10-15.
Las deudas que enumera (TD-001, TD-002, TD-003, TD-009, TD-010 y TD-028) están **CERRADAS**
en `main` (verificado en `e3bf2fa`, 2026-11-02; ver [../../roadmap/technical-debt.md](../../roadmap/technical-debt.md)).
No son síntomas actuales. Estado vigente: [../../roadmap/current-status.md](../../roadmap/current-status.md).

## Tabla archivada (octubre de 2026)

No son fallos de la instalación sino del producto; no se arreglan desde operación.

| Síntoma | Estado | Deuda |
|---|---|---|
| Ningún bot pasa de la validación a `published` | build fail-closed sin sandbox real | [TD-001](../../roadmap/technical-debt.md#td-001) |
| Las batallas no ejecutan el código del usuario | las ejecuta el worker con un bot stub | [TD-002](../../roadmap/technical-debt.md#td-002) |
| «Crear batalla» en la web → 400 `rulesetId desconocido` | la web envía ids de modo | [TD-003](../../roadmap/technical-debt.md#td-003) |
| El reproductor/visor no carga en el navegador | arranque de Phaser | [TD-009](../../roadmap/technical-debt.md#td-009) |
| Importar el JSON exportado por el editor de mapas → 500 | formatos distintos | [TD-010](../../roadmap/technical-debt.md#td-010) |
| Espectador en directo rechaza el ticket (4401) | worker sin secreto de verificación | [TD-028](../../roadmap/technical-debt.md#td-028) |
