# Mapas

Hay dos pantallas, y trabajan sobre los **mismos mapas, guardados en la plataforma**:

- **«Editor de mapas»** (dentro de «Mapas»): dibujas tu mapa, lo **guardas**, lo reabres cuando quieras y lo publicas.
- **«Mapas»**: lista los mapas, importa un fichero, genera uno procedural (organizadores) y publica. Cada fila tiene «Editar» o «Abrir en el editor».

Sólo los mapas **publicados** se usan en batallas. Tus borradores sólo los ves y los cambias tú.

## Las medidas de un mapa

Un mapa es un rectángulo medido en **metros**. Se dice **Ancho** (de izquierda a derecha) y **Largo** (de abajo a arriba). El origen `(0, 0)` es la esquina inferior izquierda. Los bots leen estas medidas en el mensaje de bienvenida de la batalla ([guía de programación](bots/ciclo.md#coordenadas-y-unidades)).

Todo mapa tiene además un **perímetro** invisible en su borde: los vehículos no salen y los proyectiles chocan, aunque no dibujes muros.

## Qué se puede poner en un mapa

La paleta del editor tiene estas herramientas:

| Objeto | Para qué |
|---|---|
| **Muro** | Obstáculo fijo: bloquea el movimiento, la visión y los disparos. |
| **Caja** | Obstáculo destructible: bloquea mientras existe; se rompe a disparos. |
| **Zona de daño** | Círculo que quita vida cada segundo a quien esté dentro. |
| **Zona de captura** | Círculo que hay que ocupar en el modo Control de zona. |
| **Punto de aparición** (rojo y azul) | Dónde nace un vehículo de ese bando y hacia dónde mira. |
| **Base** (roja y azul) | La base de un bando (en la batalla cuenta como un círculo). |
| **Bandera** (roja y azul) | Una bandera con su equipo; se recoge acercándose. |

- Si un bando tiene más vehículos que puntos de aparición, el motor coloca los demás alrededor de los del mapa, nunca más cerca del rival.
- Una **base** rectangular cuenta como el círculo inscrito (manda la dimensión menor); una **zona** también.
- Las zonas de tipo «no entrar» o «cobertura» sólo cuentan para validar el mapa, no llegan a la batalla.
- Una caja tiene vida según su material. Un mapa no debe depender de romper cajas para llegar a los objetivos, salvo que lo declare.

## Crear y guardar un mapa

1. «Mapas» → «Abrir el editor de mapas» (o «Nuevo» dentro del editor). Empiezas con una arena de 120×80 m y dos puntos de aparición, rojo y azul.
2. Pon el **id** (minúsculas, dígitos y guiones), el **nombre**, el **Ancho del mapa**, el **Largo del mapa** y marca los **modos de juego** que soporta (al menos uno).
3. Elige una herramienta de la paleta y pulsa en el mapa para colocar el objeto. Después **arrástralo** para moverlo, usa sus **tiradores** para redimensionarlo o edita sus propiedades (posición, **Ancho**, **Largo**, radio, equipo…) en el panel lateral. Hay rejilla con ajuste opcional, zoom, **Deshacer/Rehacer** (Ctrl+Z, Ctrl+Y), copiar y pegar, duplicar y borrar.
4. Pulsa **«Guardar en el servidor»**. Verás «Guardado en el servidor: `<id>` v1 (borrador).».

Debajo aparece la **validación del servidor**: geometría, navegación, jugabilidad, equilibrio, requisitos de cada modo y destructibles. Puedes guardar con avisos o errores; **para publicar no puede quedar ningún error**. Mientras el mapa sea borrador, guardar reescribe la misma versión.

## Lo que exige cada modo

Cada mapa **declara** los modos que soporta y se comprueba que tenga lo necesario. En «Nueva batalla» el selector de mapas sólo muestra los que admiten el modo elegido.

| Modo | El mapa necesita |
|---|---|
| Deathmatch | al menos 2 puntos de aparición |
| Deathmatch por equipos | puntos de aparición de al menos 2 bandos |
| Captura la bandera | una base y una bandera de cada equipo (rojo y azul), y que cada bando tenga las suyas |
| Control de zona | al menos una zona de captura |

Otras comprobaciones al guardar y publicar: tamaño válido, objetos dentro del mapa y con medidas válidas, puntos de aparición fuera de muros y cajas (con aviso si están en una zona de daño), y que no se solapen una zona de captura y una de daño (capturar obligaría a recibir daño).

## Reabrir, seguir editando y duplicar

- **Recargar (F5)**: la dirección recuerda qué mapa tienes abierto y lo recarga.
- **Mis mapas**: lista lo que has guardado; «Abrir» lo carga, también tras cerrar sesión.
- **Desde «Mapas»**: «Editar» en cualquiera de tus mapas.
- **Duplicar**: escribe un id nuevo y pulsa «Guardar como copia». Sirve también para partir de un mapa de otra persona.

## Publicar

Con el mapa guardado y sin cambios pendientes, pulsa **«Publicar»** en el editor, o «Publicar» en su fila de «Mapas». Si no tiene errores, verás «Publicado …: ya se puede usar en batallas» y se genera la vista previa.

Una versión publicada **no cambia nunca**. Si sigues editando y guardas, se crea la versión siguiente como borrador.

## Exportar e importar

- **Exportar**: el editor muestra el JSON del mapa y ofrece «Descargar `<id>`.json».
- **Importar en «Mapas»**: el fichero exportado se importa tal cual. Si tiene el id de un mapa tuyo, se añade como versión nueva; si quieres un mapa aparte, cambia el id.
- **Importar en el editor**: pega un JSON en «Importar JSON». Acepta el formato de la plataforma y el formato antiguo del editor, que convierte a metros.

## Generar un mapa procedural

Sólo para organizadores: escribe una semilla y los parámetros en JSON y pulsa «Generar mapa». La misma semilla produce siempre la misma geometría.

## Mapas de serie

`mvp-arena-01` (captura de bandera y combate por equipos) y `mvp-arena-02` (la misma arena, que además admite deathmatch). Ninguno admite control de zona.

## Quién puede hacer qué

| Acción | Quién |
|---|---|
| Crear un mapa | Cualquier usuario (queda como dueño) |
| Editar, guardar o añadir versiones | Sólo su dueño (o un administrador). A otro usuario le sale «Ese mapa pertenece a otro usuario…» y puede duplicarlo |
| Publicar | Su dueño, o un organizador |
| Ver borradores | Sólo su dueño |
| Ver mapas publicados | Todo el mundo, sin cuenta |

## Errores frecuentes

| Situación | Lo que ves |
|---|---|
| Guardar sobre un mapa ajeno | «No se pudo guardar: … pertenece a otro usuario (… duplícalo con otro id)» |
| Publicar con errores de validación | «No se pudo publicar: …» y la lista de comprobaciones |
| Id con mayúsculas o espacios | Aviso en «Avisos (cliente)»; el servidor lo rechaza |
| Generar sin ser organizador | «… Requiere rol organizer» |

No se pueden borrar mapas ni versiones. No hay polígonos ni edición de materiales.

Siguiente: [Modos de juego](game-modes.md) · [Batallas](battles.md).
