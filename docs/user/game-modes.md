# Modos de juego

Un **modo** decide cómo se gana; un **conjunto de reglas** decide los detalles (tiempo, vidas, cuántos puntos hacen falta). Al crear una batalla eliges las dos cosas.

Puedes usar **cuatro modos**: combate libre (*Deathmatch*, 1 contra 1), combate por equipos (*Deathmatch por equipos*), *Captura la bandera* y *Control de zona*. Son los únicos que ofrece la web y la API (`modes` del catálogo); los tres últimos se juegan por equipos. Otros modos internos del motor de simulación **no están disponibles** para el jugador y no se describen en esta guía.

## Cómo se elige: conjuntos oficiales, personalizado y clásico

En **«Nueva batalla»** primero eliges el tipo (1 contra 1 o por equipos) y luego el conjunto de reglas:

- **Conjuntos oficiales** (Duelo, Combate, Resistencia, Eliminación por equipos, Respawn limitado, Team Deathmatch, Resistencia por equipos y Captura la bandera). Están versionados: si una regla cambia, se publica una versión nueva y tus batallas, torneos y replays conservan **las reglas con las que se crearon**. Todos los detalles, con los desempates, están en **[Reglas de batalla](rules.md)**, que se genera del propio código del juego.
- **Personalizado**: sólo reglas competitivas (reaparición, tiempo, objetivo de bajas o capturas, créditos y masa, fuego amigo y, en bandera, capturas y retorno). La física, el daño, la vida, los sensores y la munición no se tocan. Límites y reglas: [Reglas de batalla](rules.md#personalizado).
- **Clásico**: el conjunto de reglas de la plataforma para cada modo (abajo). Es la única forma de jugar **Control de zona**.

Antes de crear, la web muestra un **resumen** de las reglas y comprueba cada bot en el servidor («✓ A-ATK-1 — 890/900 cr»). Si un bot o un equipo supera un tope, no se puede crear la batalla.

## Vidas y reapariciones

`maxRespawns` es el número de veces que un bot puede **reaparecer** tras morir:

| `maxRespawns` | Vidas totales |
|---|---|
| 0 | 1 |
| 1 | 2 |
| 2 | 3 |

(Siempre una más que `maxRespawns`.) «Sin reaparición» es una sola vida; «ilimitada» reaparece siempre, tras una espera. Un vehículo sin vidas queda eliminado.

## Los cuatro modos

Reglas comunes de las batallas clásicas: **5 minutos** de juego, **sin fuego amigo** (tus proyectiles atraviesan a tus compañeros). Cuando el tiempo se agota, gana quien tenga **más puntos**; con igualdad, empate. (Los conjuntos oficiales tienen sus propios tiempos y desempates, en [Reglas de batalla](rules.md#desempates).)

### Deathmatch

- **Objetivo**: destruir a los rivales; cada vehículo juega por su cuenta (es el modo de 1 contra 1).
- **Inicio**: cada vehículo nace en un punto de aparición del mapa.
- **Puntuación**: **1 punto por cada vehículo enemigo destruido**.
- **Victoria**: el primero en llegar al marcador, o el último vehículo que queda en pie.
- **Muerte**: en las reglas clásicas, **sin reaparición**: el vehículo destruido queda eliminado.
- **Fin del tiempo**: gana quien tenga más puntos; empate si hay igualdad.
- **Mapa**: al menos 2 puntos de aparición.
- **Equipamiento útil**: arma, blindaje y un buen sensor.

### Deathmatch por equipos

- **Objetivo**: destruir a los vehículos del otro equipo.
- **Puntuación**: 1 punto por baja enemiga. Con fuego amigo activo, matar a un compañero da el punto al rival.
- **Victoria**: el primer equipo que llegue al marcador de bajas.
- **Muerte**: en las reglas clásicas, reaparición ilimitada tras una espera.
- **Fin del tiempo**: más puntos; empate si hay igualdad.
- **Mapa**: puntos de aparición de al menos 2 bandos.
- **Equipamiento útil**: arma, blindaje y radio para coordinarse.

### Captura la bandera

- **Objetivo**: coger la bandera rival y llevarla a tu base.
- **Inicio**: cada equipo tiene su base y su bandera; la tuya empieza en tu base.
- **Reglas**:
  - tocar la bandera rival (a unos 2 metros) la recoge; quien la lleva puede seguir combatiendo;
  - si el portador muere o es descalificado, la bandera **cae** donde estaba; un rival puede recogerla y un compañero del dueño puede **devolverla tocándola**;
  - si nadie la toca, **vuelve sola a su base** pasado un tiempo;
  - **sólo puntúas si tu propia bandera está en tu base**;
  - al capturar, la bandera rival vuelve a su base.
- **Puntuación**: 1 punto por captura.
- **Victoria**: el primer equipo que llegue al número de capturas, o el que tenga más al acabar el tiempo.
- **Muerte**: reaparición ilimitada tras una espera.
- **Fin del tiempo**: más capturas. **Si hay empate, prórroga**: sigue la batalla con el mismo estado (no se reinician bots, banderas ni posiciones) y **gana la siguiente captura**. La prórroga **no tiene límite de tiempo competitivo**.
- **Salvaguarda técnica**: por seguridad, si tras 20 minutos de prórroga nadie ha capturado, la batalla se **detiene por límite técnico**. No es una regla de juego: no hay empate, victoria ni derrota, y no cuenta para V-D-E, clasificaciones ni Elo.
- **Mapa**: base y bandera de dos equipos, rojo y azul.
- **Equipamiento útil**: velocidad, sensores para encontrar la bandera rival (su posición sólo es pública en su base) y radio.

### Control de zona

- **Objetivo**: ocupar las zonas de captura.
- **Puntuación**: una zona da puntos mientras **un único equipo** esté dentro (1 punto por tick, 30 por segundo). Vacía o disputada, no puntúa nadie.
- **Victoria**: el primer equipo que llegue al marcador, o el que tenga más al acabar el tiempo.
- **Muerte**: reaparición ilimitada tras una espera.
- **Mapa**: al menos una zona de captura. Ningún mapa de serie la tiene: crea uno en el [editor](maps.md).
- **Equipamiento útil**: blindaje y energía, para aguantar dentro de la zona.

## Resumen de los conjuntos de reglas clásicos

| Modo | Conjunto de reglas | Tiempo | Gana quien llegue a | Reaparición | Fuego amigo |
|---|---|---|---|---|---|
| Deathmatch | Deathmatch (práctica) | 5 min | 5 puntos | no | no |
| Deathmatch por equipos | Team deathmatch (MVP) | 5 min | 8 puntos | 5 s | no |
| Captura la bandera | Captura la bandera (MVP) | 5 min | 3 puntos | 5 s | no |
| Control de zona | Control de zona (MVP) | 5 min | 500 puntos | 5 s | no |

También existe el «Ruleset MVP por defecto», válido para cualquier modo.

## Mapas compatibles

Cada mapa **declara** los modos que soporta y el validador comprueba que tenga lo necesario. En «Nueva batalla» sólo aparecen los mapas que admiten el modo elegido; los demás se listan con el motivo.

| Modo | El mapa necesita |
|---|---|
| Deathmatch | al menos 2 puntos de aparición |
| Deathmatch por equipos | puntos de aparición de al menos 2 bandos |
| Captura la bandera | una base y una bandera de cada equipo (rojo y azul) |
| Control de zona | al menos una zona de captura |

Los mapas de serie son `mvp-arena-01` (bandera y por equipos) y `mvp-arena-02` (la misma arena, que además admite deathmatch). Cómo crear los tuyos: [Mapas](maps.md).

## Documentación relacionada

[Reglas de batalla](rules.md) · [Batallas](battles.md) · [Torneos](tournaments.md) · [Mapas](maps.md) · [Equipamiento](equipment.md)
