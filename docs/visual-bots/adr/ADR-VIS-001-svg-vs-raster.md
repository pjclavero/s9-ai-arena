# ADR-VIS-001 · Formato visual: SVG por capas frente a raster

**Estado:** propuesto (2026-11-09, FASE 0, AUTHOR; pendiente de revisión independiente) ·
**Ámbito:** formato de los assets visuales de bots y cómo llega cada contexto (ficha, editor, mapa, replay, broadcast) a
pintarlos. **No** cambia el motor ni el visor en esta fase.
**Base:** `mejoras-visuales` @ `983d2f5`. **Relacionados:** [MASTER-PLAN §7](../MASTER-PLAN.md),
[VISUAL_COMPONENT_MATRIX §11](../VISUAL_COMPONENT_MATRIX.md), [ADR-VIS-002](ADR-VIS-002-catalog-versioning.md),
[ADR-VIS-003](ADR-VIS-003-mount-coordinate-system.md).

## Contexto: cómo se pinta hoy (verificado en el repo)

- **Mapa en directo, replay y broadcast usan el MISMO visor**: Phaser 3 (`apps/web/src/viewer/PhaserViewer.ts`).
  `/broadcast` lo reutiliza (`apps/web/src/pages/BroadcastPage.tsx`), y el replay le da snapshots grabados
  (`replay-player.ts`, `replay-feed.ts`).
- **No hay ficheros de imagen.** Todo el arte (cascos por arquetipo, torretas, cañón, proyectil, bandera, humo,
  explosión, fuente) se dibuja con Canvas 2D al arrancar y se hornea en **un único atlas** registrado como una textura
  de Phaser (`atlas-geometry.ts`, `atlas.ts`). El color de equipo se aplica con `setTint` sobre frames blancos para no
  romper el batch del renderer (R3.3, ERR-VIS-09).
- **El rendimiento se mide**: `render-stats.ts` cuenta draw calls reales de WebGL y FPS; el objetivo de R3.3 fue bajar
  de ~35 draw calls por frame a «un puñado» con 8 bots. Hay test de Playwright del visor (`acceptance/visual/visor.spec.ts`).
- **El broadcast se renderiza por software**: el streamer abre `/broadcast` en Chromium en modo kiosco a 1920×1080 sobre
  un framebuffer virtual, con WebGL forzado por SwiftShader (`apps/streamer/src/ffmpeg.ts`). Cualquier coste extra de
  render en el visor se paga en CPU en la emisión.
- **Ficha y editor** son React DOM (`BotDetailPage.tsx`, `LoadoutEditor.tsx`) y hoy **no** tienen ninguna imagen del bot.

Conclusión de contexto: el MASTER-PLAN propone SVG por capas. Para ficha/editor encaja tal cual (DOM). Para
mapa/replay/broadcast **no** encaja meter SVG en el DOM por encima del canvas: rompería el modelo de una sola
textura batcheable que ya está medido y protegido.

## Opciones evaluadas

| Criterio | A · SVG por capas (DOM) | B · PNG/WebP por capas | C · Sprite sheets | D · Canvas procedural (lo actual) | E · Pre-render en build |
| --- | --- | --- | --- | --- | --- |
| Ficha | Excelente: nítido a cualquier tamaño, accesible | Bien a un tamaño; borroso al escalar | Pobre (pensado para animación) | Posible, pero código de dibujo por pieza | Bien a los tamaños pre-generados |
| Editor (preview en vivo) | Excelente: recomponer capas es cambiar nodos | Bien | Pobre | Posible | Malo: cada combinación nueva exige generar |
| Mapa (muchos bots) | Malo en DOM sobre canvas; bien si se rasteriza a textura | Bien como textura | Muy bien | Muy bien (ya medido) | Bien |
| Replay | Igual que mapa | Igual que mapa | Igual que mapa | Igual que mapa | Igual que mapa |
| Broadcast 1080p (software) | Malo en DOM; bien rasterizado a la resolución de salida | Bien si el raster es ≥ resolución de salida | Bien | Bien (ya se emite así) | Bien |
| Recolor por equipo/paleta | Excelente (tokens/clases) | Limitado a `setTint` multiplicativo | Limitado | Bien (`setTint`) | Una variante por paleta |
| Animación | Buena en DOM; en Phaser vía transformaciones de sprites | Por frames o transformaciones | Por frames | Transformaciones | Por frames |
| Rendimiento | DOM: coste por nodo; rasterizado: igual que raster | Bueno | Muy bueno | Muy bueno | Muy bueno |
| Mantenimiento | Bueno: diff legible, una fuente por pieza | Regular: binarios, re-exportar | Malo: regenerar hojas | Malo: el arte vive en código | Regular: pipeline extra |
| Seguridad | Exige sanitizar (scripts, `foreignObject`, URLs externas, CSS) | Baja superficie | Baja superficie | Sin assets externos | Sanitizar en build |
| Golden tests | Estructural (JSON/DOM) + pixel | Pixel | Pixel | Pixel + geometría (ya existe para el atlas) | Pixel |

## Decisión recomendada

**SVG por capas como formato FUENTE único; dos caminos de render según el contexto.**

1. **Ficha y editor**: SVG en línea compuesto por capas en el DOM (React), con tokens de color (MASTER-PLAN §11). Es
   donde el SVG aporta más y donde el coste por nodo no importa (un bot, o pocos).
2. **Mapa, replay y broadcast**: el SVG **ya saneado** se **rasteriza en el cliente al cargar** (a la resolución que
   pide `FRAME_SCALE` y el contexto) y se hornea en el atlas de Phaser, igual que hoy se hornean las formas procedurales.
   Se conserva una sola textura, el `setTint` por equipo y el contador de draw calls. Las piezas de un bot (casco,
   placas, orugas, torreta, arma, sensores) son sprites del mismo atlas colocados según ADR-VIS-003.
3. **Pre-render en build (E)** queda como plan B si el rasterizado en cliente no cumple el presupuesto en el broadcast
   por software; la decisión se toma con el benchmark de 1/8/16/32 bots del MASTER-PLAN §14.6 (FASE 5).
4. **Fallback**: el arte procedural actual (D) es el fallback natural (SRS-F06): si falta un asset, el visor sigue
   pintando la silueta por arquetipo que ya existe.

Esto **valida** la propuesta SVG del MASTER-PLAN §7.1 con un matiz: SVG es la fuente y el formato de la ficha, pero
**no** el formato de dibujo del mapa/broadcast, que sigue siendo raster dentro de Phaser. Coincide con la opción 2 del
MASTER-PLAN §7.2 («raster derivado automáticamente del SVG»).

## Consecuencias

- FASE 1 define un subconjunto SVG permitido (sin `<script>`, sin `foreignObject`, sin `href` externos, sin `<style>`
  libre; sólo tokens de color conocidos) y un validador que lo hace cumplir en CI (gate VISUAL_SECURITY).
- El recolor en el mapa sigue siendo multiplicativo (`setTint`); para colores secundarios (paleta de bot) haría falta
  rasterizar una variante por paleta o separar las zonas recolorables en sprites distintos. Se decide en ADR-VIS-005.
- Golden tests en dos niveles: composición estructural (JSON determinista, rápido, en vitest) y pixel (Playwright,
  como el actual `acceptance/visual`).
- Rasterizar SVG en el navegador depende del motor de render del navegador: el golden pixel debe fijar el navegador de
  referencia (el mismo Chromium del streamer).

## Lo que esta ADR no decide

Paletas de usuario (ADR-VIS-005), seguridad detallada de assets (ADR-VIS-006), versionado (ADR-VIS-002) y coordenadas
(ADR-VIS-003).
