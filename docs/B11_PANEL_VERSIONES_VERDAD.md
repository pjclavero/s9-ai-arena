# B11 · El panel de versiones de bots debe decir la verdad

Defecto **real** observado por el dueño del proyecto (2026-07-27) tras cuatro intentos de
subir un bot desde la web. Dos de las cuatro veces el panel le hizo creer que la subida no
había funcionado cuando sí lo había hecho.

Estado real en la BD de producción para ese bot: `v1 rejected` (node), `v2 rejected`
(python), `v3 draft`, `v4 rejected` (python). El panel no reflejaba nada de eso.

## Hallazgos de la investigación (código en `main@98f381e`)

`apps/web/src/pages/BotsPage.tsx` cargaba el detalle del bot con `useResource(...)` y
dependencias `[selected?.id]`: **una sola lectura por bot, sin sondeo de ningún tipo**.
De ahí salen los tres síntomas:

1. **Error de una versión antigua.** El "Pipeline de build" era el `useState<Build>` que
   guardaba la respuesta 202 de `POST …/actions/submit`, sin rótulo de a qué versión
   pertenecía y sin limpiarse al subir otra versión: seguía en pantalla el resultado de v1
   mientras el usuario ya iba por la v4. Además, la tabla de versiones era una foto fija:
   una v1 leída como `validating` seguía diciendo `validating` horas después de estar
   `rejected` en BD.
2. **Pipeline eternamente `pending`.** El 202 del submit es "aceptado", no "terminado":
   `QueueBotManager` solo persiste el trabajo en `jobs` y el pipeline corre en el worker
   del bot-manager. El panel se quedaba con esa foto (`status: queued`, diez etapas
   `pending`) para siempre.
3. **`draft` invisible.** Una versión creada y no enviada se pintaba igual que las demás,
   sin marca ni acción pendiente.

Defecto adicional encontrado al leer el código: la subida enviaba
`loadoutRevision = "1"` **fijo**. Si la revisión 1 ya no era la vigente el POST podía
fallar con un 400 que el usuario lee como "no se ha subido nada".

## Qué faltaba en el backend

El contrato solo tiene `GET /builds/{buildId}`, y ese id **solo** lo conoce quien acaba de
hacer el submit. Tras un F5 no había forma honesta de saber cómo terminó el pipeline. Se
amplía el backend (extensión, `defineExtension`) en vez de maquillar el cliente:

```
GET /bots/{botId}/versions/{version}/builds   (min-role: user)
```

Builds de esa versión, del más reciente al más antiguo, con la misma visibilidad de objeto
que el bot y la misma regla de `logUrl` (x-private) que `getBuild`. Registrada en la lista
de extensiones conocidas de `conformance.test.ts`.

## Diseño del cliente

- **Versión enfocada explícita**: la recién subida/enviada, o la de número **más alto**.
  El resumen destacado y el pipeline se leen SIEMPRE de ella y van rotulados con su número
  (`Última subida: v4 · rejected`, `Pipeline de build · v4 · failed`). Cada fila muestra su
  propio motivo de rechazo; hay un botón «Ver vN» para enfocar otra versión.
- **El motivo de rechazo solo se pinta si la versión está `rejected`** (`rejectionToShow`).
  Ver más abajo: `submit` arrastraba el motivo del intento anterior.
- **Sondeo acotado**: solo mientras hay trabajo en curso (versión `validating` o build
  `queued`/`running`), cada 2 s, con un presupuesto **finito** (30 intentos ≈ 60 s).
  Agotado, el panel dice **«estado desconocido»** y ofrece «Actualizar estado». Nunca
  inventa un `passed`/`failed`.
- **Revalidación silenciosa y de un solo recurso**: el sondeo pide únicamente los builds y
  **sin volver a `loading`**. Ver más abajo: recargar los tres recursos desmontaba el panel.
- **Cuatro situaciones distinguidas**: *consultando* (aún no ha llegado la primera
  respuesta), *en curso* (aviso `aria-live` con la cadencia), *terminado* (estado real del
  build) y *no se sabe* (sondeo agotado o lectura de builds fallida). En "no se sabe" **no
  se pinta la tabla de etapas**: una tabla de `pending` es justo la foto que hizo creer al
  usuario que su subida seguía en cola.
- **`draft` visible**: marca `· SIN ENVIAR` y columna con la acción pendiente
  («pulsa «Enviar a validación»»), botón rotulado con el número de versión.
- La subida usa la **revisión de loadout vigente** y el botón se deshabilita si el bot aún
  no tiene ninguna.

## Correcciones tras la revisión del Supervisor

1. **El motivo de rechazo sobrevivía al reenvío.** `applyTransition` pone
   `state = "validating"` y solo se limpiaba `rejection_reason` al pasar a `validated`. Una
   versión rechazada y reenviada quedaba `validating` **con el error del intento anterior**
   en la fila, y la tarjeta destacada lo pintaba: exactamente la cadena que engañó al dueño
   del proyecto, ahora más visible que antes. Arreglado **en el origen** (`submit` limpia
   `rejection_reason`) y **en el cliente** (`rejectionToShow` exige estado `rejected`, para
   no depender del dato limpio en filas antiguas).
2. **El sondeo desmontaba el panel y tiraba trabajo del usuario.** `useResource` volvía a
   `loading` en cada recarga y `ResourceView` sustituye el subárbol entero: durante los ~60 s
   posteriores a cada envío el panel se remontaba cada 2 s, el área de código y el editor de
   loadout se recreaban, **se perdía el foco** y **los cambios sin guardar se revertían
   solos**. Además cada ciclo pedía tres recursos (~93 peticiones por ventana), incluido
   `/loadouts`, que es el que remonta el editor y no hace ninguna falta para el pipeline.
   Ahora `useResource` admite `reload({ silent: true })` (revalida conservando los datos
   previos) y el ciclo pide **solo** los builds; las versiones se revalidan **una vez**,
   cuando el build llega a estado terminal —que es cuando pueden haber cambiado, porque
   `completeBuild` actualiza build y versión en la misma transacción—.
   Al implementarlo apareció un defecto propio de la revalidación silenciosa: la marca de
   "silencioso" era un único booleano que consumía el primer efecto, así que dos recargas
   seguidas hacían que la segunda volviera a `loading` y el panel parpadeara igual. Ahora la
   marca va **indexada por nonce**.
3. **Afirmación falsa en esta misma documentación.** Decía "ni una etapa pintada" cuando el
   sondeo se agotaba, pero se seguían pintando las filas `pending` bajo el rótulo "estado
   desconocido". Corregido el código (ahora es cierto) y el texto.
4. **(N1) Una lectura obsoleta borraba el aviso de una posterior fallida.** El aviso de
   "estado desfasado" lo fijaba el *loader* con un `setState` propio, y el guard `alive` de
   `useResource` no puede proteger un efecto secundario que el loader hace por su cuenta.
   Con dos lecturas de `/versions` solapadas que resuelven **fuera de orden** —pulsar
   «Actualizar estado» dos veces seguidas, justo lo que hace el usuario impaciente que
   originó el bloque— la lectura B fallaba y mostraba el aviso, y a continuación llegaba la
   lectura A, ya obsoleta, con éxito, y lo **borraba**: `useResource` descartaba
   correctamente los datos de A, así que quedaban en pantalla los datos anteriores a ambas
   lecturas y **sin ningún aviso**. El mismo pecado del bloque con otra cara: conservar los
   datos previos convertido en callar el fallo. La marca vive ahora **dentro del recurso**
   (`Resource.staleError`), donde solo la lectura vigente puede ponerla o quitarla.

## Verificación

- `apps/web/tests/b11-bots-panel-verdad.test.tsx` (27 tests): montan el escenario exacto de
  producción (v1..v4) contra un backend falso **con estado mutable** —el worker termina el
  pipeline *después*, como en la realidad, y con latencia de red configurable, porque un
  mock instantáneo esconde el remonte del panel— y comprueban **qué se renderiza**:
  identidad de los nodos del DOM, foco, valor de los controles y número de peticiones.
- `apps/api/src/b11-version-builds.test.ts` (8 tests): endpoint contra PostgreSQL real,
  incluido un caso con el encolador **real** (`QueueBotManager`) que reproduce el 202
  `queued`+`pending` y demuestra que solo esta lectura revela el final.
- Quince mutaciones de no-vacuidad demostradas con salida real (ver informe del bloque),
  entre ellas la que reproduce el síntoma exacto (enfocar v1 en vez de v4) y la que devuelve
  la marca de desfase al loader, fuera del guard `alive`.

### Lo que NO se ha podido verificar

- **No hay demonio Docker** en el entorno del agente: no se ha construido la imagen
  `infrastructure/docker/web`. Como esa imagen solo hace `npx vite build apps/web`, se
  verificó el **bundle de producción real** con el mismo bundler y se comprobó que el
  código nuevo está en el chunk emitido. `phaser` (declarado en `package.json`) no está
  instalado en este entorno, fallo **preexistente** ajeno a este cambio; se alias-eó a un
  stub solo para esa verificación, sin tocar la configuración del repo.
- **No se ha abierto un navegador de verdad** ni se ha probado contra VM108. Todo lo
  afirmado sobre el render proviene de jsdom + Testing Library.
- La imagen `web` que construye CI (`build-images (web)`) es la **genérica** de
  `node-service`, no la de `infrastructure/docker/web/Dockerfile` (vite + nginx) que es la
  que despliega `docker-compose.yml`. Es decir: **CI no construye la SPA que ve el usuario**.
  Ajeno a este bloque, pero conviene arreglarlo.

## Aumento de superficie a tener en cuenta

`GET /bots/{botId}/versions/{version}/builds` es **enumerable** y `getBuild` no lo era:
antes hacía falta un identificador de build inadivinable, ahora basta con `bot + versión`.
Para un bot **público**, cualquier usuario autenticado puede recorrer sus versiones y leer
los mensajes de etapa del pipeline, que pueden contener rutas del servidor. No es una fuga
nueva —`getBuild` ya exponía ese mismo contenido a quien tuviera el id, y `logUrl` sigue
restringido a dueño/staff—, pero sí es más superficie. Si algún día molesta, la vía es
restringir la lectura de builds a dueño/equipo/staff (los builds de bots públicos no son
información que el público necesite).
