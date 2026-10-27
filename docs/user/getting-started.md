# Primeros pasos

## Resumen

Este es el recorrido de un usuario nuevo, de la cuenta al replay. Todos los pasos funcionan hoy en la plataforma.

## Índice

- [Qué es](#qué-es)
- [El ciclo de un bot](#el-ciclo-de-un-bot)
- [Uso: tu primera sesión](#uso-tu-primera-sesión)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Qué es

Tu bot es un programa en Python o JavaScript (Node). Diez veces por segundo recibe lo que perciben los sensores de su vehículo y responde con órdenes: moverse, apuntar, disparar, usar la radio y poner minas. El vehículo lo montas tú con un **loadout**: chasis, movilidad, energía, sensores, arma, blindaje… dentro de un presupuesto de créditos.

## El ciclo de un bot

| # | Paso | Pantalla | Hoy |
|---|---|---|---|
| 1 | Crear cuenta | Inicio → «Crear cuenta» | **FUNCIONA ACTUALMENTE** |
| 2 | Crear un bot | «Mis bots» | **FUNCIONA ACTUALMENTE** |
| 3 | Configurar el loadout | «Mis bots» → editor de loadout | **FUNCIONA ACTUALMENTE** |
| 4 | Subir código | «Mis bots» → «Subir código (pegado)» | **FUNCIONA ACTUALMENTE** |
| 5 | Enviar a validación | «Enviar a validación vN» | **FUNCIONA ACTUALMENTE**: build en el sandbox real ([TD-001](../roadmap/technical-debt.md#td-001)) |
| 6 | Publicar la versión | «Publicar vN» | **FUNCIONA ACTUALMENTE** (versiones `validated`) |
| 7 | Asignar el bot a un equipo | «Equipos» → «Añadir bot» | **FUNCIONA ACTUALMENTE** |
| 8 | Jugar una batalla de práctica | «Batallas» → «+ Nueva batalla de práctica» | **FUNCIONA ACTUALMENTE**: la juega tu código |
| 9 | Ver la batalla | Visor en directo | **FUNCIONA ACTUALMENTE** ([viewer.md](viewer.md)) |
| 10 | Volver a verla | Replay | **FUNCIONA ACTUALMENTE** ([replays.md](replays.md)) |
| 11 | Consultar las estadísticas | API `GET /api/v1/battles/{id}/stats` | **FUNCIONA ACTUALMENTE** (sin pantalla propia; [statistics.md](statistics.md)) |
| 12 | Inscribirse en un torneo y ver tu posición | «Torneos», «Ranking» | **PARCIAL**: requiere una versión publicada y un torneo abierto ([TD-015](../roadmap/technical-debt.md#td-015)) |

## Uso: tu primera sesión

1. **Crea tu cuenta**: email, contraseña de al menos 12 caracteres y nombre visible. Entras directamente. Ver [Cuentas](accounts.md).
2. **Ve a «Mis bots»**, escribe un nombre en «Nombre del bot» y pulsa «Crear bot».
3. **Pulsa sobre el nombre del bot** para abrir su detalle y configura el **editor de loadout**:
   - elige un chasis;
   - llena cada ranura;
   - vigila «Coste» y «Energía»;
   - pulsa «Guardar revisión».

   Ver [Equipamiento](equipment.md).
4. **En «Subir código (pegado)»** elige el runtime (`python` o `node`), pega tu código y pulsa «Subir como versión nueva». Con `node`, el código es JavaScript ESM: TypeScript se rechaza ([Bots](bots.md)). Hay ejemplos y SDK en `example-bots/` y `sdks/` del repositorio.
5. **Pulsa «Enviar a validación v1»**. El panel dice «Validación en curso…»: la plataforma ejecuta tu código en un entorno aislado (análisis, prueba de protocolo, partida de humo y límites de recursos). Si queda `rejected`, el motivo dice en qué etapa falló; el detalle está en «Ver build». Si queda `validated`, sigue.
6. **Pulsa «Publicar v1»**. La versión pasa a `published` y ya no se puede cambiar (para cambiar algo, sube una versión nueva).
7. **Ve a «Equipos»**, crea un equipo (o usa uno del que seas miembro), elige tu bot en «— uno de mis bots —» y pulsa «Añadir bot». Ver [Equipos](teams.md).
8. **Ve a «Batallas» → «+ Nueva batalla de práctica»**, elige modo, ruleset, mapa y participantes, y pulsa «Crear batalla». La batalla la juega el código de cada bot, con su loadout. Ver [Batallas](battles.md).
9. **Abre el visor** para seguirla en directo y, cuando termine, el **replay** para volver a verla. Las estadísticas por bot se consultan por API: `GET /api/v1/battles/{id}/stats`.

## Errores / limitaciones

- La web no explica el ciclo ni muestra ayuda dentro de las pantallas. Términos como `loadout`, `runtime` o los nombres de las etapas del pipeline aparecen tal cual.
- Algunos formularios se muestran a todos aunque exigen permisos de organizador (crear torneo, generar mapa). Fallan con «Requiere rol organizer». Publicar un mapa **propio** sí puedes hacerlo con tu cuenta normal.
- Si escribes una dirección que no existe (por ejemplo, `#/loquesea`), verás «Página no encontrada» con «Volver» y enlaces a las pantallas principales.
- Cuando algo falla, la pantalla lo dice (permiso, inexistente, servidor caído, sin respuesta) y ofrece «Reintentar»: ver [Si algo falla](index.md#si-algo-falla).

Lista completa: [known-issues.md](../roadmap/known-issues.md).

## Estado actual

**FUNCIONA ACTUALMENTE**: el recorrido completo, de la cuenta al replay. Torneos, **PARCIAL** ([tournaments.md](tournaments.md)).

## Documentación relacionada

- Siguiente: [Cuentas](accounts.md) · [Bots](bots.md)
- Técnica: [bots.md](../technical/bots.md), [battles.md](../technical/battles.md)
- Desarrollo de bots (SDK): `sdks/python/README.md`, `sdks/javascript/README.md`, `packages/protocol/README.md`
