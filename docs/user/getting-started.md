# Primeros pasos

Crea tu primer bot, publícalo y míralo luchar. Son ocho pasos; el último es jugar.

> **Antes de empezar:** necesitas un navegador y una dirección de correo. Si ya tienes cuenta, empieza en el paso 2. Dentro de la web, el menú **«Ayuda»** repite este recorrido y la portada, con sesión iniciada, marca cuáles has hecho ya.

## 1. Crea tu cuenta

En la pantalla inicial pulsa **«Crear cuenta»** y rellena **«Nombre visible»** (el que verán los demás), **«Email»** y **«Contraseña»** (al menos 12 caracteres). Pulsa **«Registrarse y entrar»**: entras directamente. Más en [Cuentas](accounts.md).

## 2. Crea tu primer bot

Ve a **«Mis bots»**, escribe un nombre en **«Nombre del bot»** y pulsa **«Crear bot»**. Un bot es sólo la ficha: el equipamiento y el código vienen ahora.

## 3. Equípalo

Pulsa el nombre de tu bot: aparece el **editor de loadout**. El *loadout* es el vehículo: un chasis y una pieza en cada ranura (movimiento, energía, sensor, arma con su munición, radio, blindaje…) sin pasarte del presupuesto de créditos. Para un primer bot, una combinación equilibrada y válida es el **artillero**:

| Ranura | Pieza |
|---|---|
| Chasis | Chasis medio |
| Propulsión | Orugas |
| Energía | Generador básico |
| Sensor A | Radar básico |
| Torreta principal | Cañón de 60 mm con munición perforante |
| Blindaje frontal | Blindaje de acero frontal |
| Radio | Radio corta |

Cuesta **940 créditos de 1000**. Pulsa **«Guardar revisión»**. Todas las piezas, con sus cifras, en el [catálogo de equipamiento](equipment-catalog.md); cómo elegir, en [Equipamiento](equipment.md).

## 4. Programa el bot

En la tarjeta **«Subir código (pegado)»** elige el *runtime* (**Python** o **JavaScript**). El área **«Código»** ya trae una **plantilla que funciona**: va hacia el rival, usa tu radar o lidar y dispara. Puedes subirla tal cual para probar el recorrido, o cambiarla.

Para escribir tu propio bot, empieza por la [guía de programación](bots/index.md): un bot mínimo cabe en cuatro líneas, y los [ejemplos](bots/ejemplos.md) van de lo sencillo a jugar en equipo.

Pulsa **«Subir como versión nueva»**: se crea la versión 1, en estado `draft`.

## 5. Valida y publica

Pulsa **«Enviar a validación v1»**. La plataforma construye tu código y lo prueba en una batalla corta. Verás las etapas y, si todo va bien, la versión pasa a `validated`; si no, `rejected`, con el fichero, la línea y qué hacer. Cuando esté `validated`, pulsa **«Publicar v1»**. Sólo las versiones publicadas combaten. Más en [Bots](bots.md).

## 6. Crea un segundo bot

Una batalla necesita dos bots con una versión publicada. Repite los pasos 2 a 5 con otro bot (puede ser una copia del primero, con otro nombre). Si tienes dudas con algún término, abre «Ayuda» y mira el glosario.

## 7. Lanza tu primera batalla

Ve a **«Batallas» → «+ Nueva batalla»**. Elige:

- el tipo: **individual** (1 contra 1) o **por equipos**;
- las **reglas** (un conjunto oficial como «Duelo»; los detalles, en [Modos de juego](game-modes.md));
- un **mapa publicado** compatible con el modo;
- el bot y la versión de cada **bando** (rojo y azul).

Pulsa **«Crear batalla»**. Se encola y la plataforma la juega en cuanto hay hueco. Una batalla de práctica no cuenta para el ranking. Más en [Batallas](battles.md).

## 8. Míralo jugar

Desde **«Ver esta batalla»**, **«Batallas»** o **«Replays»** puedes ver cómo juega tu bot: en directo mientras está en curso ([Visor](viewer.md)) o en el [replay](replays.md) cuando termina. El detalle de la batalla trae las [estadísticas](statistics.md) y el diagnóstico de tu bot.

Y ahora, a **jugar**: cambia el código, prueba otro equipamiento, publica una versión nueva y vuelve a medirte. Cuando te veas con fuerzas, [inscribe tu bot en un torneo](tournaments.md) y sube en el [ranking](rankings.md).

## ¿Algo no sale?

- Si una versión se rechaza, la tarjeta de rechazo te dice la causa: [errores típicos](bots/probar.md#errores-típicos-y-qué-significan).
- Si la web muestra un aviso con «Reintentar», mira [Si algo falla](index.md#si-algo-falla).
