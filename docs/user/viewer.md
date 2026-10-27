# Visor en directo y espectador

## Resumen

El **visor** (`#/viewer/<batalla>`) muestra una batalla en directo: vehículos, disparos, marcador, reloj y equipos, con varias cámaras. **«En directo»** (`#/live`) lista las batallas en curso para cualquier visitante. Hay también una vista de emisión (`/broadcast?battle=…`) pensada para retransmitir.

Desde el cierre funcional de 2026-10 el visor **arranca de verdad en el navegador** (espera a que el motor gráfico esté listo), **pide el pase de espectador** y, si la batalla no se puede ver, **lo dice y se detiene** en lugar de quedarse en «conectando…». Con RC4 desplegada hay batallas reales con el código de los bots, y el visor las muestra en directo (ver [Estado actual](#estado-actual)).

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

Desde «Batallas» o desde el detalle de un torneo, el enlace **«Ver en directo»** aparece mientras la batalla está en curso. Una batalla terminada enlaza a **«Ver replay»**.

Estados que muestra el visor:

| Estado | Significado | Qué puedes hacer |
|---|---|---|
| «inicializando visor…» | El motor gráfico arranca | Esperar (segundos) |
| «conectando…» | Pidiendo el pase y abriendo la conexión | Esperar |
| «en directo» | Recibiendo la batalla | — |
| «reconectando…» / «en directo (reconectado)» | Corte de red y recuperación automática | — |
| «batalla terminada» | Fin, con el resultado sobre el lienzo | Enlace «Ver el replay de esta batalla» |
| «La batalla no está en directo…» | Ya terminó o aún no empezó | Enlace al replay |
| «Esta batalla no existe o no se puede ver en directo sin cuenta.» | Identificador incorrecto, o visitante sin cuenta con la emisión pública desactivada | Iniciar sesión o abrir el replay |
| «El servidor de directo rechazó el pase…» | Pase inválido o caducado (fallo de configuración del servidor) | Avisar al administrador |
| «sin conexión con el servidor de directo tras varios intentos» | Se agotaron los reintentos | «Reintentar» |

Un rechazo definitivo **no** se reintenta en bucle: el visor pide un solo pase y explica el motivo.

## Qué muestra

**FUNCIONA ACTUALMENTE** el dibujo (verificado con el reproductor, que usa la misma escena):

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

**PARCIAL.** `#/live` lista las batallas en curso. Con la emisión pública desactivada muestra **«La emisión pública está desactivada en este entorno.»**. Es una página pública: no requiere cuenta.

## Vista de emisión

**PARCIAL.** `/broadcast?battle=<id>` o `?tournament=<id>`: composición a pantalla completa para retransmitir. Usa la misma espera del motor gráfico que el visor; si el directo se rechaza, el marcador lo indica en lugar de «conectando…».

## Errores / limitaciones

- **Batallas demasiado rápidas**: la plataforma simula sin ritmo de tiempo real, así que es difícil llegar a verlas en curso.
- **Emisión** (`/broadcast`): sin prueba de extremo a extremo ([TD-009](../roadmap/technical-debt.md#td-009)).
- **Móvil**: el lienzo es de ancho fijo.

## Estado actual

**FUNCIONA ACTUALMENTE**: el visor arranca, pide el pase, explica cada rechazo y muestra en directo una batalla en curso (golden path en navegador real; RC4 verificada en producción el 2026-10-27). **PARCIAL**: la vista de emisión.

## Documentación relacionada

- Usuario: [Replays](replays.md), [Batallas](battles.md)
- Técnica: [websocket.md](../technical/websocket.md), [frontend.md — Phaser](../technical/frontend.md#visor-reproductor-y-phaser)
- Deuda: [TD-009](../roadmap/technical-debt.md#td-009), [TD-028](../roadmap/technical-debt.md#td-028)
