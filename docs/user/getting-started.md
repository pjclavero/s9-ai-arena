# Primeros pasos

## Resumen

Este es el recorrido que la plataforma prevé para un usuario nuevo. Al lado de cada paso indicamos hasta dónde llega hoy, para que no pierdas tiempo en pasos que todavía no pueden completarse.

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
| 5 | Enviar a validación | «Enviar a validación vN» | **PARCIAL**: se procesa, pero termina siempre en `rejected` ([TD-001](../roadmap/technical-debt.md#td-001)) |
| 6 | Publicar la versión | «Publicar vN» | **PENDIENTE**: el botón sólo aparece en versiones `validated`, y hoy ninguna llega a ese estado |
| 7 | Jugar una batalla de práctica | «Batallas» → «+ Nueva batalla de práctica» | **PENDIENTE**: 400 «rulesetId desconocido» ([TD-003](../roadmap/technical-debt.md#td-003)) |
| 8 | Inscribirse en un torneo | «Torneos» | **PARCIAL**: requiere una versión publicada |
| 9 | Ver la batalla | Visor / replay | **PENDIENTE**: no se dibuja ([TD-009](../roadmap/technical-debt.md#td-009)) |
| 10 | Ver tu posición | «Ranking» | **PARCIAL**: sale vacío |

## Uso: tu primera sesión

1. **Crea tu cuenta**: email, contraseña de al menos 12 caracteres y nombre visible. Entras directamente. Ver [Cuentas](accounts.md).
2. **Ve a «Mis bots»**, escribe un nombre en «Nombre del bot» y pulsa «Crear bot».
3. **Pulsa sobre el nombre del bot** para abrir su detalle y configura el **editor de loadout**:
   - elige un chasis;
   - llena cada ranura;
   - vigila «Coste» y «Energía»;
   - pulsa «Guardar revisión».

   Ver [Equipamiento](equipment.md).
4. **En «Subir código (pegado)»** elige el runtime (`python` o `node`), pega tu código y pulsa «Subir como versión nueva». Hay ejemplos y SDK en `example-bots/` y `sdks/` del repositorio.
5. **Pulsa «Enviar a validación v1»**. El panel dice «Validación en curso…» y, al terminar, la versión quedará `rejected` con un motivo que empieza por «sandbox no verificado». **No es un fallo de tu código**: la plataforma todavía no puede ejecutar bots en su entorno aislado.

Hasta que se resuelva ese punto, no puedes avanzar más con tus propios bots. Puedes explorar «Mapas», el «Editor de mapas», «Torneos», «Equipos» y «Ranking».

## Errores / limitaciones

- La web no explica el ciclo ni muestra ayuda dentro de las pantallas. Términos como `loadout`, `runtime` o los nombres de las etapas del pipeline aparecen tal cual.
- Algunos formularios se muestran a todos aunque exigen permisos de organizador (crear torneo, generar o publicar mapa). Fallan con «Requiere rol organizer».
- Si escribes una dirección que no existe (por ejemplo, `#/loquesea`), vuelves a «Mis bots» sin aviso.

Lista completa: [known-issues.md](../roadmap/known-issues.md).

## Estado actual

**PARCIAL**: puedes preparar bots, pero no hacer que jueguen.

## Documentación relacionada

- Siguiente: [Cuentas](accounts.md) · [Bots](bots.md)
- Técnica: [bots.md](../technical/bots.md), [battles.md](../technical/battles.md)
- Desarrollo de bots (SDK): `sdks/python/README.md`, `sdks/javascript/README.md`, `packages/protocol/README.md`
