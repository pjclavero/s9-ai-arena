# Formato Tiled esperado por el importador (E4 / T4.1)

Este documento describe **qué espera el importador de Tiled** (`apps/map-service/src/import-tiled.ts`)
para traducir un mapa al formato interno de E1 (`packages/map-schema/map.schema.json`).

## Qué archivo consume

El importador lee el **JSON exportado por Tiled** ("JSON Map Format", ver
[doc.mapeditor.org](https://doc.mapeditor.org/en/stable/reference/json-map-format/)),
**no** el `.tmx` (XML). Es deliberado: el JSON ya trae los objetos resueltos (posiciones
absolutas, propiedades tipadas) y no obliga a arrastrar un parser de XML.

La CLI acepta `.json`. Si le pasas un `.tmx` aborta con un mensaje pidiendo el export JSON:

```
map-service import maps/mvp-arena-01.tiled.json --out maps/mvp-arena-01.json
```

El mapa fuente del MVP está en `maps/mvp-arena-01.tiled.json` y su versión importada
(golden, versionada en el repo) en `maps/mvp-arena-01.json`. **El golden no se edita a
mano**: se regenera corriendo el importador sobre el fuente.

## Convención de coordenadas (la parte no obvia)

| | Tiled | Formato interno |
|---|---|---|
| Unidad | píxeles | **metros** (ADR-000 D1: 1 unidad = 1 m) |
| Origen | arriba-izquierda | abajo-izquierda |
| Eje Y | hacia **abajo** | hacia **arriba** |
| Rect (x,y) | esquina superior-izquierda | **centro** (`position`) |

La escala se declara como **propiedad personalizada del mapa**: `pixelsPerMeter` (px/m).
Elegimos px/m —y no m/px— porque el visor (E8) usa `PIXELS_PER_METER = 10`, así que el
mismo número describe ambos extremos del pipeline. Si el mapa no la trae, puede forzarse
con `opts.pixelsPerMeter`; si no hay ninguna, el importador **lanza un error**.

Con `mpp = 1 / pixelsPerMeter`, cada punto se convierte así (nótese el **volteo de Y**):

```
x_m = x_px * mpp
y_m = altoM - y_px * mpp          // altoM = height_tiles * tileheight * mpp
```

Los rectángulos y elipses de Tiled se guardan por su esquina superior-izquierda; el
importador los pasa a **centro** antes de voltear Y. Las rotaciones de Tiled (grados,
horarias, Y abajo) se convierten a **radianes antihorarios** (`rad = -deg·π/180`), acorde
a D1; como voltear Y invierte el sentido de giro, el signo se niega. *Limitación conocida:*
Tiled rota alrededor del origen (x,y) del objeto y el formato interno alrededor del centro;
para el MVP todas las rotaciones son 0, así que no afecta. Si en el futuro se usan objetos
rotados, la posición del centro habría que corregirla por el pivote.

Redondeamos las coordenadas a 1e-6 m (1 µm) tras multiplicar por `mpp`, para eliminar de
forma determinista las colas binarias del producto (p. ej. `440 * 0.1 = 44.00000000000001`).
Es aritmética pura, sin `Intl` ni locale, así que **el checksum canónico es estable**.

## Capas

| Capa Tiled | Tipo | Capa interna | Notas |
|---|---|---|---|
| primera `tilelayer` | tilelayer | `ground` | **obligatoria**. GID → índice de material |
| `walls` | objectgroup | `walls` | muros indestructibles (rect/polígono/círculo) |
| `destructibles` | objectgroup | `destructibles` | requieren `material`; opcional `hp` |
| `zones` | objectgroup | `zones` | `zoneType`, `team`, `damagePerSecond`, `captureTimeTicks` |
| `spawns` | objectgroup | `spawns` | **obligatoria** (≥1 objeto). `team`, `heading` |
| `bases` | objectgroup | `bases` | `team` |
| `flags` | objectgroup | `flags` | `team`. Objetos `point` de Tiled |

- **Capa obligatoria ausente** (`ground` sin ninguna tilelayer, `spawns` sin objetos) →
  el importador **lanza un `Error` que nombra la capa que falta**.
- Un object group con **nombre no reconocido** (p. ej. `decoracion`) se **ignora con un
  warning**; la decoración es puramente visual y vive en los assets del visor, no en el mapa.
- Si hay varias `tilelayer`, solo la primera se usa como `ground` (warning por el resto).
- El grid `navigation` del esquema **no se importa de Tiled**: es derivable de
  `ground`+`walls`+`destructibles` y lo precalcula el validador/servicio (T4.2/T4.3).

### `ground`: GID → material

Tiled numera los tiles con **GID 1-based** (0 = celda vacía). Se mapean a índices de la
tabla de materiales con `índice = GID - firstgid`; una celda vacía (GID 0) se interpreta
como `floor` (índice 0). Los 3 bits altos de volteo del GID se descartan. Un GID fuera del
rango de materiales se mapea a `floor` con un warning.

## Materiales base

El importador construye siempre esta tabla **fija** (espejo del ejemplo de E1). El índice
es lo que guarda `ground.data`; el `id` es lo que referencian los destructibles:

| idx | id | blocksMovement | blocksVision | extra |
|---|---|---|---|---|
| 0 | `floor` | false | false | — |
| 1 | `concrete` | true | true | — |
| 2 | `crate` | true | true | `hp: 120` |
| 3 | `acid` | false | false | `damagePerSecond: 8` |

Mantenerla fija hace el importador determinista sin depender de que el mapa traiga un
tileset con metadatos. `hp`/`blocksMovement`/`blocksVision` son atributos del **material**,
no de la forma: si un destructible declara un `hp` que no coincide con el de su material,
se emite un warning y **manda el del material** (no se reescribe en silencio).

## Propiedades personalizadas

### Del mapa (propiedades del mapa en Tiled)

`pixelsPerMeter` (float, **requerida**), `mapId`, `version` (int), `name`, `author`,
`license`, `supportedModes` (CSV, p. ej. `"capture_the_flag,team_deathmatch"`),
`supportedChassisSizes` (CSV), `navCellSizeM` (float), `maxDestructibles` (int),
`destructiblesMayBlockOnlyRoute` (bool).

### De los objetos

- **destructibles**: `material` (string, por defecto `crate`), `hp` (int, informativo).
- **zones**: `zoneType` (`damage|capture|no_entry|cover`), `team`, `damagePerSecond`, `captureTimeTicks`.
- **spawns**: `team` (requerido), `heading` (radianes, por defecto 0), `maxChassisSize` (`light|medium|heavy`).
- **bases** / **flags**: `team` (requerido).

El `objectId` del formato interno sale del **nombre** del objeto en Tiled (si cumple
`^[a-z0-9_\-]{1,32}$`); si no, se deriva de su `id`. El `team` ausente en un objeto que lo
requiere se sustituye por `neutral` con un warning.

> **Regla de oro:** toda propiedad personalizada **desconocida** (o reconocida pero sin
> destino en el esquema) genera un **warning** en la lista `warnings` que devuelve
> `importTiled`. Nunca una excepción, nunca un descarte silencioso.

## Firma

```ts
importTiled(tiled: TiledMap, opts?: { pixelsPerMeter?: number })
  : { map: InternalMap; warnings: string[] }
```

El checksum se asigna con `withChecksum()` de la base (`apps/map-service/src/canonical.ts`):
sha256 sobre la serialización canónica (claves ordenadas, sin espacios, sin el propio
campo `checksum`). Es estable entre ejecuciones y sistemas mientras el runtime sea un JS
estándar (no depende de `Intl` ni de locale).
