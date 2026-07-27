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
- **Sondeo acotado**: solo mientras hay trabajo en curso (versión `validating` o build
  `queued`/`running`), cada 2 s, con un presupuesto **finito** (30 intentos ≈ 60 s).
  Agotado, el panel dice **«estado desconocido»** y ofrece «Actualizar estado». Nunca
  inventa un `passed`/`failed`.
- **Tres situaciones distinguidas**: *en curso* (aviso `aria-live` con la cadencia),
  *terminado* (estado real del build), *no se sabe* (sondeo agotado o lectura de builds
  fallida ⇒ ni una etapa pintada).
- **`draft` visible**: marca `· SIN ENVIAR` y columna con la acción pendiente
  («pulsa «Enviar a validación»»), botón rotulado con el número de versión.
- La subida usa la **revisión de loadout vigente** y el botón se deshabilita si el bot aún
  no tiene ninguna.

## Verificación

- `apps/web/tests/b11-bots-panel-verdad.test.tsx` (13 tests): montan el escenario exacto de
  producción (v1..v4) contra un backend falso **con estado mutable** —el worker termina el
  pipeline *después*, como en la realidad— y comprueban **qué se renderiza**.
- `apps/api/src/b11-version-builds.test.ts` (7 tests): endpoint contra PostgreSQL real,
  incluido un caso con el encolador **real** (`QueueBotManager`) que reproduce el 202
  `queued`+`pending` y demuestra que solo esta lectura revela el final.
- Seis mutaciones de no-vacuidad demostradas con salida real (ver informe del bloque),
  entre ellas la que reproduce el síntoma exacto: enfocar v1 en vez de v4.

### Lo que NO se ha podido verificar

- **No hay demonio Docker** en el entorno del agente: no se ha construido la imagen
  `infrastructure/docker/web`. Como esa imagen solo hace `npx vite build apps/web`, se
  verificó el **bundle de producción real** con el mismo bundler y se comprobó que el
  código nuevo está en el chunk emitido. `phaser` (declarado en `package.json`) no está
  instalado en este entorno, fallo **preexistente** ajeno a este cambio; se alias-eó a un
  stub solo para esa verificación, sin tocar la configuración del repo.
- **No se ha abierto un navegador de verdad** ni se ha probado contra VM108. Todo lo
  afirmado sobre el render proviene de jsdom + Testing Library.
