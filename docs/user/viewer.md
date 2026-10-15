# Visor en directo y espectador

## Resumen

El **visor** (`#/viewer/<batalla>`) muestra una batalla en directo: vehículos, disparos, marcador, reloj y equipos, con varias cámaras. **«En directo»** (`#/live`) lista las batallas en curso para cualquier visitante. Hay también una vista de emisión (`/broadcast?battle=…`) pensada para retransmitir.

**Hoy el visor no funciona en el navegador**: se queda en «conectando…» y no dibuja nada ([TD-009](../roadmap/technical-debt.md#td-009)). La emisión pública está desactivada. Además, las batallas duran segundos, así que casi nunca hay nada en directo que ver.

## Índice

- [Abrir el visor](#abrir-el-visor)
- [Qué muestra](#qué-muestra)
- [Controles](#controles)
- [En directo](#en-directo)
- [Vista de emisión](#vista-de-emisión)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Abrir el visor

Desde «Batallas» o desde el detalle de un torneo, el enlace **«Ver en directo»** aparece mientras la batalla está `running`. Desde «Replays», el enlace «visor».

Estados que muestra el visor:

| Estado | Significado |
|---|---|
| «conectando…» | Esperando la conexión. **Hoy se queda aquí** |
| «en directo» | Recibiendo la batalla |
| «reconectando…» / «en directo (reconectado)» | Corte de red y recuperación automática |
| «batalla terminada» | Fin, con el resultado sobre el lienzo |
| «sin conexión» | Se agotaron los reintentos |

Sin iniciar sesión, el visor no puede conectarse mientras la emisión pública esté desactivada. No explica que el motivo es ese.

## Qué muestra

**PENDIENTE (no se dibuja hoy).** Implementado:

- vehículos con su nombre y chasis, y disparos con su trayectoria;
- daño y minas al explotar;
- objetivos: banderas y zonas;
- marcador, reloj y fase;
- panel de equipos con vida y módulos;
- registro de derribos y minimapa.

## Controles

- **Cámaras**: «Vista global», «Equipo rojo», «Equipo azul» y «Seguir *vehículo*».
- **Niebla de guerra**: muestra sólo lo que ve un equipo. Sólo aparece si las reglas de la batalla lo permiten.
- **Capas de depuración**: sensores y colisiones, sólo para moderadores y administradores.

## En directo

**PENDIENTE.** `#/live` lista las batallas en curso. Hoy muestra **«La emisión pública está desactivada en este entorno.»**. Es una página pública: no requiere cuenta.

## Vista de emisión

**PENDIENTE.** `/broadcast?battle=<id>` o `?tournament=<id>`: composición a pantalla completa para retransmitir. Tiene el mismo problema de dibujo que el visor.

## Errores / limitaciones

- **Lienzo vacío y «conectando…» para siempre**: el componente gráfico se inicializa mal ([TD-009](../roadmap/technical-debt.md#td-009)). Además, el servicio que emite el directo no puede verificar las entradas de espectador ([TD-028](../roadmap/technical-debt.md#td-028)).
- **Batallas demasiado rápidas**: la plataforma simula sin ritmo de tiempo real, así que es difícil llegar a verlas en curso.
- **Batalla inexistente**: el visor no lo dice; también se queda en «conectando…».
- **Móvil**: el lienzo es de ancho fijo.

## Estado actual

**PENDIENTE**: implementado, pero no utilizable en navegador.

## Documentación relacionada

- Usuario: [Replays](replays.md), [Batallas](battles.md)
- Técnica: [websocket.md](../technical/websocket.md), [frontend.md — Phaser](../technical/frontend.md#visor-reproductor-y-phaser)
- Deuda: [TD-009](../roadmap/technical-debt.md#td-009), [TD-028](../roadmap/technical-debt.md#td-028)
