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
entrada de la composición es `snapshot + versión de catálogo`).

**¿Cómo evitar que un replay viejo cambie de aspecto?**

El aspecto final no depende sólo de los assets: depende también de **cómo se componen** (qué capa va encima de cuál,
dónde está cada mount, con qué rotación, espejo y escala, y qué se pinta cuando falta un módulo o un asset). Si esas
reglas viven en el código del compositor, cualquier despliegue las cambia y la versión del catálogo no protege nada.
Por eso:

1. La composición se calcula sólo con datos congelados: equipamiento de la cabecera del replay (no el loadout actual) +
   `visualCatalogVersion` registrada para esa batalla.
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
   - un cambio del código del compositor o del renderer produce el **mismo** plan de composición para el corpus.
6. Nombre del bot: decisión de producto aparte (D-06 abajo); no es un asset, pero hoy sí cambia en replays viejos.

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
| | La paleta de equipo y su asignación (hoy en `resolveTeamColors`, código de `packages/game-rules`; pasa a ser dato del catálogo o se congela su versión) |

Lo de la columna izquierda puede cambiar cómo **se ve** a nivel de píxel, pero no **qué** se compone; lo de la derecha
cambia el plan de composición y por tanto exige versión nueva.

**¿Dónde se registra `visualCatalogVersion`?** Propuesta: junto al resto de metadatos de la batalla (fuera del hash de
estado del motor, para no tocar el determinismo de la simulación). La forma exacta (columna o metadato del replay) la
fija FASE 6; esta ADR sólo exige que exista y sea inmutable. No se toca el motor en FASE 0.

**Caché.** Clave = `(botVersionId o hash del equipamiento, visualCatalogVersion, renderTarget, palette)` (SRS-F09). Como
las versiones publicadas son inmutables, una entrada de caché no caduca por contenido; sólo por espacio.
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
- Hoy (atlas procedural) no hay garantía histórica; existe desde la primera versión publicada del catálogo.
- Se mantiene la forma visual por **id base** de módulo (las versiones de balance comparten forma: `weapon.mg@1` y
  `@2`), salvo que una versión nueva cambie la forma física; entonces la definición visual apunta al id versionado.

## Consecuencias

- FASE 1 incluye en el schema `catalogVersion`, `status` y `sha256` (SRS-F03), y además la tabla de capas, los mounts y
  las reglas de fallback como datos versionados del catálogo.
- FASE 6 añade el registro de `visualCatalogVersion` por batalla y el test de determinismo histórico sobre el plan de
  composición, incluidos los cambios de reglas y de código del compositor.
- Hay que decidir el tratamiento del nombre de bot en replays (D-06).

## Decisiones de producto abiertas

- **D-06 · Nombre del bot en replays viejos**: ¿se congela el nombre de la batalla o se muestra el actual? Hoy se
  muestra el actual.
