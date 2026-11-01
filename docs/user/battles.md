# Batallas

## Resumen

Una **batalla de práctica** enfrenta a dos bots (bando rojo contra bando azul) en un mapa publicado. No cuenta para el ranking. Se crea en **«Batallas» → «+ Nueva batalla de práctica»**. Puedes usar **tus bots** (aunque sean privados), bots **públicos** de otros y bots de un **equipo** del que eres miembro; nunca los bots privados de otra persona.

En una batalla juega una **versión publicada** concreta de cada bot, con el **loadout** con el que se subió esa versión ([Equipamiento](equipment.md)). La juega el código de cada bot, cada uno en su propio contenedor aislado: lo que hace tu bot en la batalla es lo que programaste. Si la ejecución está activada en el servidor que usas lo dice [current-status.md](../roadmap/current-status.md).

## Índice

- [Conceptos: bot, versión y bando](#conceptos-bot-versión-y-bando)
- [Crear una batalla de práctica](#crear-una-batalla-de-práctica)
- [Qué pasa después](#qué-pasa-después)
- [Lista de batallas](#lista-de-batallas)
- [Detalle de una batalla](#detalle-de-una-batalla)
- [Quién ve qué](#quién-ve-qué)
- [La arena tiene perímetro](#la-arena-tiene-perímetro)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Conceptos: bot, versión y bando

- Un **bot** es tu programa. Una **versión de bot** es una entrega concreta de su código (v1, v2…). En una batalla juegan **versiones publicadas**.
- Una versión publicada antigua **sigue pudiendo jugar** aunque la última esté rechazada o en validación.
- Excepción: si el loadout de una versión publicada ya no cumple la validación actual (p. ej. un cañón con munición estándar, de antes de la corrección de munición), aparece como **«Publicada · No elegible»**, deshabilitada y con el motivo. Se conserva en el histórico y sus replays se siguen viendo; sólo no puede entrar en batallas ni torneos nuevos. Usa otra versión elegible o crea una versión nueva con el loadout corregido.
- El **bando** (rojo o azul) es sólo el lado del campo. **No es un equipo** de la sección «Equipos»: aquí los equipos sólo sirven para filtrar la lista de bots. Dos bots del mismo equipo pueden enfrentarse.

## Crear una batalla de práctica

Pantalla «Nueva batalla de práctica»:

| Campo | Qué eliges |
|---|---|
| **Modo** | Deathmatch, Deathmatch por equipos, Captura la bandera o Control de zona ([Modos de juego](game-modes.md)). Son los mismos nombres que en el Ranking |
| **Ruleset** | Las reglas de ese modo, con su presupuesto en créditos |
| **Mapa publicado** | Sólo los mapas publicados que declaran soportar el modo elegido. Si no hay ninguno, la pantalla dice qué modos sí tienen mapas |
| **Semilla (opcional)** | La misma semilla repite la misma batalla |
| **Bando rojo / Bando azul** | En cada bando: un filtro opcional por equipo, el **bot** y la **versión publicada** que juega |

En el desplegable de bots:

- cada bot elegible muestra la versión que juega por defecto, la publicada más reciente: «Tanque (v3)». Si su última versión no está publicada lo añade: «(v3) · última versión: v4 rechazada»;
- los bots que no pueden jugar salen **desactivados** y con el motivo y qué hacer: «no elegible: ninguna versión publicada — tienes v2 rechazada: corrige el código y vuelve a enviarla».

Si el bot tiene varias versiones publicadas, el selector **«Versión publicada»** te deja elegir cualquiera; la marcada «(la más reciente publicada)» es la que se usa si no eliges otra.

Debajo, **«Qué falta para crear la batalla»** lista cada requisito con ✓ o ✗: ruleset, mapa y la versión de cada bando. **«Tus bots que todavía no pueden jugar»** enlaza cada bot tuyo no elegible con su motivo.

Pulsa **«Crear batalla»**. Si algo falla, el error aparece arriba con su tipo (datos no válidos, sin permiso, conflicto…) y el mensaje del servidor.

## Qué pasa después

1. Ves «Batalla encolada» y el enlace **«Ver esta batalla»**, que abre su [detalle](#detalle-de-una-batalla).
2. La plataforma la juega en cuanto hay hueco. La batalla se juega una sola vez, aunque pulses dos veces o la plataforma reintente.
3. Dura lo que dicen las reglas (unos 5 minutos en tiempo real a lo sumo). Mientras está **en curso** puedes verla en directo ([Visor](viewer.md)).

Si en ese servidor la ejecución no está activada, la batalla se queda **en cola**: no se juega con ningún bot de prueba en su lugar.

## Lista de batallas

«Batallas» muestra las batallas **que puedes ver** ([Quién ve qué](#quién-ve-qué)), con:

- participantes por **nombre y versión**, con su bando: «Tanque Rojo v3 (red) vs Muro Azul v1 (blue)». El enlace abre el detalle;
- modo en palabras y mapa por su nombre;
- estado: en cola, en curso, terminada o fallida;
- resultado: ganador con su nombre y versión, marcador y descalificados;
- duración y torneo (enlace);
- **Ver**: «Ver en directo» si está en curso, «Ver replay» si terminó.

Puedes filtrar por **Estado**. Desde «Mis bots», el enlace «batallas» filtra por un bot (sólo sobre la primera página de resultados).

## Detalle de una batalla

Cada batalla tiene su página, `#/battles/<id>` (desde la lista, desde «Ver esta batalla» o desde un torneo):

- **resultado**: ganador con nombres, marcador, duración en ticks y en tiempo, modo, mapa y versiones del motor;
- **participantes**: bot, versión exacta que jugó, bando y resultado;
- **estadísticas por bot**: disparos, aciertos, precisión, daño hecho y recibido, bajas, supervivencia, recorrido, turnos sin responder, objetivos y uso de cada módulo, con lo que mide cada una ([Estadísticas](statistics.md)). Justo al terminar puede decir «Calculando estadísticas…»: la página vuelve a preguntar sola;
- **diagnóstico de tus bots**: si arrancó, el saludo (HELLO), decisiones, turnos sin responder, descalificación y motivo, COMMAND inválidos con el primer motivo, acciones rechazadas por el motor y CPU ([Diagnóstico](statistics.md#diagnóstico-de-tus-bots));
- enlace **«Ver replay»** cuando hay replay.

Una batalla en cola o en curso se actualiza sola y lo anuncia a los lectores de pantalla. Una batalla ajena que no puedes ver, o un enlace equivocado, dice «No existe o no está disponible».

## Quién ve qué

- **La batalla** (lista, detalle, estadísticas, directo y replay) la ven:
  - el dueño de cualquiera de sus bots;
  - los miembros del equipo de un bot participante que no sea privado;
  - el staff;
  - cualquiera, sólo si **todos** sus bots son públicos y el servidor tiene activado el replay o el directo públicos.
- **El diagnóstico y la CPU de un bot** sólo los ve **su dueño** (y el staff). Un rival o un compañero de equipo ve la batalla, pero no las tripas de un bot que no es suyo.
- Para quien no puede verla, una batalla responde igual que una que no existe.

## La arena tiene perímetro

Todo mapa está cerrado por un **perímetro** en su borde, lo dibuje el mapa o no: los vehículos no pueden salir del mapa y los proyectiles chocan con el borde. Los sensores lo ven como un muro más. Un mapa no puede colocar spawns fuera de sus límites (se rechaza al publicarlo).

## Errores / limitaciones

- Sólo 2 bots por batalla; no se elige un loadout distinto por batalla (juega el de la versión).
- El mismo bot no puede estar dos veces en una batalla (ni con dos versiones distintas).
- Si eliges un bot privado de otra persona, la plataforma responde como si no existiera («no existe o no es accesible»).
- Si tu bot no llega a conectarse a la batalla, pierde por descalificación; si deja de responder durante la batalla, queda descalificado.
- Si tu bot manda un COMMAND con forma inválida, no se aplica: tu bot recibe el aviso `rejected_action` con `invalid_command: …` y lo verás contado en su diagnóstico.
- En la lista y en el detalle, el bando sale como `red` / `blue`.

Lista completa: [known-issues.md](../roadmap/known-issues.md).

## Estado actual

- **FUNCIONA ACTUALMENTE** en el código: creación con selector de versión, ejecución con el código y el loadout de cada versión, lista y detalle con resultado, estadísticas y diagnóstico del dueño, política de lectura única y perímetro de la arena.
- Si la ejecución está activada en un servidor concreto: [current-status.md](../roadmap/current-status.md).

## Documentación relacionada

- Usuario: [Modos de juego](game-modes.md), [Bots](bots.md), [Equipamiento](equipment.md), [Estadísticas](statistics.md), [Replays](replays.md), [Visor](viewer.md), [Torneos](tournaments.md)
- Técnica: [battles.md](../technical/battles.md) (ciclo completo paso a paso, visibilidad y diagnóstico)
- Deuda: [TD-001](../roadmap/technical-debt.md#td-001), [TD-002](../roadmap/technical-debt.md#td-002), [TD-005](../roadmap/technical-debt.md#td-005), [TD-047](../roadmap/technical-debt.md#td-047)
