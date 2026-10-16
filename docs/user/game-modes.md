# Modos de juego

## Resumen

Desde la web puedes elegir **4 modos**: combate libre (`deathmatch`), combate por equipos (`team_deathmatch`), captura de bandera (`capture_the_flag`) y control de zonas (`zone_control`). El motor de simulación tiene 3 modos más (último en pie, dominación y juggernaut) que todavía **no se pueden usar** desde la plataforma.

Hoy:

- en «Nueva batalla» eliges el **modo** y un **ruleset** (las reglas: límite de tiempo, puntos y presupuesto), que salen de la plataforma; el selector de mapas sólo muestra los que admiten ese modo, y la batalla se crea ([TD-003](../roadmap/technical-debt.md#td-003));
- los vehículos los conduce un bot de prueba que no persigue banderas ni zonas ([TD-002](../roadmap/technical-debt.md#td-002)).

## Índice

- [Modos disponibles](#modos-disponibles)
- [Modos sólo del motor](#modos-sólo-del-motor)
- [Rulesets](#rulesets)
- [Mapas compatibles](#mapas-compatibles)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Modos disponibles

Reglas comunes:

- duración máxima de 5 minutos de juego (9 000 *ticks*);
- sin fuego amigo;
- reaparición a los 5 segundos, salvo que se indique otra cosa.

### Combate libre — `deathmatch`

- **Objetivo**: destruir a los rivales; cada vehículo juega por su cuenta.
- **Victoria**: el primero en llegar a **5 derribos**. Si se acaba el tiempo, gana quien más tenga. **Sin reaparición**: también gana el último que queda en pie.
- **Mapa**: al menos 2 puntos de aparición.
- **Equipamiento relevante**: arma, blindaje y radar.

### Combate por equipos — `team_deathmatch`

- **Objetivo**: derribos por equipo. Con fuego amigo activo, matar a un compañero da el punto al rival.
- **Victoria**: **8 derribos** o, al acabar el tiempo, el equipo con más.
- **Mapa**: puntos de aparición de al menos 2 equipos.
- **Equipamiento relevante**: arma, blindaje y radio (coordinación).

### Captura de bandera — `capture_the_flag`

- **Objetivo**: coger la bandera rival y llevarla a tu base.
- **Reglas**:
  - la bandera se coge tocándola y cae si muere quien la lleva;
  - vuelve sola a su base a los 10 segundos, o antes si la toca su equipo;
  - **no puedes capturar si tu propia bandera no está en tu base**.
- **Victoria**: **3 capturas** o, al acabar el tiempo, el equipo con más. Si hay igualdad, empate.
- **Mapa**: exactamente 2 equipos, con **una bandera y una base por equipo**.
- **Equipamiento relevante**: movilidad (velocidad), sensores para localizar la bandera rival (su posición sólo es visible para todos cuando está en su base) y radio.

### Control de zonas — `zone_control`

- **Objetivo**: ocupar las zonas de captura.
- **Reglas**: una zona sólo da puntos si **un único equipo** está dentro. Vacía o disputada, no puntúa nadie. 1 punto por *tick* (30 por segundo).
- **Victoria**: **500 puntos** o, al acabar el tiempo, el equipo con más.
- **Mapa**: al menos 1 zona de captura.
- **Equipamiento relevante**: blindaje y energía, para aguantar dentro de la zona.

## Modos sólo del motor

**PENDIENTE en la plataforma.** No aparecen en la web; la plataforma los rechaza («mode inválido»):

- **Último en pie** (`last_man_standing`): sin reaparición; gana el último equipo con vehículos vivos. Al mejor de 3 rondas.
- **Dominación** (`domination`): varias zonas; una zona sigue siendo tuya al salir de ella. Necesita al menos 2 zonas.
- **Juggernaut** (`juggernaut`): un vehículo marcado al que todos quieren abatir. 3 puntos por abatirlo.

## Rulesets

**FUNCIONA ACTUALMENTE.** La plataforma trae uno por modo:

| Ruleset | Modo |
|---|---|
| Deathmatch (práctica) | combate libre |
| Team deathmatch (MVP) | por equipos |
| Captura la bandera (MVP) | bandera |
| Control de zona (MVP) | zonas |

También trae «Ruleset MVP por defecto», válido para cualquier modo. Al cambiar de modo, el formulario elige el ruleset de ese modo.

## Mapas compatibles

Cada mapa **declara** sus modos, y el validador comprueba que tenga lo necesario: spawns, banderas y bases, o zonas de captura.

| Mapa | Modos declarados | Combate libre | Por equipos | Bandera | Zonas |
|---|---|---|---|---|---|
| `mvp-arena-01` (de serie) | bandera, por equipos | — | sí | sí | **no** (sólo tiene zonas de ácido, que hacen daño) |
| `mvp-arena-02` (de serie, misma arena) | libre, por equipos, bandera | sí | sí | sí | **no** |

- En «Nueva batalla» **sólo aparecen los mapas que admiten el modo elegido**.
- Para jugar a control de zonas, crea un mapa en el editor con al menos una zona de captura y marca el modo.

## Errores / limitaciones

- **Por API**, `POST /battles` todavía acepta un modo que el mapa no admite; la web no lo permite. Esa batalla acaba fallando.
- **Bandera y zonas**: con el bot de prueba de la plataforma, estas partidas suelen acabar en empate por tiempo, porque ese bot no persigue objetivos.
- Ningún mapa de serie admite control de zonas.

## Estado actual

**FUNCIONA ACTUALMENTE**: los 4 modos, con rulesets reales, se eligen al crear una batalla de práctica (202, comprobado en un navegador real). **PARCIAL**: el bot de prueba no persigue objetivos. **PENDIENTE**: 3 modos sólo existen en el motor.

## Documentación relacionada

- Técnica: [game-modes.md](../technical/game-modes.md) (inventario completo, rulesets y estado por capa)
- Usuario: [Batallas](battles.md), [Mapas](maps.md), [Equipamiento](equipment.md), [Torneos](tournaments.md)
