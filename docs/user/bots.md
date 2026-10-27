# Bots: crear, código, versiones y publicación

## Resumen

En **«Mis bots»** creas bots, configuras su equipamiento, subes versiones de código y las envías a validación. Cada envío pasa por un *pipeline* de comprobaciones que **ejecuta tu código en un contenedor aislado** y lo enfrenta a un bot de referencia. Si las supera, puedes **publicar** la versión, y sólo las versiones publicadas juegan. Cada versión conserva su propio código, build y artefacto, y no cambia nunca: para modificarla creas una versión nueva desde ella.

Importante: esto funciona en la rama del cierre funcional con Docker. En la instalación desplegada falta configurar el sandbox del worker de builds ([TD-001](../roadmap/technical-debt.md#td-001)). Mientras no se configure, los envíos terminan «rejected» con «sandbox no verificado», y eso no es un fallo de tu código.

## Índice

- [Crear un bot](#crear-un-bot)
- [Configurar el equipamiento](#configurar-el-equipamiento)
- [Subir código](#subir-código)
- [Versiones y estados](#versiones-y-estados)
- [Enviar a validación (build)](#enviar-a-validación-build)
- [Publicar](#publicar)
- [Ver un bot y sus versiones](#ver-un-bot-y-sus-versiones)
- [Usar el bot](#usar-el-bot)
- [Errores / limitaciones](#errores--limitaciones)
- [Estado actual](#estado-actual)
- [Documentación relacionada](#documentación-relacionada)

## Crear un bot

**FUNCIONA ACTUALMENTE.**

1. «Mis bots» → campo **«Nombre del bot»** (hasta 48 caracteres, único entre tus bots) → **«Crear bot»**. Un nombre vacío, demasiado largo o repetido se explica junto al formulario («Ya tienes un bot llamado «Tanque».»). Pulsar dos veces crea un solo bot.
2. Aparece en la lista como `nombre (private)`. Junto a cada bot hay un enlace **«batallas»** que lleva a sus batallas.

Si no tienes ninguno verás «Aún no tienes bots: crea el primero abajo.». Todos los bots nacen **privados**. Desde la web no puedes cambiar la visibilidad, renombrar ni borrar un bot (**PENDIENTE**).

## Configurar el equipamiento

**FUNCIONA ACTUALMENTE.** Pulsa sobre el nombre del bot y aparece el **«Editor de loadout»**. Elige el chasis, llena las ranuras y pulsa **«Guardar revisión»**; después, «Guardar como nueva revisión». Detalle en [Equipamiento](equipment.md). **Necesitas un loadout guardado para poder subir código.** Si no lo tienes, verás «Guarda antes una configuración (loadout) para poder subir código.».

## Subir código

**PARCIAL.**

1. En la tarjeta «Versiones de *bot*» → **«Subir código (pegado)»**.
2. Elige el **Runtime**: Python o JavaScript (Node). Debajo se resume qué debe contener el código.
3. El área **«Código»** arranca con una **plantilla válida** del runtime: patrulla y, si el radar ve a alguien, apunta y dispara con las armas de tu loadout. Pasa el build tal cual. Si cambias de runtime sin haberla tocado, se cambia por la del otro; si ya escribiste algo, se respeta. «Restaurar la plantilla» vuelve a ella.
4. Pulsa **«Subir como versión nueva»**. Se crea la versión siguiente (v1, v2…) en estado `draft`, ligada a tu revisión de loadout actual.

Si la sesión caduca mientras escribes, al volver a entrar el código sin subir de esa pestaña se recupera, con el aviso «Recuperado el código sin subir de esta sesión». Lo mismo en el editor de la pestaña Code del detalle del bot.

Límites y particularidades:

- Sólo se puede **pegar** texto; no hay botón para elegir un archivo.
- El código se empaqueta solo con el SDK oficial (`arena-sdk`), así que no puedes añadir dependencias desde la web.
- Tamaño máximo: 10 MB.
- Ejemplos de bots: `example-bots/python/`, `example-bots/javascript/`. SDK: `sdks/python`, `sdks/javascript`.
- **Qué debe contener tu código**:
  - **Python** (3.11): una clase que herede de `arena_sdk.ArenaBot` (llámala `Bot` si defines varias) con `on_observation(self, observation)` devolviendo el comando.
  - **JavaScript** (Node 20): un **módulo ES** (`import` / `export`, no `require`) que exporte (`export default` o `export class Bot`) una clase que extienda `ArenaBot` de `@arena/sdk`, con `onObservation(observation)`. **TypeScript no se acepta**: el runtime no lo ejecuta y el build lo rechaza diciendo que es TypeScript. Los ejemplos JavaScript del repositorio (`example-bots/javascript/`) y el tutorial del SDK son JavaScript ESM que se pueden subir tal cual.

  No hace falta conectar nada: la plataforma instancia tu clase y la conecta a la batalla.
- **El hook es obligatorio.** Si tu clase no implementa `on_observation` (Python) u `onObservation` (JavaScript), por ejemplo porque el nombre tiene una errata, el build lo **rechaza**: «tu clase Bot no implementa on_observation(self, observation): sin él el bot no hace nada en la batalla. ¿Quisiste decir «on_observaton»? Renómbralo a «on_observation».». Antes un bot así pasaba todas las etapas sin hacer nada. Un bot que sí lo implementa y devuelve `{}` («sin cambios») pasa.

Ejemplo mínimo en Python:

```python
from arena_sdk import ArenaBot


class Bot(ArenaBot):
    def on_observation(self, observation):
        return {"move": {"throttle": 0.8, "steer": 0.2}}
```

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

**FUNCIONA ACTUALMENTE** en la rama del cierre funcional, con el sandbox configurado. **PENDIENTE** de configurar en la instalación desplegada.

1. Pulsa **«Enviar a validación vN»**.
2. La tarjeta **«Pipeline de build · vN · …»** muestra las etapas: `structure`, `static_analysis`, `dependencies`, `build`, `protocol_test`, `smoke_battle`, `resource_limits`, `secret_scan`, `sign` y `publish`. Mientras dura dice «En curso: comprobando cada 2 s…».
3. Al terminar, el build queda `passed` y la versión `validated`, o `failed` con la versión `rejected` y el motivo.

Qué comprueban las etapas de ejecución:

- `protocol_test`: que tu bot arranca, se conecta y envía comandos válidos.
- `smoke_battle`: que juega una partida corta contra un bot de referencia sin ser descalificado.
- `resource_limits`: que arranca en menos de 5 s y decide en menos de 100 ms.

Si la versión no supera la validación, la tarjeta **«vN: Tu bot no ha superado la validación»** te dice:

- el **origen**: tu código, o la plataforma («tu código no tiene la culpa»);
- la **fase** en la que falló;
- **dónde**: el **fichero y la línea** de tu código («`src/bot.py`, línea 7»), sin rutas internas de la plataforma;
- el motivo, la última línea del error («NameError: name 'x' is not defined»);
- que **vN NO está publicada** y no puede usarse en batallas, y qué versión publicada sigue en juego, si la hay;
- qué hacer. Si el fallo es de tu código, el botón **«Corregir el código de vN»** lo carga en el editor y lo guardarás como versión nueva. Si es de la plataforma, **«Reenviar vN a validación sin cambios»**.

Motivos típicos y qué hacer:

| Motivo | Qué significa |
|---|---|
| «tu clase … no implementa on_observation…» / «…onObservation…» | falta el hook o tiene una errata: renómbralo como sugiere el mensaje |
| «el bot no completó el handshake…» | tu código no llegó a conectarse: un bucle o una espera al importar, o un error. Si se ve, el fichero y la línea del error van al final |
| «ningún COMMAND válido… (runtime: … Traceback …)» | tu bot lanzó una excepción. La última línea de la traza aparece en el motivo |
| «mensaje(s) fuera de protocolo…» | devuelves un comando con valores fuera de rango, por ejemplo `throttle` fuera de [-1, 1] |
| «candidato descalificado en la partida de humo» | no respondió a tiempo demasiadas veces seguidas |
| «construcción(es) dinámica(s) prohibida(s)», «import(s) de paquete no permitido», «secreto(s) detectado(s)» | lo detecta el análisis estático, antes de ejecutar nada |
| «build no verificable: …» | falló la plataforma (el entorno aislado no estaba disponible), no tu código. Reenvía más tarde |

En la vista de detalle del bot (ver abajo), **«Ver build»** muestra cada etapa con su mensaje, sus
logs y sus métricas: tiempo de arranque, tiempo de decisión, comandos válidos y CPU.

Si el pipeline no responde, tras unas 30 comprobaciones verás «El pipeline sigue sin dar un resultado tras 30 comprobaciones: estado desconocido. Pulsa «Actualizar estado»…».

## Publicar

**FUNCIONA ACTUALMENTE** (con el sandbox configurado). El botón **«Publicar vN»** sólo aparece en versiones `validated`. Al publicar, el código **no** se hace público: la web siempre publica con el código privado.

## Ver un bot y sus versiones

**FUNCIONA ACTUALMENTE.** En «Mis bots», pulsa **«detalle y versiones»** junto al bot (`#/bots/<id>`). Tiene cuatro pestañas:

- **Overview**: visibilidad, última versión publicada, número de versiones y enlace a sus batallas.
- **Code**: elige una versión y verás sus ficheros. Puedes editar el código y pulsar **«Guardar como versión nueva desde vN»**: se crea la versión siguiente en `draft` y **vN no cambia**. Si el código no es tuyo y es privado, verás «No tienes permiso para ver el código de esta versión».
- **Equipment**: las revisiones de loadout y qué versiones usa cada una. Para editar, usa el editor de «Mis bots».
- **Versions**: tabla con versión (y de cuál se creó), fecha, estado y motivo, resultado del build, artefacto (hash) y publicación. Tiene estas acciones:
  - «Ver código»;
  - «Ver build»;
  - «Nueva versión desde ésta», que copia el código tal cual;
  - «Comparar con vN-1», que muestra las diferencias línea a línea y permite elegir otra versión con la que comparar.

Una versión enviada, validada o publicada **no se puede modificar ni borrar**. Las batallas
guardan qué versión jugó cada bot, así que publicar una versión nueva no cambia lo que jugó una
batalla anterior.

## Usar el bot

- **En una batalla de práctica**: necesitas 2 bots con versión publicada; eliges qué versión publicada juega cada uno. Ver [Batallas](battles.md).
- **En un torneo**: inscribes la última versión publicada. Ver [Torneos](tournaments.md). **PARCIAL.**
- En la batalla, el vehículo lo conduce **tu código** con el **loadout** de esa versión ([Equipamiento](equipment.md)).

## Errores / limitaciones

- **Asignar el bot a un equipo**: **PENDIENTE** ([Equipos](teams.md)).
- **Ver el código de una versión**: **FUNCIONA ACTUALMENTE** en la pestaña Code.
- **Paquetes de varios ficheros**: la web edita el fichero de entrada. Un paquete completo (`{"files":[…]}`) se sube por API.
- **Versión `frozen` tras un torneo**: no puede inscribirse en otro torneo.

## Estado actual

**PARCIAL**:

- Crear, configurar, subir, validar en el sandbox, publicar y consultar o comparar versiones funcionan en la rama del cierre funcional.
- En la instalación desplegada falta configurar el sandbox del worker de builds ([TD-001](../roadmap/technical-debt.md#td-001)).
- En el código integrado las batallas ejecutan tu código con tu loadout; si está activado en un servidor concreto lo dice [current-status.md](../roadmap/current-status.md).

## Documentación relacionada

- Usuario: [Equipamiento](equipment.md), [Batallas](battles.md), [Torneos](tournaments.md)
- Técnica: [bots.md](../technical/bots.md), [bot-versioning.md](../technical/bot-versioning.md), [equipment.md](../technical/equipment.md), [frontend.md](../technical/frontend.md)
- Problemas conocidos: [known-issues.md](../roadmap/known-issues.md), [TD-001](../roadmap/technical-debt.md#td-001), [TD-002](../roadmap/technical-debt.md#td-002)
