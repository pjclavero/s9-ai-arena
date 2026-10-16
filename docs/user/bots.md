# Bots: crear, código, versiones y publicación

## Resumen

En **«Mis bots»** creas bots, configuras su equipamiento, subes versiones de código y las envías a validación. Cada envío pasa por un *pipeline* de comprobaciones; si las supera, puedes **publicar** la versión, y sólo las versiones publicadas juegan. **Hoy toda versión termina «rejected»**: la plataforma todavía no puede ejecutar los bots en su entorno aislado durante la validación ([TD-001](../roadmap/technical-debt.md#td-001)). No es un fallo de tu código.

## Índice

- [Crear un bot](#crear-un-bot)
- [Configurar el equipamiento](#configurar-el-equipamiento)
- [Subir código](#subir-código)
- [Versiones y estados](#versiones-y-estados)
- [Enviar a validación (build)](#enviar-a-validación-build)
- [Publicar](#publicar)
- [Usar el bot](#usar-el-bot)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Crear un bot

**FUNCIONA ACTUALMENTE.**

1. «Mis bots» → campo **«Nombre del bot»** (hasta 48 caracteres, único entre tus bots) → **«Crear bot»**.
2. Aparece en la lista como `nombre (private)`. Junto a cada bot hay un enlace **«batallas»** que lleva a sus batallas.

Si no tienes ninguno verás «Aún no tienes bots: crea el primero abajo.». Todos los bots nacen **privados**. Desde la web no puedes cambiar la visibilidad, renombrar ni borrar un bot (**PENDIENTE**).

## Configurar el equipamiento

**FUNCIONA ACTUALMENTE.** Pulsa sobre el nombre del bot y aparece el **«Editor de loadout»**. Elige el chasis, llena las ranuras y pulsa **«Guardar revisión»**; después, «Guardar como nueva revisión». Detalle en [Equipamiento](equipment.md). **Necesitas un loadout guardado para poder subir código.** Si no lo tienes, verás «Guarda antes una configuración (loadout) para poder subir código.».

## Subir código

**PARCIAL.**

1. En la tarjeta «Versiones de *bot*» → **«Subir código (pegado)»**.
2. Elige el **Runtime**: `python` o `node`.
3. Pega el código en **«Código»**.
4. Pulsa **«Subir como versión nueva»**. Se crea la versión siguiente (v1, v2…) en estado `draft`, ligada a tu revisión de loadout actual.

Límites y particularidades:

- Sólo se puede **pegar** texto; no hay botón para elegir un archivo.
- El código se empaqueta solo con el SDK oficial (`arena-sdk`), así que no puedes añadir dependencias desde la web.
- Tamaño máximo: 10 MB.
- Ejemplos de bots: `example-bots/python/`, `example-bots/javascript/`. SDK: `sdks/python`, `sdks/javascript`.

## Versiones y estados

La tabla de versiones muestra para cada una su número, estado, runtime, motivo de rechazo y la acción pendiente:

| Estado | Qué significa | Lo que ves |
|---|---|---|
| `draft` | Subida, sin enviar | «SIN ENVIAR» · «sin enviar — pulsa «Enviar a validación»» |
| `validating` | En el pipeline | «Validación en curso…» |
| `rejected` | No superó la validación | Motivo en rojo · «corrige el código y vuelve a enviarla» · botón «Reenviar vN» |
| `validated` | Superó la validación | «pendiente de publicar» · botón «Publicar vN» |
| `published` | Jugable | `vN publicada` junto al nombre del bot |
| `frozen` | Congelada por un torneo | — |
| `suspended`, `retired` | Suspendida por moderación / retirada | — |

La tarjeta **«Última subida: vN · estado»** resume la versión que estás mirando («◀ mirando»). Puedes cambiar con «Ver vN» y refrescar con **«Actualizar estado»**.

## Enviar a validación (build)

**PARCIAL: el proceso funciona, pero el resultado es siempre `rejected`.**

1. Pulsa **«Enviar a validación vN»**.
2. La tarjeta **«Pipeline de build · vN · …»** muestra las etapas: `structure`, `static_analysis`, `dependencies`, `build`, `protocol_test`, `smoke_battle`, `resource_limits`, `secret_scan`, `sign` y `publish`. Mientras dura dice «En curso: comprobando cada 2 s…».
3. Al terminar, el estado será `failed` y la versión `rejected` con el motivo: «sandbox no verificado: etapa(s) de ejecución no ejecutable(s) [protocol_test, smoke_battle, resource_limits]. Se requiere un entorno con Docker (agentResolver)…».

**«Reenviar» no sirve** mientras dure este problema: el rechazo es de la plataforma. Las etapas anteriores sí comprueban tu código. Si fallan, el motivo te dice qué corregir, por ejemplo «construcción(es) dinámica(s) prohibida(s)», «import(s) de paquete no permitido» o «secreto(s) detectado(s)».

Si el pipeline no responde, tras unas 30 comprobaciones verás «El pipeline sigue sin dar un resultado tras 30 comprobaciones: estado desconocido. Pulsa «Actualizar estado»…».

## Publicar

**PENDIENTE.** El botón **«Publicar vN»** sólo aparece en versiones `validated`. Al publicar, el código **no** se hace público: la web siempre publica con el código privado.

## Usar el bot

- **En una batalla de práctica**: necesitas 2 bots con versión publicada. Ver [Batallas](battles.md). **PENDIENTE.**
- **En un torneo**: inscribes la última versión publicada. Ver [Torneos](tournaments.md). **PARCIAL.**
- **Importante**: aunque tu bot juegue, **el vehículo lo conduce hoy un bot de prueba de la plataforma**, no tu código. Tu equipamiento sí se aplica ([TD-002](../roadmap/technical-debt.md#td-002)).

## Errores / limitaciones

- **Error al crear un bot**: si el nombre está vacío o repetido, el error no se ve si no tienes un bot abierto. Si pulsas dos veces «Crear bot» puede producirse un error interno ([TD-022](../roadmap/technical-debt.md#td-022), [TD-013](../roadmap/technical-debt.md#td-013)).
- **Asignar el bot a un equipo**: **PENDIENTE** ([Equipos](teams.md)).
- **Ver el código de una versión**: **PENDIENTE** (sin pantalla).
- **Versión `frozen` tras un torneo**: no puede inscribirse en otro torneo.

## Estado actual

**PARCIAL**: crear, configurar y subir funcionan; ninguna versión llega a publicarse.

## Documentación relacionada

- Usuario: [Equipamiento](equipment.md), [Batallas](battles.md), [Torneos](tournaments.md)
- Técnica: [bots.md](../technical/bots.md), [equipment.md](../technical/equipment.md), [frontend.md](../technical/frontend.md)
- Problemas conocidos: [known-issues.md](../roadmap/known-issues.md), [TD-001](../roadmap/technical-debt.md#td-001), [TD-002](../roadmap/technical-debt.md#td-002)
