/**
 * R3.3 · ERR-VIS-09 — Atlas de texturas PROCEDURAL del visor (capa Phaser).
 *
 * Antes cada entidad era un Shape (Rectangle/Arc/Graphics) y cada etiqueta un
 * Text: cada uno rompe el batch del renderer (~35 draw calls por frame con
 * 8 bots). Este módulo hornea TODAS las formas del visor y una fuente de mapa
 * de bits (RetroFont) en UN único canvas registrado como una sola textura de
 * Phaser: todos los sprites y BitmapText comparten textura y el renderer los
 * despacha en un puñado de draw calls. El color por equipo se aplica con
 * setTint sobre frames blancos (el tinte no rompe el batch; cambiar de textura
 * sí).
 *
 * R3.4 · ERR-VIS-05 — el APARTADO ARTÍSTICO (cascos por arquetipo, torreta,
 * arma, proyectil, bandera, icono de módulo, humo/chispa) se hornea sobre esta
 * misma textura: sigue siendo un solo asset batcheable.
 *
 * La GEOMETRÍA y el DIBUJO del atlas viven en atlas-geometry.ts (PUROS, sin
 * Phaser) para poder probarse con vitest en Node. Aquí sólo queda installAtlas,
 * que toca el DOM y Phaser.
 */
import Phaser from "phaser";
import { ATLAS_KEY, ATLAS_FONT_KEY, buildAtlasLayout, drawAtlas } from "./atlas-geometry.js";

export {
  ATLAS_KEY,
  ATLAS_FONT_KEY,
  FRAME_SCALE,
  BODY_FRAMES,
  buildAtlasLayout,
  drawAtlas,
  type AtlasFrameSpec,
  type AtlasFontSpec,
  type AtlasLayout,
} from "./atlas-geometry.js";

/**
 * Registra el atlas (una sola textura con todos los frames) y la RetroFont en
 * la escena. Idempotente: el atlas es compartido por todas las escenas del juego.
 */
export function installAtlas(scene: Phaser.Scene): void {
  if (!scene.textures.exists(ATLAS_KEY)) {
    const layout = buildAtlasLayout();
    const canvas = document.createElement("canvas");
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("atlas: sin contexto 2D para hornear las texturas");
    drawAtlas(ctx, layout);
    const texture = scene.textures.addCanvas(ATLAS_KEY, canvas);
    if (!texture) throw new Error("atlas: no se pudo registrar la textura");
    for (const f of layout.frames) texture.add(f.name, 0, f.x, f.y, f.w, f.h);
  }
  if (!scene.cache.bitmapFont.exists(ATLAS_FONT_KEY)) {
    const font = buildAtlasLayout().font;
    scene.cache.bitmapFont.add(
      ATLAS_FONT_KEY,
      Phaser.GameObjects.RetroFont.Parse(scene, {
        image: ATLAS_KEY,
        "offset.x": font.offsetX,
        "offset.y": font.offsetY,
        width: font.cellW,
        height: font.cellH,
        chars: font.chars,
        charsPerRow: font.charsPerRow,
        "spacing.x": 0,
        "spacing.y": 0,
        lineSpacing: 0,
      }),
    );
  }
}
