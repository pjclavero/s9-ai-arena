# R16 · Visual upgrade — Slice 1 (sprites y efectos básicos)

> Implementado en la rama `feature/r16-visual-upgrade`. Verificado leyendo directamente
> `apps/web/src/viewer/atlas-geometry.ts`, `art-direction.ts`, `effects.ts`, `PhaserViewer.ts`
> y sus tests. Plan de fases: `docs/R16_VISUAL_UPGRADE.md` (este slice cubre R16.1 y la parte
> básica de R16.2).

## Qué es

Mejora visual del viewer web (`apps/web`, Phaser 4) **dentro de la arquitectura procedural
existente** (R3.4): todo el arte sigue horneado en Canvas2D a un único atlas en runtime
(blanco + `setTint`), sin un solo fichero de imagen en el repo.

- **Torretas diferenciadas por chasis** (R16.1): frames `turret-scout`/`turret-gunner`/
  `turret-heavy` con tamaño y perfil escalados por arquetipo (1.1/1.4/1.8 × PX_PER_M),
  sustituyendo al frame único `turret` legado (migrados todos sus usos; sin alias).
  Selección por la función pura `turretFrameForChassis()` en `art-direction.ts`, mismo
  criterio de fallback que `bodyFrameForChassis()`.
- **Fogonazo de disparo** (R16.2 básico): frame `muzzle-flash` (llama alargada 1.6×1.0 m)
  emitido al detectar un proyectil nuevo, integrado en el `EffectSystem` existente con vida
  corta. Sin heading del disparador (el `ProjectileDot` público solo trae id/posición), el
  fogonazo se ancla al origen del proyectil — resolver la orientación exigiría tocar el
  contrato de balística, fuera de alcance.
- **Explosión animada** (R16.2 básico): secuencia `explosion-0/1/2` (tres fases del mismo
  tamaño 2.4×2.4 m para que el cambio de frame no salte de escala), elegida en render por la
  función pura `explosionFrameForAge(ageMs)` (tramos 0–110/110–220/220+ ms, estable en la
  última fase). El núcleo de la explosión de `vehicle_destroyed`/`mine_triggered` usa la
  secuencia; la corona de chispas, el humo y el decal de scorch existentes se conservan.

## Reglas duras del slice (verificadas)

- **Sin WebGL avanzado**: cero shaders/pipelines custom/bloom; solo sprites del atlas.
- **Sin CDN ni red externa**: cero URLs nuevas; el atlas sigue siendo 100 % procedural.
- **Sin assets binarios**: el repo sigue sin contener ninguna imagen.
- **Sin dependencias npm nuevas** (`package.json` intacto).
- **Determinismo intacto**: cero `Math.random`; los efectos siguen derivando su variación del
  hash del evento (idénticos en directo y replay). El motor (`apps/arena-engine`), el
  snapshot/protocolo y `apps/arena-viewer` (demo legacy Phaser 3) no se tocan.

## Tests y mutaciones

Toda la lógica nueva vive en módulos puros testeables en Node (jsdom no carga Phaser):

- `apps/web/tests/viewer-r16.test.ts` (nuevo): frames nuevos presentes en `buildAtlasLayout`,
  dentro del lienzo y sin solapes; ausencia del `turret` legado; mismas dimensiones en las
  tres fases de explosión; mapeo y fallback de `turretFrameForChassis`; tramos y estabilidad
  de `explosionFrameForAge` (incl. edad negativa); ciclo de vida en `EffectSystem` del
  fogonazo (frame propio, nace y expira) y del núcleo de explosión.
- `apps/web/tests/viewer-r34.test.ts`: actualizado al catálogo de frames nuevo (los candados
  de no-solape y un-solo-asset siguen).
- **Mutaciones de no-vacuidad**: 4 verificadas (mapeo de torreta fijo, secuencia de explosión
  fija, solape de frames, frame de fogonazo falso — todas cazadas y revertidas). Una quinta
  (ignorar la edad al pintar en `PhaserViewer.renderEffects`) documentó la **limitación
  conocida** de que el pintado Phaser real no es ejecutable en vitest/jsdom: esa capa la
  cubre solo la aceptación visual Playwright (`acceptance/visual/`, no bloqueante), como el
  resto del pintado del proyecto.

## Qué queda para fases posteriores (catálogo R16)

R16.3 panel de estadísticas, R16.4 sonido, R16.5 texturas de terreno, R16.6 niebla/sombreado
determinista, R16.7 shaders (alto riesgo, prohibido de momento), R16.8 atlas/lazy/CDN
(gateado; sin dependencia de red externa hasta entonces).
