# Mapas: formato, versionado, validación y editor

## Resumen

Los mapas se guardan en PostgreSQL. Las tablas `maps` y `map_versions` las escribe **la API**, que importa como librería el código de `apps/map-service` (validador, generador procedural, importador Tiled y miniaturas). El **servicio** `map-service` desplegado es un almacén en memoria vacío que nadie consulta ([TD-017](../roadmap/technical-debt.md#td-017)).

El editor visual de la web trabaja sólo en el navegador. Su JSON tiene **otro formato**: importarlo en «Mapas» da `500 Error interno` y el endpoint de borradores lo rechaza con `400` ([TD-010](../roadmap/technical-debt.md#td-010)).

## Índice

- [Qué es](#qué-es)
- [Formato interno (InternalMap)](#formato-interno-internalmap)
- [Versionado y estados](#versionado-y-estados)
- [Validación](#validación)
- [API](#api)
- [Conversión al motor](#conversión-al-motor)
- [map-service (servicio)](#map-service-servicio)
- [Editor web y su formato](#editor-web-y-su-formato)
- [Compatibilidad con modos](#compatibilidad-con-modos)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

Un mapa es una arena 2D en metros. Tiene suelo por baldosas, muros, destructibles, zonas, spawns, bases y banderas. Un **mapa** (`maps.id`) tiene **versiones inmutables** (`map_versions`). Sólo las versiones `published` se pueden usar en batallas y torneos.

## Formato interno (InternalMap)

Es el espejo TypeScript (`apps/map-service/src/types.ts`) del esquema `packages/map-schema/map.schema.json`:

```text
{ schemaVersion: 1, mapId, version, checksum, widthM, heightM, navCellSizeM?,
  generation?: {generator, seed, params, attempts?},
  materials: [{id, name?, blocksMovement, blocksVision, hp?, damagePerSecond?, speedFactor?}],
  layers: {
    ground: {tileSizeM, cols, rows, data[]},
    walls: Shape[],                  // rect | circle | polygon
    destructibles?: [{objectId, material, …Shape}],
    zones?: [{objectId, zoneType: damage|capture|no_entry|cover, team?, damagePerSecond?, captureTimeTicks?, …Shape}],
    spawns: [{objectId, team, position, heading, maxChassisSize?}],
    bases?: [{objectId, team, …Shape}],
    flags?: [{objectId, team, position}],
    navigation?: {cellSizeM, cols, rows, blocked}
  },
  meta: {name?, author, license, supportedModes[], supportedChassisSizes?, maxDestructibles?, destructiblesMayBlockOnlyRoute?} }
```

Ejemplo real: `maps/mvp-arena-01.json`. Es una arena de 120×80 m con 3 muros, 4 destructibles, 2 zonas de daño (ácido, 8 HP/s), 4 spawns, 2 bases y 2 banderas. `meta.supportedModes` declara `capture_the_flag` y `team_deathmatch`. También se importa el formato JSON de Tiled (`import-tiled.ts`; ver el histórico «formato TMX» en [DOC-MIGRATION-MAP](../DOC-MIGRATION-MAP.md)).

## Versionado y estados

`map_versions.state ∈ draft | validated | published` (CHECK). Columnas: `checksum`, `width_m`, `height_m`, `supported_modes` (jsonb), `thumbnail_url`, `generation`, `content` (el documento completo), `created_at` y `published_at`. La clave primaria es `(map_id, version)`.

- Cada importación, generación o borrador crea la **versión siguiente** (`max(version)+1`), aunque el documento traiga su propio `version`.
- `maps.created_by` registra quién creó el mapa la primera vez. **No hay propiedad por mapa**: cualquiera con rol suficiente puede añadir versiones a un `mapId` ajeno.
- Una versión publicada es inmutable: `PUT …/versions/{v}` responde **siempre** `409 immutable`.

## Validación

`validateMap(map)` ejecuta seis comprobaciones puras y deterministas (`apps/map-service/src/validate/`), en este orden:

1. `geometry`: formas válidas y dentro de límites.
2. `navigation`: rutas entre spawns por chasis.
3. `playability`: anchura de pasillos y espacio libre en los spawns.
4. `balance`: simetría de distancias y cobertura.
5. `mode`: que el mapa tenga lo que exige cada modo de `meta.supportedModes`.
6. `destruction`: destructibles.

`isPublishable` es verdadero si no hay ningún hallazgo con severidad `error`.

`validateMap` **no comprueba la forma** antes de recorrer `layers`. Un documento sin `layers` revienta con `TypeError` en `geometry.ts` y la API lo devuelve como `500` en `importMap`.

## API

| Método y ruta | Rol | Comportamiento |
|---|---|---|
| `GET /maps` | anónimo | Lista **todas las versiones** de todos los mapas, incluidos borradores ajenos (metadatos, sin contenido) |
| `GET /maps/{mapId}/versions/{v}` | anónimo | **Sólo metadatos**; no devuelve `content` |
| `POST /maps` (multipart `file`) | `user` | JSON de Tiled (`type:"map"` o `tiledversion`) → `importTiled`; si no, se trata como InternalMap. `validateMap`: con errores `422 map_invalid {checks}`, sin errores `201` con estado **`validated`** |
| `POST /maps/drafts` (JSON) | `user` | `assertMapShape` (exige `mapId`, `widthM/heightM`, `layers.ground{cols,rows,data}`, `layers.walls[]`, `layers.spawns[]`, `meta.supportedModes[]`; si falta algo, `400`). Guarda en `draft` **aunque tenga errores** y devuelve `{…, checks}`. **La web no lo usa** |
| `POST /maps/generate` `{params, seed}` | `organizer` | Generador determinista (misma semilla, mismo checksum). Si no es publicable, `422`. Si lo es, `201` en `validated` con `generation` |
| `POST /maps/{id}/versions/{v}/actions/publish` | `organizer` | Revalida. Ya publicada o con errores: `409 illegal_transition`. Si no, `published` con miniatura SVG en `data:` |
| `PUT /maps/{id}/versions/{v}` | `admin` | Siempre `409 immutable` |

`supported_modes` se persiste desde `meta.supportedModes` (`insertMapVersion`). Excepción: el contenido base (`seedContent`) lo lee de la raíz del documento y guarda `["deathmatch"]` para `mvp-arena-01`.

## Conversión al motor

`toEngineMap(InternalMap) → ArenaMap` (`apps/map-service/src/to-engine-map.ts`) la usan el worker y el camino real:

- **Muros y destructibles**: se convierten en cajas. Un polígono se aproxima por su caja envolvente alineada a los ejes y un círculo por su caja. La vida de un destructible es la de su material (100 por defecto).
- **Bases y zonas**: se convierten en círculos de radio equivalente (el inscrito).
- **Zonas que llegan al motor**: sólo `damage` y `capture`. `no_entry` y `cover` sólo sirven al validador.
- **Sin efecto en la simulación**: la capa `ground`, `materials.speedFactor` y `blocksVision`, `navigation`, `maxChassisSize` de los spawns y `captureTimeTicks`.

## map-service (servicio)

`apps/map-service/src/main.ts` expone `GET /healthz` (`{maps:N}`), `GET /maps` y `GET /maps/{id}/{v}` sobre `new MapService()` en memoria, sin persistencia y de sólo lectura. Ningún componente le llama: no hay `MAP_SERVICE_URL` en `apps/`. En la auditoría respondía `{"maps":0}` y `[]` mientras la API servía mapas publicados ([TD-017](../roadmap/technical-debt.md#td-017)).

## Editor web y su formato

`#/maps/editor` (`apps/web/src/pages/MapEditorPage.tsx`):

- **Edición**:
  - modelo local `DraftMap` en píxeles: `{schemaVersion, id, name, width, height, seed, objects[]}`;
  - herramientas «Añadir muro», «Añadir obstáculo» y «Añadir spawn», con edición de x, y, ancho, alto, salud o equipo;
  - validación en cliente: ids únicos, objetos dentro de límites, tamaños positivos y al menos un spawn.
- **Exportar**: produce el formato de **autoría** `{schemaVersion, id, name, width, height, seed, walls[], obstacles[], spawns[]}`, igual que `maps/training-yard.json`.
- **Persistencia**: **ninguna**. No hay botón Guardar, F5 pierde lo editado y no se llama a la API.

Incompatibilidades, estado actual ([TD-010](../roadmap/technical-debt.md#td-010)):

| Destino | Resultado | Por qué |
|---|---|---|
| `POST /maps` (Importar en «Mapas») | **500 Error interno** | No es Tiled y se trata como InternalMap; `validateMap` lee `map.layers.ground` sobre `undefined` |
| `POST /maps/drafts` | `400 mapId obligatorio` | `assertMapShape` exige el formato interno |
| Motor | — | Unidades (px y m), sin capas ni `meta` |

Ningún conversor `DraftMap → InternalMap` existe en el código.

## Compatibilidad con modos

Ver [game-modes.md](game-modes.md#compatibilidad-con-mapas). En resumen:

- el validador comprueba los 4 modos de plataforma que declara el mapa;
- el motor rechaza combinaciones imposibles al crear la batalla;
- **la API no cruza el modo pedido con `supported_modes`**.

## Errores / limitaciones

- Importar un JSON del editor da `500` ([TD-010](../roadmap/technical-debt.md#td-010)).
- No hay reapertura: la API no devuelve el contenido de una versión, así que no se puede seguir editando un mapa guardado.
- No hay duplicado (sólo reimportando con otro `mapId`) ni borrado.
- La web muestra «Generar» y «Publicar» a todos, pero exigen `organizer`: un usuario normal recibe `403 Requiere rol organizer`.
- Al importar, el aviso de la web dice «(…, borrador)» aunque el estado guardado es `validated`.
- El listado anónimo expone los borradores de todos.

## Estado actual

- **FUNCIONA ACTUALMENTE**: importar InternalMap o Tiled válido; validación de 6 comprobaciones; generar y publicar (`organizer`); versionado inmutable; uso de un mapa publicado en batalla por API y en torneo (este último sólo con `mvp-arena-01`, ver [tournaments.md](tournaments.md)).
- **PARCIAL**: editor (sólo cliente); borradores (sólo API).
- **PENDIENTE**: guardado y reapertura desde el editor, conversor de formatos, edición de capas (suelo, zonas, bases, banderas), duplicado, propiedad por mapa, validación modo↔mapa al crear batalla, retirada o uso real del servicio map-service.

## Documentación relacionada

- Usuario: [Mapas](../user/maps.md)
- Técnica: [game-modes.md](game-modes.md), [engine.md](engine.md), [api.md](api.md), [frontend.md](frontend.md)
- Arquitectura (A): [services.md](services.md), [database.md](database.md)
- Histórico absorbido: R10 (editor, foundation y slice 1) y formato TMX (ver [DOC-MIGRATION-MAP](../DOC-MIGRATION-MAP.md))

## Verificación

Verificado contra `27f70bb`.

| Afirmación | Estado | Evidencia |
|---|---|---|
| La API persiste mapas usando la librería de map-service | CODE_VERIFIED | `apps/api/src/routes/maps.ts:14-18,74-95` |
| El servicio map-service es un almacén en memoria sin consumidores | CODE_VERIFIED / RUNTIME_VERIFIED | `apps/map-service/src/main.ts:22-41`; auditoría B pasada 2 §3 |
| Importar da `validated`; borrador da `draft`; versión `max+1` | CODE_VERIFIED | `routes/maps.ts:74-95,164,184` |
| `GET /maps/{id}/versions/{v}` sin contenido | CODE_VERIFIED | `routes/maps.ts:60-72,119-126` |
| PUT siempre 409 | CODE_VERIFIED | `routes/maps.ts:194-199` |
| Generar y publicar exigen `organizer` | CODE_VERIFIED | `apps/api/openapi.yaml` (`x-min-role` de `generateMap` y `publishMapVersion`) |
| Seis comprobaciones del validador | CODE_VERIFIED | `apps/map-service/src/validate/index.ts:37-53` |
| El JSON del editor da 500 al importarlo | RUNTIME_VERIFIED | Auditoría B pasada 1 §B6 y pasada 2 §1a (navegador real) |
| Formato del editor y ausencia de persistencia | CODE_VERIFIED | `apps/web/src/pages/MapEditorPage.tsx:1-110,235-238` |
| Zonas `no_entry`/`cover` y suelo no llegan al motor | CODE_VERIFIED | `apps/map-service/src/to-engine-map.ts` (`zones.filter`, sin `ground`) |
| Seed: `supported_modes` desde la raíz | CODE_VERIFIED | `apps/api/src/db/seeds/dev.ts:102` |
| Sin propiedad por mapa | CODE_VERIFIED / RUNTIME_VERIFIED | `routes/maps.ts:76-78`; auditoría B p2 §3 |
