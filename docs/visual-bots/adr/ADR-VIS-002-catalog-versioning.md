# ADR-VIS-002 · Versionado del catálogo visual

**Estado:** propuesto (2026-11-09, FASE 0, AUTHOR; pendiente de revisión independiente) ·
**Ámbito:** cómo se versionan definiciones y assets visuales, y qué aspecto tiene una batalla histórica.
**Base:** `mejoras-visuales` @ `983d2f5`. **Relacionados:** [MASTER-PLAN §5 SRS-F03/F04/F07/F09, §8](../MASTER-PLAN.md),
[ADR-VIS-001](ADR-VIS-001-svg-vs-raster.md), [VISUAL_COMPONENT_INVENTORY](../VISUAL_COMPONENT_INVENTORY.md).

## Contexto: qué guarda hoy una batalla (verificado en el repo)

- **Módulos inmutables y versionados.** `module.schema.json`: «Su versión es inmutable: modificar estadísticas crea una
  versión nueva». Los ids versionados (`weapon.mg@2`) son estables.
- **Catálogo con versión.** `catalog_versions` / `module_definitions` en la BD (`apps/api/src/db/migrations.ts`); el
  tournament-worker resuelve el loadout con el catálogo congelado del torneo o el último importado
  (`engine-executor.ts`). En el repo, `CATALOG_VERSION = "mvp@1"` (`loadCatalog.ts`).
- **Loadout por revisión.** `bot_loadouts` por `(bot_id, revision)`; la versión del bot apunta a su `loadout_revision`.
- **El replay lleva el equipamiento.** La cabecera del replay (`apps/arena-engine/src/replay.ts`) guarda
  `participants[]` con `spec.chassisId` y `spec.modules[].moduleId` versionados: el aspecto de una batalla histórica
  se puede reconstruir **sin** consultar el loadout actual del bot.
- **Pero el nombre no.** El índice del replay resuelve los nombres con la tabla `bots` **actual**
  (`apps/api/src/routes/replays.ts`, `viewerMetaOf`): si se renombra un bot, cambia el nombre que se ve en un replay viejo.
- **El color de equipo** es determinista y depende sólo del conjunto de equipos de la batalla (`resolveTeamColors`).
- **El arte de hoy no tiene garantía histórica.** El visor no usa assets: hornea un atlas procedural con Canvas 2D en
  tiempo de ejecución (`apps/web/src/viewer/atlas-geometry.ts`, `atlas.ts`) a partir del código de `apps/web`. Cada
  despliegue de la web que cambie ese código cambia el aspecto de **todos** los replays, viejos y nuevos. Hoy un replay
  histórico ya cambia de aspecto con el renderer; esta ADR fija cómo dejar de hacerlo, no describe algo que ya exista.

## Preguntas y respuestas

**¿Qué pasa si cambia un asset?** Un asset publicado (`approved`) es **inmutable**. Cambiarlo es publicar un asset nuevo
(nuevo `sha256`) dentro de una **nueva versión del catálogo visual**. La versión anterior sigue existiendo.

**¿Qué ve una batalla histórica?** El aspecto de la versión del catálogo visual con la que se **grabó** — o, si esa
versión ya no está disponible, la representación compatible más cercana (SRS-F07) con un aviso, nunca un hueco.

**¿Versionado por catálogo o por asset?** **Por catálogo, con hash por asset.** Una batalla guarda una sola referencia
(`visualCatalogVersion`); cada asset dentro del catálogo lleva su `sha256` para detectar manipulación y para la caché.
Versionar asset a asset obligaría a cada batalla a guardar N referencias y complicaría el determinismo (SRS-F04: la
entrada de la composición es `snapshot + versión de catálogo`; con audiencia, ver abajo: la entrada es la proyección
para esa audiencia más la versión de catálogo).

**¿Cómo evitar que un replay viejo cambie de aspecto?**

El aspecto final no depende sólo de los assets: depende también de **cómo se componen** (qué capa va encima de cuál,
dónde está cada mount, con qué rotación, espejo y escala, y qué se pinta cuando falta un módulo o un asset). Si esas
reglas viven en el código del compositor, cualquier despliegue las cambia y la versión del catálogo no protege nada.
Por eso:

1. La composición se calcula sólo con datos congelados y **proyectados por audiencia**:
   `proyección(equipamiento de la batalla, audiencia, política D-01) + visualCatalogVersion` registrada para esa batalla.
   El equipamiento de la batalla es el de la cabecera del replay (no el loadout actual), pero una vista pública sólo
   recibe su proyección (ver «¿Qué ve cada audiencia?» más abajo).
2. **`visualCatalogVersion` fija también las reglas de composición, declaradas como DATOS dentro del catálogo
   versionado:**
   - la tabla de capas (`LAYER_GROUP` → orden z, MOUNT_TYPE_DRAFT §3);
   - los mounts de cada chasis visual (tipo, posición, rotación, espejo, tamaño; ADR-VIS-003);
   - los parámetros del sistema de coordenadas (`bounds`, `overflow`, `metersPerUnit`);
   - las reglas de fallback (qué representación compatible se usa para un módulo sin definición, un asset `deprecated`
     o retirado, una versión de módulo desconocida) y la resolución módulo → asset (por id base o versionado).

   El compositor es un **intérprete genérico** de esos datos: no contiene decisiones visuales propias. Cambiar una
   regla es publicar una versión nueva del catálogo, igual que cambiar un asset.
3. Las versiones publicadas del catálogo visual no se editan ni se borran (como los módulos del catálogo de juego).
4. Las batallas anteriores a que exista el catálogo visual no tienen `visualCatalogVersion`: se resuelven con una
   versión «base» fija y declarada (la primera publicada, **con sus reglas**), nunca con la «última» ni con el arte
   procedural del visor actual.
5. Test de determinismo histórico (MASTER-PLAN §14.7), sobre el **plan de composición** (lista de capas con asset,
   `sha256`, transformación y color; no píxeles), con un corpus de batallas grabadas:
   - publicar un catálogo nuevo no cambia la composición de un replay ya grabado;
   - cambiar una regla (capas, mounts, fallback) en la versión N+1 no cambia la composición de una batalla de la N;
   - un cambio del código del compositor o del renderer produce el **mismo** plan de composición para el corpus;
   - todo lo anterior se comprueba **por perfil de vista**, y el plan público no contiene identidades no públicas.
6. Nombre del bot: decisión de producto aparte (D-06 abajo); no es un asset, pero hoy sí cambia en replays viejos.

**¿Qué ve cada audiencia? Separación entre lo intrínseco y la proyección (VIEWER_AWARE_VISUAL_PROJECTION).**

La composición de un vehículo no es una sola: depende de **quién mira**. La matriz clasifica la identidad de sensores,
blindajes, munición y energía como OBSERVER_DEPENDENT o SELF_ONLY ([VISUAL_COMPONENT_MATRIX §5 y §12](../VISUAL_COMPONENT_MATRIX.md)),
y la cabecera del replay crudo lleva el equipamiento completo. Si el compositor recibiera ese equipamiento sin proyectar
y su resultado se cacheara por bot, una composición hecha para el dueño acabaría servida a un espectador. Es la misma
clase de problema que PRE-1 («artefacto completo servido sin proyección por audiencia»), trasladada al renderer: un
CROSS_VIEW_LEAK (matriz §12.3, `cross.composition_cache`). Por eso se separan dos capas:

- **BOT_INTRINSIC_VISUAL** — lo que no depende de la audiencia: geometría del chasis, mounts, tabla de capas, assets
  aprobados de cada **componente**, paleta. Se versiona con `visualCatalogVersion` y no contiene el equipamiento de
  ningún bot concreto.
- **VIEWER_PROJECTION** — lo que sí depende: permisos de visibilidad (BOT_VISIBILITY), política de espectador (D-01),
  fog of war, equipamiento público o privado, permisos de equipo u observador, estados ocultos y, si D-08 elige
  revelar el arma tras el primer disparo, qué identidades ya se han revelado en ese instante.

**Entrada del compositor:** `proyección(equipamiento, audiencia, política D-01) + visualCatalogVersion`. El compositor no
recibe nunca el equipamiento sin proyectar en una vista pública, y la proyección la hace el backend (el frontend no es
un control de seguridad). Las vistas públicas toman el equipamiento del canal de espectador o de la proyección saneada
del replay, nunca del replay crudo (política PRE-1).

**Perfiles de vista.** Cada perfil dice qué clases de la matriz §12 ve. Un perfil **no** es una propiedad del visor:
se resuelve para cada pareja (visor, vehículo observado), ver «Proyección por pareja» más abajo. `VIEWER_ROLE` es la
relación del visor con el vehículo **observado** que exige el perfil: `spectator` = ninguna, `team` = mismo equipo,
`owner` = dueño de ese vehículo, `internal` = administración en el canal interno. Lo comprueba `TEST 9 ·
VIEWER_PROJECTION` de `packages/module-catalog/visual-contract.test.ts`, que compara la tabla con una lista canónica
(perfil, rol, clases, OBSERVER_DEPENDENT y fuente) y calcula con la tabla §12 real el conjunto de datos visibles por
perfil.

| VIEW_PROFILE | VIEWER_ROLE | SEES_CLASSES | OBSERVER_DEPENDENT | EQUIPMENT_SOURCE |
| --- | --- | --- | --- | --- |
| `view.public_live` | spectator | PUBLIC | HIDDEN | canal de espectador |
| `view.public_replay` | spectator | PUBLIC | HIDDEN | proyección saneada del replay |
| `view.broadcast` | spectator | PUBLIC | HIDDEN | canal de espectador |
| `view.ally` | team | PUBLIC, ALLY_ONLY | HIDDEN | canal de espectador + datos del equipo, autorizados por pareja |
| `view.owner` | owner | PUBLIC, ALLY_ONLY, SELF_ONLY | SHOWN | loadout del vehículo observado o su parte del replay crudo, autorizada por pareja |
| `view.internal` | internal | PUBLIC, ALLY_ONLY, SELF_ONLY | SHOWN | replay crudo autorizado en el canal interno |

NEVER_VISUALIZE no lo ve ningún perfil. OBSERVER_DEPENDENT queda `HIDDEN` en las vistas públicas mientras D-01 no se
decida; cuando se decida, cambia esta tabla (y su `spectatorPolicyVersion`), no el compositor.

**Proyección por pareja (VIEWER_ENTITY_PAIR_POLICY).** La decisión visual distingue cuatro cosas: el visor, el
vehículo observado, la relación entre ambos y la política. Un mismo humano es dueño de su bot y espectador de los
demás en la misma batalla: owner(A) viendo A es privilegiado; owner(A) viendo B, no. La entrada de la proyección es:

```ts
interface VisualProjectionContext {
  viewerId?: string; // ausente = anónimo
  viewerRole: "anonymous" | "user" | "admin" | "broadcast_renderer";
  viewerTeamIds?: string[];
  observedBotId: string;
  observedBotVersionId: string;
  observedBotOwnerId?: string;
  observedTeamId?: string;
  spectatorMode: "live_public" | "public_replay" | "broadcast" | "private" | "internal";
  spectatorPolicyVersion: string;
  visibilityPolicyVersion: string;
}
```

- **Relación** (la calcula el backend en cada petición, nunca la envía el cliente): `OWNER` si
  `viewerId = observedBotOwnerId`; `TEAMMATE` si `observedTeamId ∈ viewerTeamIds`; `INTERNAL` si `viewerRole = admin`;
  `NONE` en otro caso. `owner` y `team` son relaciones con un vehículo, no roles del visor.
- **Perfil resuelto** = f(`spectatorMode`, relación):
  - `live_public`, `public_replay` y `broadcast` son canales públicos: dan siempre su perfil público (`view.public_live`,
    `view.public_replay`, `view.broadcast`), sea cual sea la relación. El dueño que mira el directo o un replay público
    ve lo mismo que cualquiera.
  - `private` (ficha, editor, replay propio o de equipo, servido por el backend tras autorizar la pareja): `OWNER` ⇒
    `view.owner`; `TEAMMATE` ⇒ `view.ally`; `NONE` o `INTERNAL` ⇒ `view.public_live`.
  - `internal`: `INTERNAL` ⇒ `view.internal`; cualquier otra ⇒ `view.public_live`.
- En una batalla con varios participantes, cada vehículo se proyecta con su propia pareja. «RAW_REPLAY ⇒ dueño» quiere
  decir «el dueño de A recibe la parte cruda de A»; para B recibe la proyección saneada (PRE-1, matriz §12.3
  `cross.owner_to_rival`). La política PRE-1 no cambia.

Matriz mínima (la comprueba TEST 9 contra esa función, con la relación calculada a partir de `VIEWER` y `OBSERVED`):

| PAIR_CASE | VIEWER | CHANNEL | OBSERVED | RELATION | RESOLVED_PROFILE |
| --- | --- | --- | --- | --- | --- |
| `pair.owner_a.sees_a` | owner(A) | private | A | OWNER | `view.owner` |
| `pair.owner_a.sees_b` | owner(A) | private | B | NONE | `view.public_live` |
| `pair.owner_b.sees_a` | owner(B) | private | A | NONE | `view.public_live` |
| `pair.team_a.sees_a` | team(A) | private | A | TEAMMATE | `view.ally` |
| `pair.team_a.sees_b` | team(A) | private | B | NONE | `view.public_live` |
| `pair.admin.sees_a` | admin | internal | A | INTERNAL | `view.internal` |
| `pair.admin.public_live_a` | admin | live_public | A | INTERNAL | `view.public_live` |
| `pair.anonymous.sees_a` | anonymous | live_public | A | NONE | `view.public_live` |
| `pair.spectator.sees_a` | spectator | live_public | A | NONE | `view.public_live` |
| `pair.broadcast.sees_a` | broadcast | broadcast | A | NONE | `view.broadcast` |
| `pair.public_replay.sees_a` | anonymous | public_replay | A | NONE | `view.public_replay` |
| `pair.owner_a.public_live_a` | owner(A) | live_public | A | OWNER | `view.public_live` |
| `pair.owner_a.public_replay_a` | owner(A) | public_replay | A | OWNER | `view.public_replay` |

**Caché (P2_9_CACHE_ISOLATION).** Tres niveles con claves distintas; sólo se sirve al cliente lo que no lleva
equipamiento de un bot o lo que ya está proyectado para su pareja:

| CACHE_ID | KEY_FIELDS | CONTAINS | SERVED_TO_CLIENT |
| --- | --- | --- | --- |
| `cache.asset` | componentVisualId, visualCatalogVersion, renderTarget | Assets y geometría de un componente; no dice qué lleva nadie | YES |
| `cache.intrinsic_composition` | botVersionId, visualCatalogVersion, renderTarget | IntrinsicComposition: la composición completa del bot, con el equipamiento sin proyectar; es material de dueño o interno | NO |
| `cache.projected_composition` | observedBotId, botVersionId, viewerRelation, resolvedProfile, spectatorMode, spectatorPolicyVersion, visibilityPolicyVersion, visualCatalogVersion, renderTarget | ProjectedComposition: la IntrinsicComposition filtrada para una pareja (perfil del visor + vehículo observado + relación + políticas) | YES |

- La IntrinsicComposition vive sólo en el backend y nunca llega a un cliente: cualquier respuesta es una
  ProjectedComposition.
- La clave proyectada lleva `observedBotId` y la relación: owner(A)/A y owner(A)/B son entradas distintas, y owner(A)/A
  no la puede leer owner(B), porque su relación con A es `NONE` y le corresponde otra entrada. La relación de la clave
  se recalcula en el backend en cada petición; nunca se toma del cliente ni de la propia clave.
- No lleva `viewerId`: dos espectadores sin relación con el vehículo comparten entrada, y eso es seguro porque su
  proyección es la misma.
- Nunca se indexa sólo por `botVersionId` una composición que se sirva al cliente.

**Ejemplo trabajado: PRIVATE_VIEW ≠ PUBLIC_VIEW.** Un `chassis.medium@2` con `weapon.cannon@1` y `ammo.ap@1`,
`sensor.radar@1`, `armor.steel_front@1`, `movement.tracks@1`, `power.battery@1`, `radio.short@1` y `mine.explosive@1`.

| Capa | `view.owner` | `view.public_live` antes del primer disparo | `view.public_live` después |
| --- | --- | --- | --- |
| Chasis | medio | medio (PUBLIC) | medio |
| Arma | cañón | torreta genérica (identidad OBSERVER_DEPENDENT; el motor la sugiere por el giro, ENGINE_DERIVED #262, y el renderer no se adelanta) | cañón (PUBLIC por inferencia, si D-08 = a) |
| Sensor | radar | sensor genérico en `sensor_a` (presencia PUBLIC) | igual |
| Blindaje frontal | acero | placa genérica (presencia PUBLIC; material ENGINE_DERIVED tras impactos, #263) | igual |
| Tracción | orugas | genérica (dos candidatos en el medio) | igual |
| Radio y bahía de minas | antena y compuerta | antena y compuerta (PUBLIC por inferencia, §12.1) | igual |
| Munición, energía | ap, batería (sólo ficha) | nada | nada |

Las dos composiciones difieren en arma, sensor, blindaje y tracción. Si la IntrinsicComposition (clave `botVersionId`)
se sirviera al cliente, el espectador recibiría la columna del dueño; con la ProjectedComposition, cuya clave lleva el
vehículo observado, la relación y el perfil resuelto, son entradas distintas. El ejemplo es explicativo: la autoridad
son las tablas de perfiles, parejas y cachés, que comprueba el test.

**Test de no-fuga exigido para la fase de implementación** (FASE 1 o la primera que componga vehículos): para cada
batalla del corpus y cada perfil público, el plan de composición no contiene ningún `componentVisualId` cuya identidad no
sea PUBLIC (o PUBLIC por inferencia en ese instante) según la matriz; y la composición de `view.owner` difiere de la
pública siempre que el equipamiento tenga alguna identidad no pública; y, en una batalla con varios participantes, el
dueño de A ve cada vehículo B ≠ A con el plan público (la ProjectedComposition de owner(A)/B es la de un espectador). El
test de determinismo histórico (punto 5) se ejecuta **por perfil**.


**Alternativa considerada: `composerVersion` por batalla.** Registrar en cada batalla la versión del código del
compositor y conservar ejecutables las versiones antiguas. Se descarta como mecanismo principal porque obliga a
mantener vivo código viejo en el cliente y hace el determinismo depender de qué build se sirve. Queda como **salida de
emergencia**: si alguna regla no se pudiera expresar como dato, su introducción subiría una `composerVersion` registrada
por batalla, y las batallas anteriores se seguirían componiendo con la regla anterior.

**Qué cambios del renderer pueden alterar un replay histórico y cuáles no.**

| Puede cambiar sin versión nueva del catálogo | NO puede cambiar sin versión nueva del catálogo |
| --- | --- |
| Calidad del raster: resolución, antialiasing, `devicePixelRatio`, filtrado de texturas | Orden de capas (z-order) |
| Empaquetado del atlas, caché, formato intermedio (SVG→bitmap), optimizaciones de draw calls | Posición, rotación, espejo o escala de un mount |
| Interfaz fuera de la composición del vehículo: controles, línea de tiempo, HUD textual | Qué asset se elige para un módulo (incluida la regla id base / versionado) |
| Efectos transitorios no declarados en el catálogo (fogonazo, explosión, humo): fuera de la garantía hasta que se declaren | Reglas de fallback y de deprecación |
| | El contenido de un asset (su `sha256`) |
| | La paleta de equipo y su asignación (hoy en `resolveTeamColors`, código de `packages/game-rules`; pasa a ser **dato del catálogo visual versionado**: ver «Decisión») |

Lo de la columna izquierda puede cambiar cómo **se ve** a nivel de píxel, pero no **qué** se compone; lo de la derecha
cambia el plan de composición y por tanto exige versión nueva.

**¿Dónde se registra `visualCatalogVersion`?** Propuesta: junto al resto de metadatos de la batalla (fuera del hash de
estado del motor, para no tocar el determinismo de la simulación). La forma exacta (columna o metadato del replay) la
fija FASE 6; esta ADR sólo exige que exista y sea inmutable. No se toca el motor en FASE 0.

**Caché.** Los tres niveles de «Proyección por pareja» (`cache.asset`, `cache.intrinsic_composition` y
`cache.projected_composition`, SRS-F09). Al cliente nunca se le sirve una entrada indexada sólo por `botVersionId`. La paleta va dentro de `visualCatalogVersion`, así que no hace falta
como componente aparte. Como las versiones publicadas son inmutables, una entrada de caché no caduca por contenido; sólo
por espacio.
Las respuestas HTTP de assets publicados pueden ser `immutable` si su URL incluye versión o hash. Las respuestas de
replays siguen `private, no-store` como hoy (contenido autorizado por usuario).

**Deprecación.** Estados del asset: `draft → approved → deprecated`. `deprecated` = no se usa para batallas NUEVAS, pero
sigue resolviéndose para las históricas que lo referencian. Un asset sólo se puede retirar del todo si ninguna versión
de catálogo referenciada por una batalla lo usa; si aun así hay que retirarlo (licencia, seguridad), se sustituye por el
fallback compatible y se registra el cambio.

## Decisión

- Catálogo visual versionado como **datos en el repo** (MASTER-PLAN §8.2: `packages/bot-visuals/catalog/`), con versión
  de catálogo inmutable y `sha256` por asset.
- La versión del catálogo incluye las **reglas de composición como datos** (capas, mounts, coordenadas, fallback); el
  compositor las interpreta y no decide nada por su cuenta.
- Cada batalla nueva registra su `visualCatalogVersion`; la composición histórica usa **sólo** datos congelados.
- El compositor recibe `proyección(equipamiento, audiencia, D-01) + visualCatalogVersion`: separa BOT_INTRINSIC_VISUAL de
  VIEWER_PROJECTION. La proyección se resuelve **por pareja** con `VisualProjectionContext` (visor, vehículo observado,
  relación y políticas), y la caché que se sirve al cliente (ProjectedComposition) lleva en la clave el vehículo
  observado, la relación y el perfil resuelto. Las vistas públicas no consumen nunca el replay crudo (PRE-1).
- **Paleta (P3-5):** la paleta de equipo y su regla de asignación pasan a ser **dato del catálogo visual versionado**
  (como la tabla de capas). Se descarta «congelar la versión de la paleta» como mecanismo aparte porque obligaría a
  registrar por batalla una segunda referencia. Las batallas anteriores al catálogo visual se resuelven con la paleta
  de la versión «base» (punto 4), que reproduce el `resolveTeamColors` actual.
- Hoy (atlas procedural) no hay garantía histórica; existe desde la primera versión publicada del catálogo.
- Se mantiene la forma visual por **id base** de módulo (las versiones de balance comparten forma: `weapon.mg@1` y
  `@2`), salvo que una versión nueva cambie la forma física; entonces la definición visual apunta al id versionado.

## Consecuencias

- FASE 1 incluye en el schema `catalogVersion`, `status` y `sha256` (SRS-F03), y además la tabla de capas, los mounts y
  las reglas de fallback como datos versionados del catálogo.
- FASE 6 añade el registro de `visualCatalogVersion` por batalla y el test de determinismo histórico sobre el plan de
  composición, incluidos los cambios de reglas y de código del compositor, por perfil de vista.
- La primera fase que componga vehículos incluye el test de no-fuga (plan público sin identidades no públicas) y la
  caché separada intrínseca / composición.
- La proyección por audiencia la hace el backend; el arreglo de PRE-1 (replay público saneado, crudo restringido) va en
  otro PR contra `main`.
- Hay que decidir el tratamiento del nombre de bot en replays (D-06).

## Decisiones de producto abiertas

- **D-06 · Nombre del bot en replays viejos**: ¿se congela el nombre de la batalla o se muestra el actual? Hoy se
  muestra el actual.
