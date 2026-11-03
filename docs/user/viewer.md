# Visor en directo y espectador

El **visor** muestra una batalla en directo: vehículos, disparos, daño, marcador, reloj y equipos, con varias cámaras. **«En directo»** lista las batallas en curso. Cuando la batalla termina, el visor te lleva a su [replay](replays.md), que usa la misma escena.

## Abrir el visor

Desde **«Batallas»**, el detalle de una batalla o el de un torneo, el enlace **«Ver en directo»** aparece mientras la batalla está en curso. Una batalla terminada enlaza a **«Ver replay»**.

El visor te dice en qué punto está:

| Estado | Significado | Qué puedes hacer |
|---|---|---|
| «inicializando visor…» | El motor gráfico arranca. | Esperar unos segundos. |
| «conectando…» | Pidiendo el pase de espectador y abriendo la conexión. | Esperar. |
| «en directo» | Recibiendo la batalla. | — |
| «reconectando…» / «en directo (reconectado)» | Corte de red y recuperación automática. | — |
| «batalla terminada» | Fin, con el resultado sobre el lienzo. | «Ver el replay de esta batalla». |
| «La batalla no está en directo…» | Ya terminó o aún no empezó. | Ir al replay. |
| «Esta batalla no existe o no se puede ver en directo sin cuenta.» | Identificador incorrecto, o visitante sin cuenta con la emisión pública desactivada. | Iniciar sesión o abrir el replay. |
| «sin conexión con el servidor de directo tras varios intentos» | Se agotaron los reintentos. | «Reintentar». |

Si la batalla no se puede ver, el visor lo dice y se detiene: no se queda en «conectando…» para siempre.

## Qué muestra

- vehículos con su nombre y chasis, y disparos con su trayectoria;
- daño, y minas al explotar;
- objetivos: banderas, bases y zonas;
- marcador, reloj y fase de la batalla;
- panel de equipos con vida y módulos;
- registro de derribos y minimapa.

## Controles

- **Cámaras**: «Vista global», una por bando y «Seguir *vehículo*» (teclas **1–8** para seguir a cada bot).
- **Zoom y movimiento**: rueda o pellizco para el zoom, arrastrar para mover la cámara; **+ / −** (zoom), **F** (encajar el mapa), **G** (vista global), **C** (centrar en lo seleccionado). Funciona con el foco en el escenario.
- **Niebla de guerra**: muestra sólo lo que ve un bando. Aparece únicamente si las reglas de la batalla lo permiten.
- **Capas de depuración** (sensores y colisiones): sólo para moderadores y administradores.
- En el móvil el escenario se ajusta al ancho de la pantalla.

## En directo

**«En directo»** es una página pública: no hace falta cuenta. Muestra las batallas en curso que se pueden ver; con cuenta, además, las tuyas. Si la plataforma tiene la emisión pública desactivada, un visitante sin cuenta verá «La emisión pública para visitantes está desactivada.».

**Retardo.** Las batallas de torneo se ven con un retardo de 30 segundos, para que nadie haga de entrenador; las batallas de «Nueva batalla» van sin retardo. El retardo no cambia la simulación. La final de un torneo puede marcarse como visible sin retardo.

## Emisión

Existe una vista de pantalla completa pensada para retransmitir una batalla o un torneo (`/broadcast?battle=<id>` o `?tournament=<id>`). Es anónima: sólo muestra batallas que un visitante podría ver. Cómo se monta una retransmisión (para administradores): [operaciones](../operations/streaming.md).

## Quién puede verla

Las mismas reglas que para la batalla: tú y los dueños de los bots, su equipo, el staff, y cualquiera si todos los bots son públicos y la plataforma permite la emisión pública ([Batallas](battles.md#quién-ve-qué)).

Siguiente: [Replays](replays.md).
