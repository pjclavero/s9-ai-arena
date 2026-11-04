# Objetivos y marcador

Cada modo de juego tiene sus objetivos. Tu bot los conoce de dos maneras: por las **reglas** que llegan en el `WELCOME` (qué modo es, cuánto vale ganar) y por `observation.score` y `observation.objectives`, que se actualizan en cada ciclo. Las reglas completas de cada modo, con sus desempates, están en [Modos de juego](../game-modes.md) y [Reglas de batalla](../rules.md).

## El marcador: `observation.score`

Un diccionario con los puntos de cada bando: `{"red": 2, "blue": 1}`. Qué cuenta como punto depende del modo: bajas (en deathmatch y por equipos), capturas de bandera o puntos por ocupar zonas. Es información pública.

`welcome.rules.scoreToWin` es el marcador que da la victoria, `timeLimitTicks` la duración del tiempo reglamentario y `respawn` si puedes reaparecer y cuántas veces.

## Los objetivos: `observation.objectives`

Una lista que sólo existe en los modos que tienen objetivos. Cada elemento:

| Campo | Qué es |
|---|---|
| `kind` | `flag` (bandera) o `zone` (zona). |
| `team` | Bando al que pertenece la bandera, o dueño de la zona (`neutral` si nadie la controla). |
| `state` | Su estado actual (abajo). |
| `id` | Identificador de la zona (en modos con varias). |
| `position` | Su posición **si es pública**. |

### Captura la bandera

Tienes una bandera en tu **base** y tu rival la suya. El objeto de la lista dice de qué bando es, y su `state`:

| `state` | Significado |
|---|---|
| `at_base` | La bandera está en su base. Es el **único** estado con `position` pública. |
| `carried` | Alguien la lleva. No sabes dónde está salvo que lo veas con un sensor. |
| `dropped` | Cayó al suelo porque murió quien la llevaba. Tampoco se publica su posición. |
| `returning`, `captured` | Estados de transición (vuelve sola a su base; acaba de capturarse). |

Para jugar a la bandera tu código suele hacer esto:

1. Conoce dónde está cada base: `welcome.map.bases` (cada una con `team` y `position`).
2. Ve hasta la **bandera rival** (en su base) y **tócala**, a unos 2 metros: la coges. `self.carryingFlag` pasa a valer el bando dueño de la bandera.
3. Llévala a **tu base**. Sólo puntúa si **tu bandera está en tu base** (lo habitual en las reglas; si tu bandera la lleva un rival, tienes que recuperarla antes).
4. Si mueres con la bandera, cae donde estabas. Un rival puede recogerla; un compañero del dueño puede **devolverla tocándola**; y si nadie la toca, vuelve sola a su base pasado un tiempo.

El [ejemplo de equipo](ejemplos.md#6-equipo) lo hace con dos roles: un atacante y un defensor.

### Control de zona

Cada zona de captura aparece con su `id`, su `position` (siempre pública) y su estado: `held` si la controla un único bando (`team` dice cuál) o `neutral` si nadie. Una zona sólo da puntos si **un único equipo** está dentro; vacía o disputada no puntúa nadie. Si dos equipos están dentro, nadie puntúa.

### Deathmatch y por equipos

No hay lista de objetivos: ganas matando. El `score` es el recuento de bajas.

## El resultado

Al acabar recibes el `SHUTDOWN` con `result.outcome` (`win`, `loss`, `draw` o `disqualified`) y el marcador final. Si la batalla terminó por la **salvaguarda técnica** de la prórroga (sólo capturar la bandera: detenida por límite técnico), no hay resultado deportivo.

Siguiente: [Eventos](eventos.md).
