/**
 * R3.3 · ERR-VIS-09 — Atlas de texturas PROCEDURAL del visor.
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
 * DECISIÓN (documentada en el reporte R3.3): en este entorno no se puede
 * generar arte gráfico de calidad, así que el atlas es procedural mínimo
 * (formas horneadas a canvas en runtime). El ARTE FINAL es de R3.4: para
 * sustituirlo basta con registrar un PNG real bajo la misma clave y los mismos
 * nombres de frame — el resto del visor no cambia.
 *
 * La GEOMETRÍA del atlas (buildAtlasLayout) es pura y determinista: se prueba
 * con vitest sin canvas ni navegador (frames dentro del lienzo, sin solapes,
 * separación anti-sangrado). Solo drawAtlas/installAtlas tocan el DOM.
 */
import Phaser from "phaser";

export const ATLAS_KEY = "s9-atlas";
export const ATLAS_FONT_KEY = "s9-font";

/** Separación entre frames: evita el sangrado (bleeding) al filtrar la textura. */
const GUTTER = 2;

/** Resolución de los frames de entidad: 2 px de textura por px de pantalla (nitidez con zoom). */
export const FRAME_SCALE = 2;

export interface AtlasFrameSpec {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasFontSpec {
  /** Esquina del bloque de glifos dentro del atlas. */
  offsetX: number;
  offsetY: number;
  /** Celda monoespaciada por glifo. */
  cellW: number;
  cellH: number;
  /** Juego de caracteres, en orden de celda (ASCII imprimible completo). */
  chars: string;
  charsPerRow: number;
}

export interface AtlasLayout {
  width: number;
  height: number;
  frames: AtlasFrameSpec[];
  font: AtlasFontSpec;
}

/** ASCII imprimible completo (espacio → tilde): cubre ids en minúscula, dígitos y signos. */
function printableAscii(): string {
  let s = "";
  for (let c = 0x20; c <= 0x7e; c++) s += String.fromCharCode(c);
  return s;
}

/**
 * Geometría del atlas. Tamaños de frame en px de textura (FRAME_SCALE× los px
 * de pantalla que ocupan a zoom 1): body 3,2×2,2 m y turret 2,4×0,5 m a
 * 8 px/m — las mismas medidas que los Shapes que sustituyen.
 */
export function buildAtlasLayout(): AtlasLayout {
  const frames: AtlasFrameSpec[] = [];
  let x = GUTTER;
  const y = GUTTER;
  let rowH = 0;
  const put = (name: string, w: number, h: number): void => {
    frames.push({ name, x, y, w, h });
    x += w + GUTTER;
    rowH = Math.max(rowH, h);
  };
  put("body", 3.2 * 8 * FRAME_SCALE, 2.2 * 8 * FRAME_SCALE); // 51×35 → casco del tanque
  put("turret", 2.4 * 8 * FRAME_SCALE, 0.5 * 8 * FRAME_SCALE); // cañón
  put("projectile", 12, 12); // punto de proyectil (círculo blanco)
  put("pixel", 4, 4); // blanco 4×4: HUD/efectos de R3.4+ sin nueva textura

  const chars = printableAscii();
  const charsPerRow = 16;
  const cellW = 10;
  const cellH = 14;
  const rows = Math.ceil(chars.length / charsPerRow);
  const fontY = y + rowH + GUTTER * 2;
  const font: AtlasFontSpec = { offsetX: 0, offsetY: fontY, cellW, cellH, chars, charsPerRow };

  const width = Math.max(x, charsPerRow * cellW);
  const height = fontY + rows * cellH;
  // Redondeo a múltiplos de 64: tamaños amables con la GPU y sitio de sobra.
  return { width: ceilTo(width, 64), height: ceilTo(height, 64), frames, font };
}

function ceilTo(v: number, m: number): number {
  return Math.ceil(v / m) * m;
}

/**
 * Dibuja el atlas sobre un contexto 2D (runtime; sin cobertura de vitest — no
 * hay canvas en jsdom). Todo BLANCO: el color lo pone setTint por equipo.
 */
export function drawAtlas(ctx: CanvasRenderingContext2D, layout: AtlasLayout): void {
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.fillStyle = "#ffffff";
  for (const f of layout.frames) {
    if (f.name === "projectile") {
      ctx.beginPath();
      ctx.arc(f.x + f.w / 2, f.y + f.h / 2, Math.min(f.w, f.h) / 2 - 1, 0, Math.PI * 2);
      ctx.fill();
    } else if (f.name === "body") {
      // Casco con orejas de oruga: silueta mínima legible, no un rectángulo plano.
      const trackH = Math.round(f.h * 0.18);
      ctx.globalAlpha = 0.75;
      ctx.fillRect(f.x, f.y, f.w, trackH);
      ctx.fillRect(f.x, f.y + f.h - trackH, f.w, trackH);
      ctx.globalAlpha = 1;
      ctx.fillRect(f.x, f.y + trackH, f.w, f.h - trackH * 2);
    } else {
      ctx.fillRect(f.x, f.y, f.w, f.h);
    }
  }
  const font = layout.font;
  ctx.font = `${font.cellH - 3}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < font.chars.length; i++) {
    const cx = font.offsetX + (i % font.charsPerRow) * font.cellW + font.cellW / 2;
    const cy = font.offsetY + Math.floor(i / font.charsPerRow) * font.cellH + font.cellH / 2;
    ctx.fillText(font.chars[i], cx, cy);
  }
}

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
