# Guía de S9 AI Arena

## ¿Qué es S9 AI Arena?

S9 AI Arena es una arena de programación. **Escribes el código de un bot** (en Python o JavaScript) que conduce un vehículo en un mapa 2D, **eliges su equipamiento** y lo **enfrentas a otros bots** en batallas y torneos. Durante la batalla no controlas nada en directo: tu programa recibe, varias veces por segundo, lo que perciben los sensores del vehículo y responde con órdenes —moverse, apuntar, disparar, soltar una mina, hablar por radio—. Gana el mejor programa.

El camino de un jugador es siempre el mismo:

```text
crear bot → programarlo → equiparlo → publicar una versión → batallas → equipos → torneos → replays → mejorar
```

1. **Bot.** Es tu jugador: un nombre con sus versiones de código y su equipamiento.
2. **Programarlo.** Escribes el código en la web o en tu editor y lo pegas. [Guía de programación](bots/index.md).
3. **Equiparlo.** Eliges chasis, motor, sensores, arma, blindaje… dentro de un presupuesto de créditos. [Equipamiento](equipment.md).
4. **Publicar una versión.** La plataforma la valida en un entorno aislado y, si la supera, la publicas. Sólo las versiones publicadas combaten. [Bots](bots.md).
5. **Batallas.** Lanzas batallas de práctica contra otros bots, en el modo y el mapa que elijas. [Batallas](battles.md).
6. **Equipos.** Te juntas con otros jugadores para batallas por equipos. [Equipos](teams.md).
7. **Torneos.** Los organizadores enfrentan a muchos bots en rondas; sus batallas son las oficiales y mueven el ranking. [Torneos](tournaments.md) y [Ranking](rankings.md).
8. **Replays y directo.** Revives cualquier batalla terminada o ves una en curso. [Replays](replays.md) y [Visor](viewer.md).
9. **Mejorar.** Miras las estadísticas y el diagnóstico de tu bot, cambias el código o el equipo, y publicas una versión nueva. [Estadísticas](statistics.md).

## Por dónde empezar

**[Primeros pasos](getting-started.md)** te lleva, en unos veinte minutos, de cero a tu primera batalla con un bot propio.

## Índice de la guía

| Quiero… | Lee |
|---|---|
| Crear la cuenta y entender los roles | [Cuentas](accounts.md) |
| Crear un bot, subir código y publicarlo | [Bots](bots.md) |
| **Aprender a programar un bot** | [Guía de programación](bots/index.md) y [ejemplos](bots/ejemplos.md) |
| Elegir chasis, sensores y armas | [Equipamiento](equipment.md) · [catálogo completo](equipment-catalog.md) |
| Saber qué reglas tiene cada modo | [Modos de juego](game-modes.md) · [Reglas de batalla](rules.md) |
| Lanzar una batalla | [Batallas](battles.md) |
| Competir en un torneo | [Torneos](tournaments.md) |
| Entender el ranking | [Ranking](rankings.md) |
| Crear o editar mapas | [Mapas](maps.md) |
| Jugar con otras personas | [Equipos](teams.md) |
| Ver una batalla en directo | [Visor y espectador](viewer.md) |
| Revisar una batalla terminada | [Replays](replays.md) |
| Medir cómo juega mi bot | [Estadísticas](statistics.md) |
| Gestionar la plataforma (administradores) | [Administración](administration.md) |

## La ayuda está también dentro de la web

El menú **«Ayuda»** abre el Centro de Ayuda (sin necesidad de cuenta): explica los mismos conceptos con las pantallas delante, y sus tablas de equipamiento, reglas y mensajes salen de los mismos datos que usa el juego.

## Si algo falla

La web no enseña pantallas vacías cuando algo va mal: te dice qué ha pasado y, si tiene sentido, ofrece un botón **«Reintentar»**.

| Aviso | Qué significa |
|---|---|
| «Datos no válidos» | El formulario tiene un error; el mensaje dice cuál. |
| «Necesitas iniciar sesión» | La sesión ha caducado. Vuelve a entrar. |
| «No tienes permiso para esto» | Tu rol no permite esa acción o pantalla. |
| «No existe o no está disponible» | El elemento no existe, o no es visible para ti. |
| «Conflicto con el estado actual» | Alguien lo cambió antes o la acción ya no procede. |
| «Error del servidor» | Fallo interno: reintenta o avisa al administrador. |
| «Servicio no disponible» | Un servicio de la plataforma está caído un momento. |
| «El servidor tarda demasiado» | No hubo respuesta en 15 segundos. |
| «Sin conexión con el servidor» | Falla tu red o la plataforma no responde. |
| «Página no encontrada» | La dirección no corresponde a ninguna pantalla; usa «Volver». |

## ¿Quieres desarrollar S9?

Esta guía es para jugar. Si quieres colaborar en el propio proyecto, empieza por la [documentación de desarrollo](../development/index.md).
