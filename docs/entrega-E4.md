# E4 · Mapas y Generación Procedural — entrega v1

Cadena completa de mapas: importador Tiled→formato interno, checksum canónico,
traducción al `ArenaMap` del motor, validador exhaustivo (6 comprobaciones), servicio
de mapas versionado e inmutable, y generador procedural con semilla. Cubre **T4.1 a
T4.4** contra el esquema de E1 (`packages/map-schema/map.schema.json`) y la interfaz
`ArenaMap` de E2, sin duplicar el esquema ni tocar los fixtures del motor.

## Estado: 61 pruebas en verde

```bash
npx vitest run apps/map-service                          # 61 pruebas
node packages/module-catalog/scripts/validate-catalog.js  # (E1) el golden valida contra el esquema
npx tsx apps/map-service/src/cli.ts import maps/mvp-arena-01.tiled.json --out /tmp/out.json
npx tsx apps/map-service/src/generate/gen-testset.ts     # regenera los 20 mapas procedurales
```

Esta entrega se construyó en parte con **dos subagentes en paralelo** (T4.1 importador,
T4.2 validador) sobre una base compartida (checksum canónico, tipos del formato interno,
`toEngineMap`) escrita y verificada primero; T4.3 y T4.4 se integraron después. Cada
pieza trae sus propios tests y ninguna dependió de suposiciones sobre las otras más allá
de esa base.

## Contenido

```
apps/map-service/src/
  types.ts                  formato interno TS (espejo de map.schema.json de E1)
  canonical.ts              serialización canónica + checksum sha256 (base compartida)
  to-engine-map.ts          formato interno -> ArenaMap del motor (E2)
  import-tiled.ts           T4.1 · JSON de Tiled -> formato interno
  cli.ts                    T4.1 · map-service import <tiled.json> --out <json>
  validate/                 T4.2 · geometry, navigation, playability, balance, mode,
                            destruction, index (validateMap) + result, shapes
  service.ts                T4.3 · import/publish/get/list, inmutable, idempotente
  generate/index.ts         T4.4 · generateMap(params, seed) -> mapa validado
  generate/gen-testset.ts   T4.4 · genera los 20 mapas de prueba (semillas test-0..19)
apps/map-service/tests/     foundation, import-tiled, validate, service, generate
maps/
  mvp-arena-01.tiled.json   mapa MVP fuente (formato Tiled)
  mvp-arena-01.json         su versión importada (golden, versionado)
  procedural/proc-test-*.json  20 mapas procedurales de prueba (semillas 0–19)
tests/maps-broken/*.json    10 mapas rotos, uno por tipo de defecto
docs/mapas/formato-tmx.md   qué capas/propiedades de Tiled se esperan y por qué
```

## Estado de la DoD por tarea

| Tarea | Criterio | Estado |
|---|---|---|
| T4.1 | El MVP importa sin errores; su JSON coincide con el golden byte a byte | ✅ |
| T4.1 | Checksum estable entre ejecuciones (20×), sin dependencia de `Intl`/locale | ✅ |
| T4.1 | Propiedad personalizada desconocida → warning, nunca excepción | ✅ |
| T4.1 | Capa obligatoria ausente → error que NOMBRA la capa | ✅ (`ground`/`spawns`/`pixelsPerMeter`) |
| T4.2 | Cada mapa roto falla EXACTAMENTE en su comprobación y en ninguna otra | ✅ 10 mapas rotos |
| T4.2 | El MVP pasa las 6 comprobaciones para los 3 tamaños de chasis | ✅ 0 errores |
| T4.2 | Destrucción detecta la única ruta tapada por un destructible (`mayBlock:false`) | ✅ |
| T4.2 | `validateMap` es pura (mismo resultado en cada llamada) | ✅ |
| T4.3 | Publicar/reimportar el mismo contenido → misma versión (idempotencia por checksum) | ✅ |
| T4.3 | Modificar una versión publicada → error identificable, auditado | ✅ `immutable_version` + audit log |
| T4.3 | Un mapa inválido nunca alcanza `published` (forzándolo directamente) | ✅ |
| T4.3 | Integración real: mapa publicado → `toEngineMap` → `Battle` real sin lanzar | ✅ |
| T4.4 | Misma semilla+params → mismo checksum (100 ejecuciones) | ✅ |
| T4.4 | ≥90/100 semillas producen mapa válido en ≤2 intentos | ✅ 100/100 en 1 intento |
| T4.4 | Ningún mapa se publica sin pasar el validador (forzándolo) | ✅ |
| T4.4 | CTF generado especularmente simétrico; diferencia base→base exactamente 0 | ✅ por construcción |
| Final | Los fixtures del motor no se sustituyen; sus pruebas siguen en verde | ✅ no toqué `fixtures.ts` |

## Cifras medidas (no estimadas)

- **Pruebas:** 61 (foundation 8, import-tiled 11, validate 27, service 8, generate 7).
  `npx vitest run apps/map-service` en ~4,7 s.
- **Checksum del MVP importado:** `sha256:f3c11a20…c9bca`, estable en 20 reimportaciones.
- **Formato del checksum canónico:** `sha256:` + 64 hex (32 bytes). Serialización con
  claves ordenadas recursivamente, sin espacios; se apoya solo en el `Number→String`
  de ECMAScript (no `Intl`, no locale), por lo que es estable entre SO.
- **Validador:** 10 mapas rotos, cada uno dispara SOLO su comprobación
  (2 de navegación: sin ruta para nadie / ruta solo para ligero). El MVP y el mapa
  base bueno son publicables con 0 errores para los 3 chasis.
- **Generador:** 100/100 mapas válidos a la PRIMERA (0 reintentos) sobre 100 semillas
  reproducibles; determinismo confirmado en 100 ejecuciones (mismo checksum) y
  reproducibilidad byte a byte del set de 20 mapas (dos ejecuciones idénticas).
- **20 mapas procedurales** (`maps/procedural/proc-test-0..19.json`), todos válidos,
  para uso de otros equipos.

## Hallazgos reales

De los subagentes y de la integración, sin adornar:

**1. El esquema de E1 no permite `hp`/`blocksVision` por objeto, solo por material.**
Si un destructible de Tiled declara un `hp` distinto al de su material, el importador
emite un warning y usa el del material (no hay dónde guardar un hp por-objeto). Es una
limitación del contrato de E1 que conviene que E1 conozca.

**2. Pivote de rotación distinto entre Tiled y el formato interno.** Tiled rota los
objetos alrededor de su esquina (x,y); el formato interno, alrededor del centro. En el
MVP todas las rotaciones son 0, así que no afecta hoy, pero queda anotado como
limitación conocida del importador para mapas con formas rotadas.

**3. Ortogonalidad de las comprobaciones.** El validador tuvo que separar con cuidado
navegación, jugabilidad y destrucción para que un mismo defecto no disparara dos
comprobaciones (lo exige la DoD: "cada roto falla en su comprobación y en ninguna
otra"). Navegación trata los destructibles como transitables y delega en destruction.ts
toda la política de "¿puede un destructible ser la única barrera?"; playability solo
aplica su mínimo de anchura cuando navegación ya pasa para todos los chasis. Es el tipo
de acoplamiento que solo se ve al escribir el corpus de mapas rotos.

**4. Radios de chasis reales, no genéricos.** El enunciado sugería "ligero≈1.0 m"; el
catálogo real de E3 tiene `radiusM` 1.2/1.6/2.0. El validador usa los reales
(`CHASSIS_COLLISION_RADIUS_M`), con clearance = radio + `NAV_CLEARANCE_MARGIN_M` (0.25),
importado de `game-rules`, no inventado.

**5. `tsc` standalone no está verde en el repo por falta de `@types/node`** — afecta a
`node:crypto` en `canonical.ts` y a archivos de otros equipos. El repo gatea con
vitest/esbuild (que sí compila y ejecuta todo), no con `tsc`. Ningún archivo de E4
genera errores de tipo propios. Es deuda de tooling del monorepo (de E10), no de E4.

## Notas para otros equipos

**Para E2 (motor).** `toEngineMap()` es la única puerta entre el formato de
almacenamiento de E1 y el `ArenaMap` que consume `sim/`. El motor nunca lee el formato
interno directamente. Las formas `polygon`/`circle` de muros se aproximan por su caja
delimitadora (la física del MVP trabaja con rectángulos); el polígono exacto se conserva
en el formato interno para el validador y el visor.

**Para E7 (plataforma).** `MapService` es la librería que llamarán los endpoints
`/maps`. `validateMap(map).checks` tiene la forma EXACTA de `MapInvalid` de
`openapi.yaml` (`{check, severity, message}`): se reenvía tal cual en un 422. `isPublishable`
decide si se permite publicar. El `checksum` que emite este servicio es el que debe
acabar en `WELCOME.map.checksum` (E5).

**Para E10 (CI).** Instalar `@types/node` dejaría verde el `tsc` del monorepo.

## Lo que queda fuera de esta entrega

- **Grid `navigation` precalculado en el mapa importado.** El importador no emite la capa
  `navigation` (el esquema la admite pero es derivable); el validador construye el grid
  al vuelo. Precalcularlo y guardarlo es una optimización para E7/E10.
- **Parser de TMX (XML) nativo.** El importador consume el export **JSON** de Tiled, no
  el `.tmx` XML (documentado en `docs/mapas/formato-tmx.md`; la CLI rechaza `.tmx`).
- **Miniatura como PNG real.** `publishMap` genera un SVG placeholder (silueta de muros
  y bases) como data URI, no un render del visor (eso es de E8).
