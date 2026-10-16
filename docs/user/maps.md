# Mapas

## Resumen

Hay dos pantallas, y ahora trabajan sobre los **mismos mapas, guardados en la plataforma**:

- **«Editor de mapas»** (`#/maps/editor`): dibujas tu mapa, lo **guardas en el servidor**, lo reabres cuando quieras (también tras recargar o volver a entrar) y lo publicas.
- **«Mapas»** (`#/maps`): lista los mapas, importa un fichero, genera uno procedural y publica. Cada fila tiene «Editar» o «Abrir en el editor».

Sólo los mapas **publicados** se usan en batallas. Tus mapas sólo los puedes cambiar tú.

## Índice

- [Crear y guardar un mapa en el editor](#crear-y-guardar-un-mapa-en-el-editor)
- [Reabrir, seguir editando y duplicar](#reabrir-seguir-editando-y-duplicar)
- [Publicar](#publicar)
- [Exportar e importar](#exportar-e-importar)
- [Ver los mapas](#ver-los-mapas)
- [Generar un mapa procedural](#generar-un-mapa-procedural)
- [Usar un mapa en batalla](#usar-un-mapa-en-batalla)
- [Quién puede hacer qué](#quién-puede-hacer-qué)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Crear y guardar un mapa en el editor

**FUNCIONA ACTUALMENTE.**

1. «Mapas» → «Abrir el editor de mapas» (o «Nuevo» dentro del editor). Empiezas con una arena de 120×80 m y dos spawns, rojo y azul.
2. En «Mapa» pon el **id** (minúsculas, dígitos y guiones), el **nombre**, el ancho, el alto y los **modos** que soporta.
3. Añade objetos: muro, destructible, spawn, base, bandera y zona (de captura o de daño). Selecciona uno en «Objetos» para cambiar su posición, tamaño o radio, equipo o tipo, o para eliminarlo.
4. Pulsa **«Guardar en el servidor»**. Verás «Guardado en el servidor: `<id>` v1 (borrador).».

Debajo aparece la **validación del servidor**: geometría, navegación, jugabilidad, equilibrio, requisitos de cada modo y destructibles. Puedes guardar con avisos o errores. Para publicar no puede quedar ningún error.

Mientras el mapa siga siendo borrador, guardar **reescribe la misma versión**.

## Reabrir, seguir editando y duplicar

**FUNCIONA ACTUALMENTE.**

- **Recargar (F5)**: la dirección del editor (`#/maps/editor?map=<id>&v=<n>`) recuerda qué mapa tienes abierto, y al recargar se vuelve a cargar desde la plataforma.
- **Mis mapas**: lista lo que has guardado; «Abrir» lo carga. También funciona tras cerrar sesión y volver a entrar.
- **Desde «Mapas»**: «Editar» en cualquiera de tus mapas.
- **Duplicar**: en «Duplicar» escribe un id nuevo y pulsa «Guardar como copia». Sirve también para partir de un mapa de otra persona.

## Publicar

**FUNCIONA ACTUALMENTE.** Con el mapa guardado y sin cambios pendientes, pulsa **«Publicar»** en el editor, o «Publicar» en su fila de «Mapas».

- Si no tiene errores, verás «Publicado …: ya se puede usar en batallas» y se genera la vista previa.
- Una versión publicada **no cambia nunca**. Si sigues editando y guardas, se crea la versión siguiente como borrador.

## Exportar e importar

**FUNCIONA ACTUALMENTE.**

- **Exportar**: el editor muestra el JSON del mapa y ofrece «Descargar `<id>`.json». Es el formato de la plataforma.
- **Importar en «Mapas»**: el fichero exportado se importa tal cual en «Importar un mapa existente». Si tiene el id de un mapa tuyo, se añade como versión nueva; si quieres un mapa aparte, cambia el id.
- **Importar en el editor**: pega un JSON en «Importar JSON». Acepta el formato de la plataforma y el formato antiguo del editor (`id`, `width`, `walls`…), que convierte a metros.
- «Mapas» rechaza el formato antiguo con un mensaje que te manda al editor, en lugar del antiguo «Error interno».

## Ver los mapas

**FUNCIONA ACTUALMENTE.** «Mapas registrados» muestra nombre, id, «(tuyo)», versión, estado, dimensiones, modos, vista previa y acciones.

- Los **borradores sólo los ves tú**.
- Mapas de serie:
  - `mvp-arena-01`: captura de bandera y combate por equipos;
  - `mvp-arena-02`: la misma arena, que además declara deathmatch.

## Generar un mapa procedural

**PARCIAL: sólo para organizadores.** Escribe una semilla y los parámetros en JSON y pulsa «Generar mapa». La misma semilla produce siempre la misma geometría.

## Usar un mapa en batalla

**FUNCIONA ACTUALMENTE** en batallas de práctica. En «Nueva batalla» eliges el **modo** y el selector «Mapa publicado» sólo ofrece mapas que soportan ese modo, incluidos los tuyos publicados. Ver [Batallas](battles.md) y [Modos de juego](game-modes.md).

## Quién puede hacer qué

| Acción | Quién |
|---|---|
| Crear un mapa | Cualquier usuario (queda como dueño) |
| Editar, guardar o añadir versiones | Sólo su dueño (o un admin). Otro usuario recibe «Ese mapa pertenece a otro usuario…» y puede duplicarlo |
| Publicar | Su dueño, o un organizador |
| Ver borradores | Sólo su dueño |
| Ver mapas publicados | Todo el mundo, sin cuenta |

## Errores / limitaciones

| Situación | Lo que ves |
|---|---|
| Guardar sobre un mapa ajeno | «No se pudo guardar: … pertenece a otro usuario (… duplícalo con otro id)» |
| Publicar con errores de validación | «No se pudo publicar: …» y la lista de comprobaciones |
| Id con mayúsculas o espacios | Aviso en «Avisos (cliente)»; el servidor responde 400 |
| Generar sin ser organizador | «… Requiere rol organizer» |

Además:

- No se pueden borrar mapas ni versiones.
- No hay polígonos ni edición de materiales. Los objetos se mueven con los campos numéricos, no arrastrando.

## Estado actual

**FUNCIONA ACTUALMENTE**: crear, guardar, reabrir, editar, publicar y usar en batalla, con export e import compatibles. Comprobado con un navegador real. **PARCIAL**: generar (sólo organizador).

## Documentación relacionada

- Usuario: [Modos de juego](game-modes.md), [Batallas](battles.md), [Equipos](teams.md)
- Técnica: [maps.md](../technical/maps.md), [game-modes.md](../technical/game-modes.md)
- Deuda: [TD-010](../roadmap/technical-debt.md#td-010), [TD-017](../roadmap/technical-debt.md#td-017)
