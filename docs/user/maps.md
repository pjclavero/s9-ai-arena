# Mapas

## Resumen

Hay dos pantallas de mapas que **no están conectadas entre sí**:

- **«Mapas»** (`#/maps`) trabaja con mapas guardados en la plataforma: listar, importar un fichero, generar uno procedural y publicar.
- **«Editor de mapas»** (`#/maps/editor`) dibuja un mapa **sólo en tu navegador**: no lo guarda y lo que exporta no se puede importar.

Sólo los mapas **publicados** se usan en batallas, y publicar exige el rol de organizador ([TD-010](../roadmap/technical-debt.md#td-010)).

## Índice

- [Ver los mapas](#ver-los-mapas)
- [Importar un mapa](#importar-un-mapa)
- [Generar un mapa procedural](#generar-un-mapa-procedural)
- [Publicar](#publicar)
- [El editor visual](#el-editor-visual)
- [Guardar, recuperar y duplicar](#guardar-recuperar-y-duplicar)
- [Usar un mapa en batalla](#usar-un-mapa-en-batalla)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Ver los mapas

**FUNCIONA ACTUALMENTE.** La tabla «Mapas registrados» muestra para cada versión:

- mapa y versión;
- estado: `draft`, `validated` o `published`;
- dimensiones en metros;
- modos;
- vista previa;
- acciones: «Publicar», o «Disponible para batallas» si ya está publicada.

La tabla incluye las versiones de todos los usuarios. El mapa de serie es `mvp-arena-01` (120×80 m). Ojo: su columna «Modos» muestra `deathmatch`, aunque el mapa está preparado para captura de bandera y combate por equipos (ver [Modos de juego](game-modes.md)).

## Importar un mapa

**FUNCIONA ACTUALMENTE** con ficheros en el formato interno de la plataforma o exportados de Tiled en JSON.

1. En «Importar un mapa existente» elige el fichero `.json` y pulsa **«Importar mapa»**.
2. La plataforma lo valida con 6 comprobaciones: geometría, navegación, jugabilidad, equilibrio, requisitos de cada modo y destructibles.
3. Si pasa, verás «Mapa "X" importado y validado (vN, borrador).» y la versión aparece como `validated`.
4. Si no pasa, verás «No se pudo importar el mapa: …» con la lista de comprobaciones fallidas, por ejemplo `[mode] el modo capture_the_flag no tiene banderas`.

Formato de referencia: el fichero `maps/mvp-arena-01.json` del repositorio. Detalle en [maps.md técnico](../technical/maps.md#formato-interno-internalmap).

## Generar un mapa procedural

**PARCIAL: sólo para organizadores.** En «Generar un mapa procedural» escribe una **semilla** y los **parámetros** en JSON (por ejemplo `{ "widthM": 40, "heightM": 40, "modes": ["deathmatch"] }`) y pulsa **«Generar mapa»**. La misma semilla siempre produce el mismo mapa. Un usuario sin el rol recibe «No se pudo generar el mapa: Requiere rol organizer».

## Publicar

**PARCIAL: sólo para organizadores.** Pulsa **«Publicar»** en una versión `validated`. Verás «Mapa "X" vN publicado: ya es jugable en batallas.» y se genera la vista previa. Una versión publicada no se puede modificar: para cambiarla hay que crear otra versión.

## El editor visual

**PARCIAL (sólo en el navegador).** En «Mapas» → «Abrir editor de mapas (borrador local)»:

- **Herramientas**: «Añadir muro», «Añadir obstáculo» (destructible, con salud) y «Añadir spawn» (equipo rojo o azul).
- **Edición**: selecciona un objeto en la lista «Objetos (N)» para editar su posición, tamaño, salud o equipo, o «Eliminar objeto».
- **Validación local**: «Avisos de validación (cliente)» detecta ids duplicados, objetos fuera de límites, tamaños no positivos y la falta de spawns.
- **Exportar JSON / Importar JSON**: copia y pega el texto del mapa entre sesiones.

Lo que **no** permite: suelo o terrenos, zonas, bases, banderas, ni la orientación del spawn.

## Guardar, recuperar y duplicar

**PENDIENTE.**

- **Guardar**: el editor no guarda en la plataforma (lo dice él mismo). Si recargas la página **pierdes lo editado**. La única forma de conservarlo es copiar el texto de «Exportar JSON».
- **Llevarlo a «Mapas»**: si importas ese texto en «Importar un mapa existente», el resultado es **«No se pudo importar el mapa: Error interno»**. El editor usa otro formato ([TD-010](../roadmap/technical-debt.md#td-010)).
- **Recuperar**: no se puede reabrir un mapa ya guardado en la plataforma para seguir editándolo.
- **Duplicar**: no existe; como alternativa, importa de nuevo el mismo fichero cambiando su `mapId`.

## Usar un mapa en batalla

- **En una batalla de práctica**: el selector «Mapa publicado» muestra los mapas publicados. **PENDIENTE**, porque crear la batalla falla ([Batallas](battles.md)).
- **En un torneo**: la web no deja elegir mapa; se juega siempre `mvp-arena-01` ([Torneos](tournaments.md)).
- **Modo y mapa**: la plataforma no comprueba que el mapa soporte el modo elegido.

## Errores / limitaciones

| Situación | Lo que ves |
|---|---|
| Importar el JSON del editor | «No se pudo importar el mapa: Error interno» |
| Generar o publicar sin ser organizador | «… Requiere rol organizer» (el formulario se muestra igual) |
| Parámetros mal escritos | «Los parámetros deben ser JSON válido.» |
| Recargar el editor | Se pierde lo editado |
| Editor en móvil | El lienzo se sale de la pantalla |

Lista completa: [known-issues.md](../roadmap/known-issues.md).

## Estado actual

**PARCIAL**: importar y listar funcionan; generar y publicar, sólo con organizador; el editor no se conecta con la plataforma.

## Documentación relacionada

- Usuario: [Modos de juego](game-modes.md), [Batallas](battles.md), [Torneos](tournaments.md)
- Técnica: [maps.md](../technical/maps.md), [game-modes.md](../technical/game-modes.md#compatibilidad-con-mapas)
- Deuda: [TD-010](../roadmap/technical-debt.md#td-010), [TD-017](../roadmap/technical-debt.md#td-017)
