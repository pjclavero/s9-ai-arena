# R10 · Editor avanzado de mapas (foundation — diseño)

## Estado actual / qué existe

- **Esquema de mapa** (`maps/*.json`): `schemaVersion, mapId, version, widthM, heightM,
  navCellSizeM, materials[], layers{}, meta, checksum`. Los objetos (paredes, spawns, zonas)
  viven en `layers` como shapes.
- **Validación completa** en `apps/map-service/src/validate/`: `geometry`, `shapes`,
  `playability`, `navigation`, `mode`, `balance`, `destruction`, `result`.
- **Endpoints**: `listMaps`, `getMapVersion`, `publishMapVersion`, `generateMap` (openapi).
- **UI**: `MapsPage` (de R8/#49) — listado/gestión.
- **Reglas ya vigentes**: versión `published` es inmutable; un mapa solo entra en batalla si
  está `published` (lo valida `createPracticeBattle` y `runBattle`).

## Qué falta (gap R10)

- **Editor visual** (`#/maps/:id/edit`): canvas/SVG con grid + snap, CRUD de objetos
  (crear/mover/borrar), panel de propiedades, preview, guardar draft.
- **Flujo de draft**: crear draft, editar, validar (usando el validador existente vía API),
  publicar. Importar/exportar JSON (roundtrip estable con el esquema existente).
- Posibles endpoints de draft/objetos si no existen (ver abajo).

## Alcance permitido (foundation)

Editor mínimo funcional sobre el esquema existente: bounds, spawn points, walls, obstacles,
zones. Draft-save + validar + publicar reutilizando `apps/map-service/validate`.

## Fuera de alcance (ahora)

Capture zones avanzadas, minas, bases, healing/damage zones, powerups, scripts/reglas
especiales, generación procedural avanzada (ya hay `generateMap` básico).

## Rutas UI propuestas

```text
#/maps            (existe: MapsPage)
#/maps/new        crear draft
#/maps/:id        detalle + versiones
#/maps/:id/edit   editor visual
#/maps/:id/preview
#/maps/:id/versions
```

## Modelos

Reusar el esquema existente. Tipos de UI:

```text
Map { mapId, name }
MapVersion { mapId, version, state, widthM, heightM, navCellSizeM, materials, layers, meta, checksum }
MapObject (derivado de layers): { id, kind: bounds|spawn|wall|obstacle|zone, shape, props }
MapValidationResult (ya existe en map-service/validate/result)
```

Estados: `draft → validating → valid|invalid → published → archived` (published inmutable).

## Endpoints (revisar existencia antes de crear — NO duplicar)

- Existentes: `GET /maps`, `GET /maps/:id/versions/:v`, publish, generate.
- A añadir SI faltan (foundation): `POST /maps` (draft), `PATCH /maps/:id/versions/:v` (editar
  draft), `POST /maps/:id/versions/:v/validate` (valida con map-service), import/export.

## Validaciones mínimas (ya cubiertas por map-service; el editor las invoca)

≥2 spawns, spawns dentro de bounds y fuera de pared, bounds válidos, objetos dentro del mapa,
geometría de zonas válida, IDs únicos, tamaño dentro de límites, versión publicada no editable.

## Tests esperados

Válido pasa; sin spawns falla; spawn/wall fuera de bounds falla; publicar invalid falla;
published no editable; render editor; crear/mover/borrar objeto; guardar draft; export/import roundtrip.

## Riesgos / dependencias

- Solape en `App.tsx` (nueva ruta/nav) y `OpenAPI` (nuevos ops → conformance). Riesgo **medio**.
- **Independiente de #50/#51.** Depende de R8 maps (en main).

## Primer PR recomendado

`feature/r10-map-editor-foundation`: `MapEditorPage` + endpoints draft/validate si faltan +
tests + docs. Off si se marca experimental. Reconciliar App.tsx/OpenAPI en el mismo PR.

## Dictamen

**R10-B** — diseño/contrato preparado; implementación pendiente (independiente de #50/#51).
