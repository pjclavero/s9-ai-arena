# Batallas

Una **batalla** enfrenta a bots en un mapa, bajo las reglas de un modo. En **«Batallas» → «+ Nueva batalla»** creas una **batalla de práctica**: sirve para probar tu bot, no es oficial y **no cuenta para el ranking**. Las **batallas oficiales** son las de los [torneos](tournaments.md), las crea la plataforma y son las únicas que mueven el [ranking](rankings.md).

En una batalla juega una **versión publicada** concreta de cada bot, con el **equipamiento** con el que se subió esa versión ([Equipamiento](equipment.md)). La juega el código de cada bot, cada uno en su propio entorno aislado: lo que hace tu bot es lo que programaste.

## Práctica y oficial: la diferencia

| | «Nueva batalla» (práctica) | Batalla de torneo (oficial) |
|---|---|---|
| Quién la crea | Tú | La plataforma, al cerrar las inscripciones |
| Cuenta para el rating | **No** | **Sí** |
| Qué bots | Los tuyos, públicos de otros o de un equipo tuyo | Los inscritos |
| Directo | Sin retardo | Con retardo de 30 segundos (salvo las batallas marcadas como visibles, como la final), para que nadie haga de entrenador |
| Reglas | Las que eliges | Las que fijó el torneo (copia inmutable) |

## Conceptos: bot, versión y bando

- Un **bot** es tu programa. Una **versión de bot** es una entrega concreta de su código (v1, v2…). En una batalla juegan **versiones publicadas**.
- Una versión publicada antigua **sigue pudiendo jugar** aunque la última esté rechazada o en validación. Si el equipamiento de una versión publicada ya no cumple la validación, aparece como **«Publicada · No elegible»**: deshabilitada y con el motivo ([Bots](bots.md#publicar)).
- El **bando** (rojo o azul) es sólo el lado del campo. **No es un equipo** de la sección [Equipos](teams.md). Dos bots del mismo equipo pueden enfrentarse.

## Crear una batalla de práctica

La pantalla «Nueva batalla» empieza por el **tipo**:

- **Batalla individual**: un bot contra otro (1 contra 1).
- **Batalla por equipos**: hasta **4 bots por bando** (4 contra 4). Eliges dos equipos de la sección Equipos: el *Equipo A* juega en el bando rojo y el *Equipo B* en el azul. Cada bot juega su versión publicada (puedes elegir otra), y un bot sólo puede jugar una vez.

Después:

| Campo | Qué eliges |
|---|---|
| **Reglas** | Un conjunto oficial («Duelo», «Team Deathmatch»…), «Personalizado» o «Clásico» ([Modos de juego](game-modes.md)). El oficial fija el modo. |
| **Modo** | Deathmatch, Deathmatch por equipos, Captura la bandera o Control de zona. |
| **Ruleset** | Las reglas de ese modo, con su presupuesto en créditos. |
| **Mapa publicado** | Sólo los mapas publicados que soportan el modo elegido. Si no hay ninguno, la pantalla dice qué modos sí tienen mapas. |
| **Semilla (opcional)** | La misma semilla repite la misma batalla. |
| **Bando rojo / Bando azul** | En cada bando: un filtro opcional por equipo, el **bot** y la **versión publicada** que juega. |

En el desplegable de bots:

- cada bot elegible muestra la versión que juega por defecto, la publicada más reciente: «Tanque (v3)». Si su última versión no está publicada lo añade: «(v3) · última versión: v4 rechazada»;
- los bots que no pueden jugar salen **desactivados**, con el motivo y qué hacer: «no elegible: ninguna versión publicada — tienes v2 rechazada: corrige el código y vuelve a enviarla».

Si el bot tiene varias versiones publicadas, el selector **«Versión publicada»** deja elegir cualquiera. Debajo, **«Qué falta para crear la batalla»** lista cada requisito con ✓ o ✗ (reglas, mapa y la versión de cada bando), y **«Tus bots que todavía no pueden jugar»** enlaza cada bot tuyo no elegible con su motivo.

Pulsa **«Crear batalla»**. Si algo falla, el error aparece arriba con su tipo y el mensaje del servidor.

Puedes usar **tus bots** (aunque sean privados), bots **públicos** de otros y bots de un **equipo** del que eres miembro; nunca los bots privados de otra persona.

## Qué pasa después

1. Ves «Batalla encolada» y el enlace **«Ver esta batalla»**.
2. La plataforma la juega en cuanto hay hueco. Se juega **una sola vez**, aunque pulses dos veces o la plataforma reintente.
3. Dura lo que dicen las reglas (hasta unos 5 minutos en tiempo real, y más si hay prórroga). Mientras está **en curso** puedes verla en directo ([Visor](viewer.md)).

Si tu batalla se queda en cola mucho rato, es que la plataforma no está ejecutando batallas en ese momento: avisa a quien administre tu servidor.

## Lista de batallas

«Batallas» muestra las batallas **que puedes ver** ([Quién ve qué](#quién-ve-qué)), con:

- los participantes por **nombre y versión** y su bando: «Tanque Rojo v3 (red) vs Muro Azul v1 (blue)»; el enlace abre el detalle;
- el modo y el mapa por su nombre;
- el estado: en cola, en curso, terminada o fallida;
- el resultado: ganador, marcador y descalificados;
- la duración y el torneo (si es de torneo);
- **Ver**: «Ver en directo» si está en curso, «Ver replay» si terminó.

Puedes filtrar por **Estado**. Desde «Mis bots», el enlace «batallas» filtra por un bot.

## Detalle de una batalla

Cada batalla tiene su página (desde la lista, desde «Ver esta batalla» o desde un torneo):

- el **resultado**: ganador, marcador, duración, modo, mapa y versiones del motor;
- los **participantes**: bot, versión exacta que jugó, bando y resultado;
- las **estadísticas por bot**: disparos, aciertos, precisión, daño hecho y recibido, bajas, supervivencia, recorrido, turnos sin responder, objetivos y uso de cada módulo ([Estadísticas](statistics.md)). Justo al terminar puede decir «Calculando estadísticas…»: la página vuelve a preguntar sola;
- el **diagnóstico de tus bots**: si arrancó, cuántas decisiones aplicó, descalificación y motivo, órdenes inválidas, acciones rechazadas y CPU ([Diagnóstico](statistics.md#diagnóstico-de-tus-bots));
- el enlace **«Ver replay»** cuando hay replay.

Una batalla en cola o en curso se actualiza sola. Una batalla que no puedes ver, o un enlace equivocado, dice «No existe o no está disponible».

## Quién ve qué

- **La batalla** (lista, detalle, estadísticas, directo y replay) la ven:
  - el dueño de cualquiera de sus bots;
  - los miembros del equipo de un bot participante que no sea privado;
  - el staff;
  - cualquiera, sólo si **todos** sus bots son públicos y la plataforma tiene activados el replay y el directo públicos.
- **El diagnóstico y la CPU de un bot** sólo los ve **su dueño** (y el staff). Un rival o un compañero ve la batalla, pero no las tripas de un bot ajeno.
- Para quien no puede verla, una batalla responde igual que una que no existe.

## La arena tiene perímetro

Todo mapa está cerrado por un **perímetro** en su borde, lo dibuje el mapa o no: los vehículos no pueden salir y los proyectiles chocan con el borde. Los sensores lo ven como un muro más.

## Si tu bot falla

- Si tu bot no llega a conectarse, pierde por descalificación; si deja de responder durante la batalla, queda descalificado ([El ciclo de una batalla](bots/ciclo.md#el-plazo-para-decidir)).
- Si manda una orden mal formada, no se aplica y recibe un `rejected_action` con `invalid_command: …`; lo verás contado en su diagnóstico.
- El mismo bot no puede estar dos veces en una batalla, ni con dos versiones distintas.
- Si eliges un bot privado de otra persona, la plataforma responde como si no existiera.

Siguiente: [Torneos](tournaments.md) · [Replays](replays.md) · [Estadísticas](statistics.md).
