# Guía de usuario de S9 AI Arena

## Resumen

S9 AI Arena es una arena de programación: escribes el código de un bot que conduce un vehículo 2D, eliges su equipamiento y lo enfrentas a otros bots en batallas y torneos. Esta guía explica **qué puedes hacer hoy desde la web**, con las pantallas, los campos y los mensajes que vas a ver. No hace falta conocer la arquitectura interna.

Antes de empezar, lo más importante: **el recorrido completo todavía no funciona**. Hoy puedes registrarte, crear bots, configurar su equipamiento y subir código. El recorrido se corta en dos puntos:

1. **La validación del código**: todas las versiones acaban «rechazadas», así que ningún bot llega a estar publicado.
2. **La creación de batallas** desde la web, que siempre responde «rulesetId desconocido».

Cada página indica lo que **FUNCIONA ACTUALMENTE**, lo **PARCIAL** y lo **PENDIENTE**, y enlaza los problemas conocidos.

## Índice

Recomendamos leer en este orden, porque es el orden del ciclo real de un bot:

1. [Primeros pasos](getting-started.md): qué esperar y por dónde empezar.
2. [Cuentas](accounts.md): registro, inicio y cierre de sesión, roles.
3. [Bots](bots.md): crear, subir código, versiones, validación y publicación.
4. [Equipamiento](equipment.md): chasis y módulos (loadout).
5. [Mapas](maps.md): importar, generar, publicar y el editor visual.
6. [Modos de juego](game-modes.md): reglas y condiciones de victoria.
7. [Batallas](battles.md): crear una batalla de práctica y ver el resultado.
8. [Torneos](tournaments.md): crear, inscribirse, cerrar y seguir el cuadro.
9. [Equipos](teams.md): crear equipos e invitar miembros.
10. [Visor y espectador](viewer.md): ver una batalla en directo.
11. [Replays](replays.md): volver a ver una batalla terminada.
12. [Clasificaciones](rankings.md): el ranking público.
13. [Estadísticas](statistics.md): qué datos existen y dónde verlos.
14. [Administración](administration.md): lo que puede hacer un administrador desde la web.

## Estado actual de un vistazo

| Área | Estado | Motivo principal |
|---|---|---|
| Cuentas | **FUNCIONA ACTUALMENTE** (registro, login, sesión) · **PENDIENTE** (cambio de contraseña, recuperación) | [TD-012](../roadmap/technical-debt.md#td-012) |
| Bots y equipamiento | **PARCIAL**: se crean y configuran, pero ninguna versión se publica | [TD-001](../roadmap/technical-debt.md#td-001) |
| Mapas | **PARCIAL**: importar sí; el editor no guarda | [TD-010](../roadmap/technical-debt.md#td-010) |
| Batallas | **PENDIENTE desde la web**: 400 al crear | [TD-003](../roadmap/technical-debt.md#td-003) |
| Torneos | **PARCIAL**: funcionan para organizadores con bots publicados | [TD-001](../roadmap/technical-debt.md#td-001), [TD-015](../roadmap/technical-debt.md#td-015) |
| Visor y replays | **PENDIENTE**: no se dibujan en el navegador | [TD-009](../roadmap/technical-debt.md#td-009) |
| Ranking | **PARCIAL**: la página existe pero sale vacía | [tournaments.md](../technical/tournaments.md#clasificación-y-rating) |

Además: aunque una batalla llegue a jugarse, **los vehículos no ejecutan tu código**. Los conduce un bot de prueba interno de la plataforma ([TD-002](../roadmap/technical-debt.md#td-002)).

## Documentación relacionada

- Problemas conocidos: [known-issues.md](../roadmap/known-issues.md)
- Estado del proyecto: [current-status.md](../roadmap/current-status.md)
- Documentación técnica: [índice técnico](../technical/index.md)
- Instalación y operación (para quien despliega la plataforma): [operations](../operations/index.md)
