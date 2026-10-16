# Mapas: formato, versionado, propiedad, validación y editor

## Resumen

La API guarda los mapas en PostgreSQL, en las tablas `maps` y `map_versions`. Para validar, generar, importar Tiled y hacer miniaturas importa como librería el código de `apps/map-service`.

Desde el cierre funcional FC-C:

- el editor web trabaja sobre el **mismo formato** que guarda la API (InternalMap);
- **guarda en el servidor** (`POST /maps/drafts`) y reabre desde la API tras F5 o tras cerrar sesión;
- lo que exporta se importa en «Mapas» sin error;
- cada mapa tiene **dueño**: sólo él (o un admin) le añade versiones, edita sus borradores o lo publica.

Un organizer puede publicar mapas ajenos para curarlos, pero no editarlos.

El **servicio** `map-service` desplegado sigue sin uso. La decisión es retirarlo ([TD-017](../roadmap/technical-debt.md#td-017)).

## Índice

- [Qué es](#qué-es)
- [Cómo funciona](#cómo-funciona)
  - [Formato interno (InternalMap)](#formato-interno-internalmap)
  - [Versionado, estados y normalización](#versionado-estados-y-normalización)
  - [Propiedad y visibilidad](#propiedad-y-visibilidad)
  - [Validación](#validación)
  - [API](#api)
  - [Conversión al motor](#conversión-al-motor)
  - [Editor web](#editor-web)
  - [Compatibilidad con modos](#compatibilidad-con-modos)
  - [map-service (servicio): decisión](#map-service-servicio-decisión)
- [Uso](#uso)
- [Ejemplo](#ejemplo)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Qué es

Un mapa es una arena 2D en metros. Tiene suelo por baldosas, muros, destructibles, zonas, spawns, bases y banderas.

- Un **mapa** (`maps.id`, con dueño `maps.created_by`) tiene **versiones** (`map_versions`).
- Una versión en `draft` es un borrador editable.
- Las versiones `validated` y `published` son inmutables.
- Sólo una versión `published` se puede usar en batallas y torneos.

## Cómo funciona

### Formato interno (InternalMap)

Es el espejo TypeScript (`apps/map-service/src/types.ts`) del esquema `packages/map-schema/map.schema.json`:

```text
{ schemaVersion: 1, mapId, version, checksum, widthM, heightM, navCellSizeM?,
  generation?, materials: [...],
  layers: { ground: {tileSizeM, cols, rows, data[]}, walls: Shape[], destructibles?, zones?,
            spawns: [{objectId, team, position, heading}], bases?, flags?, navigation? },
  meta: { name?, author, license, supportedModes[], ... } }
```

`mapId` sigue el patrón del esquema (`^[a-z0-9][a-z0-9-]{1,62}$`); la API lo comprueba en import, borrador y generación. Ejemplo real: `maps/mvp-arena-01.json`.

### Versionado, estados y normalización

`map_versions.state ∈ draft | validated | published`, con clave primaria `(map_id, version)`.

| Operación | Efecto |
|---|---|
| `POST /maps` (import) y `POST /maps/generate` | Versión nueva `max+1` en `validated`. Sólo si es publicable |
| `POST /maps/drafts` | Si la **última** versión del mapa es `draft`, se **reescribe en sitio** (misma versión, `200`). Si no, se crea `max+1` en `draft` (`201`). Se guarda aunque tenga errores, y devuelve los `checks` |
| `POST …/actions/publish` | Revalida y congela (`published` + miniatura). Publicada = inmutable |
| `PUT …/versions/{v}` | Siempre `409 immutable` |

**Normalización (FC-C).** Al guardar, la API reescribe en el documento `mapId` y `version`, para que sean los de la fila, y pone `checksum` = checksum **canónico** (`sha256:` del JSON con claves ordenadas, `apps/map-service/src/canonical.ts`).

Es exactamente lo que exige `resolveBattleMap`, el resolver del launcher. Antes, un mapa importado o guardado se podía publicar pero **no era jugable** (`map_content_mismatch` o `map_checksum_mismatch`).

Consecuencia: dos versiones del mismo mapa tienen checksums distintos aunque su geometría sea igual, porque la versión forma parte del documento.

El guardado bloquea la fila del mapa (`SELECT … FOR UPDATE`), de modo que dos guardados concurrentes no compiten por el número de versión.

### Propiedad y visibilidad

| Acción | Quién |
|---|---|
| Añadir versiones (import, generar, borrador) a un mapa existente | Su dueño (`maps.created_by`) o admin. Un mapa **sin dueño** (contenido base) sólo lo versiona un admin |
| Crear un mapa nuevo | Cualquier `user` (queda como dueño). `generateMap` exige `organizer` |
| Publicar | El dueño, u organizer+ (curación). Otro usuario recibe `403` |
| Ver un borrador (`GET`, contenido, listado) | Su dueño o admin. Para el resto **no existe** (`404`, y no sale en `GET /maps`) |
| Ver `validated` / `published` | Cualquiera, también anónimo |

`GET /maps` no expone UUID de usuarios: devuelve `mine: true|false`, relativo al solicitante. `?mine=true` filtra los mapas propios.

### Validación

`validateMap(map)` ejecuta seis comprobaciones puras: `geometry`, `navigation`, `playability`, `balance`, `mode` y `destruction`. `isPublishable` es verdadero si ningún hallazgo tiene severidad `error`.

La API comprueba primero la **forma** (`assertMapShape`) y traduce cualquier excepción del validador a `400`. Un documento malformado ya no da `500`.

### API

| Método y ruta | Rol | Comportamiento |
|---|---|---|
| `GET /maps[?mine=true]` | anónimo | Versiones visibles (sin borradores ajenos) con `name` y `mine` |
| `GET /maps/{mapId}/versions/{v}` | anónimo | Metadatos (`404` si es un borrador ajeno) |
| `GET /maps/{mapId}/versions/{v}/content` | anónimo | **Nuevo.** El InternalMap completo, para reabrir o exportar. Misma visibilidad |
| `POST /maps` (multipart `file`) | `user` | Admite JSON de Tiled o InternalMap. El **formato de autoría antiguo** del editor (`id`/`width`/`walls`) da `400` con un mensaje que remite al editor. Si no es publicable, `422 map_invalid` |
| `POST /maps/drafts` (JSON) | `user` | Ver la tabla de [versionado](#versionado-estados-y-normalización). `403` si el mapa es ajeno |
| `POST /maps/generate` | `organizer` | Generador determinista. `403` si el `mapId` resultante es de otro |
| `POST /maps/{id}/versions/{v}/actions/publish` | `user` | Dueño u organizer+. `409` si ya está publicado o tiene errores (incluye los `checks`) |
| `PUT /maps/{id}/versions/{v}` | `admin` | Siempre `409` |

### Conversión al motor

`toEngineMap(InternalMap) → ArenaMap` (`apps/map-service/src/to-engine-map.ts`):

- muros y destructibles se convierten en cajas;
- bases y zonas, en círculos;
- de las zonas, sólo `damage` y `capture` llegan al motor;
- `ground`, `materials.speedFactor`, `blocksVision`, `navigation` y `captureTimeTicks` no tienen efecto en la simulación.

### Editor web

`#/maps/editor` (`apps/web/src/pages/MapEditorPage.tsx`):

- **Modelo**: InternalMap en metros (mapa nuevo: 120×80 m, rejilla de suelo coherente, dos spawns y los modos `deathmatch` y `team_deathmatch`).
- **Herramientas**: muro, destructible, spawn, base, bandera y zona (captura o daño), con posición, tamaño o radio, equipo y tipo editables. También id, nombre, dimensiones (regenera la rejilla) y casillas de modos soportados.
- **Guardar en el servidor**: `POST /maps/drafts`. Pinta los `checks` de E4 y fija la URL `#/maps/editor?map=<id>&v=<n>`.
- **Reabrir**: al cargar con esa URL (F5, o volver tras logout y login), pide `GET …/versions/{v}` y `…/content` a la API. Nada sale de la memoria del navegador.
- **Mis mapas**: `GET /maps?mine=true`, con botón «Abrir».
- **Publicar**: se habilita con el borrador guardado y sin cambios pendientes.
- **Duplicar**: «Guardar como copia» con otro id.
- **Exportar**: el InternalMap sin `version`/`checksum`, en un textarea y como descarga `.json`, importable tal cual en «Mapas».
- **Importar**: un InternalMap, o el JSON de autoría antiguo, que se convierte a 10 px = 1 m.
- **«Mapas»** (`MapsPage.tsx`): cada fila enlaza a «Editar» o «Abrir en el editor».

### Compatibilidad con modos

`checkBattleContent` (`apps/api/src/routes/catalog.ts`) cruza el modo con `supported_modes` de la versión publicada (`map_mode_unsupported`, 409). Ver [game-modes.md](game-modes.md).

El formulario de nueva batalla sólo ofrece mapas que soportan el modo elegido. **El endpoint `POST /battles` (B) todavía no llama a `checkBattleContent`**: está propuesto en el informe DEV-C y en COORD.

El mapa de serie `mvp-arena-01`:

- **v1**: declara `capture_the_flag` y `team_deathmatch`. La columna `supported_modes`, que antes decía `["deathmatch"]` por un fallo del seed, ahora se deriva de `meta`.

El contenido base añade **`mvp-arena-02` v1**: la **misma geometría**, que declara también `deathmatch`. Según `checkMode` lo soporta (4 spawns). `zone_control` no, porque no tiene zona de captura.

Es un mapa aparte, y no una v2 de `mvp-arena-01`, por dos motivos: la v1 es inmutable, y las pruebas de fail-closed de B usan «mvp-arena-01 v2» como versión inexistente.

### map-service (servicio): decisión

`apps/map-service/src/main.ts` sirve un `MapService` en memoria, vacío, que nadie consulta. La autoridad de los mapas es la API (persistencia, propiedad, validación). **Decisión:** se mantiene `apps/map-service` como **librería**, se retira el **servicio** del perfil `production` del compose y no se crea una frontera de red que no aporta nada.

El cambio de compose lo hace REVIEW; está propuesto en el informe DEV-C. Hasta entonces, su healthcheck verde no significa nada ([TD-017](../roadmap/technical-debt.md#td-017)).

## Uso

1. Editor → «Nuevo» → id y nombre → objetos → «Guardar en el servidor».
2. Corrige los avisos de E4 → guarda otra vez (misma versión) → «Publicar».
3. Nueva batalla → elige el modo → aparece tu mapa.

## Ejemplo

```text
POST /api/v1/maps/drafts {mapId:"mi-arena", ..., meta:{name:"Mi arena", supportedModes:["deathmatch"]}}
  → 201 {mapId:"mi-arena", version:1, state:"draft", mine:true, checks:[...]}
POST /api/v1/maps/drafts (mismo mapId, editado)          → 200 {version:1, ...}   (en sitio)
POST /api/v1/maps/mi-arena/versions/1/actions/publish    → 200 {state:"published"}
POST /api/v1/maps/drafts (mismo mapId)                   → 201 {version:2, state:"draft"}
POST /api/v1/maps/drafts (mapId de otro, como organizer) → 403 forbidden
```

## Errores / limitaciones

- `POST /battles` no valida modo ↔ mapa hasta que B integre `checkBattleContent`. La web ya filtra.
- No hay borrado de mapas ni de versiones.
- `generateMap` sigue exigiendo `organizer`.
- El editor no edita polígonos, materiales, la capa de navegación ni `maxChassisSize`, aunque los conserva si vienen en el documento. Los objetos se mueven con campos numéricos, no arrastrando.
- La v1 de `mvp-arena-01` en una BD ya sembrada: `bootstrap` corrige sólo su columna `supported_modes`, sin tocar el contenido. Hacerlo en producción es decisión del operador.

## Estado actual

- **FUNCIONA ACTUALMENTE**: crear, editar y guardar en servidor, reabrir tras F5 o tras logout y login, editar, publicar y usar en una batalla (E2E de navegador); export e import simétricos; propiedad por mapa; borradores privados; mapa publicado jugable por `resolveBattleMap`.
- **PARCIAL**: validación modo ↔ mapa (función lista y web filtrando; falta que `POST /battles` la llame).
- **PENDIENTE**: borrado; edición de polígonos y materiales; retirar el servicio map-service del compose (REVIEW).

## Documentación relacionada

- Usuario: [Mapas](../user/maps.md), [Modos de juego](../user/game-modes.md)
- Técnica: [game-modes.md](game-modes.md), [engine.md](engine.md), [api.md](api.md), [frontend.md](frontend.md), [battles.md](battles.md)

## Verificación

Verificado en la rama `fc/dev-c-maps-teams`, base `0b8c12b`.

| Afirmación | Estado | Evidencia |
|---|---|---|
| Propiedad por mapa (dueño o admin; sin dueño, sólo admin) | CODE_VERIFIED / RUNTIME_VERIFIED | `apps/api/src/routes/maps.ts:127-134`; `apps/api/src/routes/fc-c-content.test.ts:176,198` |
| Contenido normalizado (versión y checksum canónico) y mapa jugable | CODE_VERIFIED / RUNTIME_VERIFIED | `routes/maps.ts:142-145`; `fc-c-content.test.ts:94,146` (`resolveBattleMap` ok) |
| Borrador mutable en sitio; tras publicar, versión nueva | CODE_VERIFIED / RUNTIME_VERIFIED | `routes/maps.ts:181-207`; `fc-c-content.test.ts:94` |
| Borradores invisibles para otros | CODE_VERIFIED / RUNTIME_VERIFIED | `routes/maps.ts:214-219,235-262`; `fc-c-content.test.ts:205` |
| `GET …/content` | CODE_VERIFIED | `routes/maps.ts:277-282` |
| Import sin 500 (autoría antigua y documento sin capas: 400) | CODE_VERIFIED / RUNTIME_VERIFIED | `routes/maps.ts:82-88,311`; `fc-c-content.test.ts:159,166` |
| Publicar: dueño u organizer+ | CODE_VERIFIED / RUNTIME_VERIFIED | `routes/maps.ts:364-374`; `fc-c-content.test.ts:214` |
| Editor guarda, reabre tras F5, publica y se usa en batalla (navegador real) | RUNTIME_VERIFIED | `tests/fc-c-browser/c8-flow.spec.ts` (Chromium 1.48.2, rc=0) |
| Modos del mapa de serie (v1 corregida; mvp-arena-02 con deathmatch) | CODE_VERIFIED / RUNTIME_VERIFIED | `apps/api/src/db/seeds/dev.ts` (`seedContent`, `mvpArena02`); `fc-c-content.test.ts:276` |
| El servicio map-service no tiene consumidores | CODE_VERIFIED | `apps/map-service/src/main.ts:22-41`; ningún `MAP_SERVICE_URL` en `apps/` |
