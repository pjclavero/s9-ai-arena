/**
 * R3.3/R3.4 · GEOMETRÍA y DIBUJO del atlas del visor — PURO, sin Phaser.
 *
 * Separado de atlas.ts (que sí importa Phaser para installAtlas) precisamente
 * para poder probarlo con vitest en Node: la geometría del atlas es determinista
 * (frames dentro del lienzo, sin solapes, separación anti-sangrado) y drawAtlas
 * sólo necesita un CanvasRenderingContext2D. Importar Phaser en un test de Node
 * revienta (navigator/canvas), así que esta capa vive aparte.
 *
 * El apartado artístico de R3.4 se hornea aquí: un CASCO por arquetipo (siluetas
 * distintas), torreta, arma (cañón), proyectil, bandera, icono de módulo y
 * partículas (humo/chispa). Todo en la MISMA textura ⇒ un solo asset batcheable.
 */

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

/** px de textura por metro de mundo (8 px/m de pantalla × FRAME_SCALE de nitidez). */
const PX_PER_M = 8 * FRAME_SCALE;

/** Ancho máximo de fila del atlas: al superarlo, el empaquetado salta de fila. */
const MAX_ROW_W = 256;

/** Nombres de frame de CASCO por arquetipo (deben coincidir con art-direction.ts). */
export const BODY_FRAMES = ["body-scout", "body-gunner", "body-heavy"] as const;

/**
 * Geometría del atlas (R3.4). Tamaños en px de textura (FRAME_SCALE× los px de
 * pantalla a zoom 1). El apartado artístico añade, sobre la infraestructura de
 * R3.3, un CASCO por arquetipo (siluetas distintas: explorador pequeño y con
 * proa, artillero medio, pesado ancho), cañón, arma, proyectil, bandera, icono
 * de módulo y partículas (humo/chispa). TODO se hornea en la MISMA textura: un
 * único asset batcheable (el contador de draw calls de R3.3 lo verifica).
 */
export function buildAtlasLayout(): AtlasLayout {
  const frames: AtlasFrameSpec[] = [];
  let x = GUTTER;
  let y = GUTTER;
  let rowH = 0;
  let maxRight = GUTTER;
  const put = (name: string, w: number, h: number): void => {
    // Empaquetado por filas: mantiene el atlas compacto en vez de una tira larga.
    if (x > GUTTER && x + w + GUTTER > MAX_ROW_W) {
      x = GUTTER;
      y += rowH + GUTTER;
      rowH = 0;
    }
    frames.push({ name, x, y, w, h });
    x += w + GUTTER;
    rowH = Math.max(rowH, h);
    maxRight = Math.max(maxRight, x);
  };
  // Cascos por arquetipo (dimensiones en metros → siluetas de distinto tamaño).
  put("body-scout", 2.6 * PX_PER_M, 1.8 * PX_PER_M); // ligero y esbelto
  put("body-gunner", 3.2 * PX_PER_M, 2.2 * PX_PER_M); // medio (medida clásica)
  put("body-heavy", 3.8 * PX_PER_M, 2.8 * PX_PER_M); // pesado y ancho
  put("turret", 1.4 * PX_PER_M, 1.4 * PX_PER_M); // base de torreta (redonda)
  put("barrel", 2.4 * PX_PER_M, 0.5 * PX_PER_M); // cañón/arma
  put("projectile", 12, 12); // punto de proyectil (círculo blanco)
  put("flag", 1.6 * PX_PER_M, 2.0 * PX_PER_M); // bandera (asta + banderín)
  put("module", 0.9 * PX_PER_M, 0.9 * PX_PER_M); // icono de módulo (rombo)
  put("smoke", 1.6 * PX_PER_M, 1.6 * PX_PER_M); // partícula de humo (disco suave)
  put("spark", 0.8 * PX_PER_M, 0.8 * PX_PER_M); // partícula de chispa (estrella)
  put("pixel", 4, 4); // blanco 4×4: HUD/efectos sin nueva textura

  const chars = printableAscii();
  const charsPerRow = 16;
  const cellW = 10;
  const cellH = 14;
  const rows = Math.ceil(chars.length / charsPerRow);
  const fontY = y + rowH + GUTTER * 2;
  const font: AtlasFontSpec = { offsetX: 0, offsetY: fontY, cellW, cellH, chars, charsPerRow };

  const width = Math.max(maxRight, charsPerRow * cellW);
  const height = fontY + rows * cellH;
  // Redondeo a múltiplos de 64: tamaños amables con la GPU y sitio de sobra.
  return { width: ceilTo(width, 64), height: ceilTo(height, 64), frames, font };
}

function ceilTo(v: number, m: number): number {
  return Math.ceil(v / m) * m;
}

/**
 * Dibuja el atlas sobre un contexto 2D (runtime; sin cobertura de vitest — no
 * hay canvas en jsdom). Todo BLANCO: el color lo pone setTint por equipo. Cada
 * frame es una silueta REAL renderizable, no un placeholder vacío (R3.4).
 */
export function drawAtlas(ctx: CanvasRenderingContext2D, layout: AtlasLayout): void {
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.fillStyle = "#ffffff";
  for (const f of layout.frames) {
    switch (f.name) {
      case "projectile":
        drawDisc(ctx, f.x + f.w / 2, f.y + f.h / 2, Math.min(f.w, f.h) / 2 - 1);
        break;
      case "body-scout":
        drawHull(ctx, f, "scout");
        break;
      case "body-gunner":
        drawHull(ctx, f, "gunner");
        break;
      case "body-heavy":
        drawHull(ctx, f, "heavy");
        break;
      case "turret":
        // Base de torreta: disco con boca hacia +x (donde se ancla el cañón).
        drawDisc(ctx, f.x + f.w / 2, f.y + f.h / 2, Math.min(f.w, f.h) / 2 - 1);
        break;
      case "flag":
        drawFlag(ctx, f);
        break;
      case "module":
        drawDiamond(ctx, f);
        break;
      case "smoke":
        drawSmoke(ctx, f);
        break;
      case "spark":
        drawSpark(ctx, f);
        break;
      default: // barrel, pixel: rectángulos macizos
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

// ─────────────────────────── siluetas procedurales (R3.4) ───────────────────
// Todas dibujan en BLANCO dentro del rectángulo del frame; el color es setTint.

function drawDisc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Casco del vehículo apuntando a +x (donde se ancla la torreta). Silueta por
 * arquetipo: el explorador acaba en PROA (afilado), el artillero es un bloque
 * medio y el pesado un bloque ancho con orugas gruesas. Se distinguen de un
 * vistazo por tamaño y forma (DoD ERR-VIS-05).
 */
function drawHull(ctx: CanvasRenderingContext2D, f: AtlasFrameSpec, kind: "scout" | "gunner" | "heavy"): void {
  const trackFrac = kind === "heavy" ? 0.24 : kind === "scout" ? 0.14 : 0.18;
  const trackH = Math.max(2, Math.round(f.h * trackFrac));
  // Orugas: dos bandas más tenues arriba y abajo.
  ctx.globalAlpha = 0.7;
  ctx.fillRect(f.x, f.y, f.w, trackH);
  ctx.fillRect(f.x, f.y + f.h - trackH, f.w, trackH);
  ctx.globalAlpha = 1;
  const top = f.y + trackH;
  const hy = f.h - trackH * 2;
  if (kind === "scout") {
    // Proa afilada: pentágono con vértice a la derecha.
    const nose = f.x + f.w;
    const bodyRight = f.x + f.w * 0.6;
    ctx.beginPath();
    ctx.moveTo(f.x, top);
    ctx.lineTo(bodyRight, top);
    ctx.lineTo(nose, top + hy / 2);
    ctx.lineTo(bodyRight, top + hy);
    ctx.lineTo(f.x, top + hy);
    ctx.closePath();
    ctx.fill();
  } else if (kind === "heavy") {
    // Bloque ancho con esquinas biseladas y remaches.
    const bevel = Math.round(hy * 0.22);
    ctx.beginPath();
    ctx.moveTo(f.x, top + bevel);
    ctx.lineTo(f.x + bevel, top);
    ctx.lineTo(f.x + f.w - bevel, top);
    ctx.lineTo(f.x + f.w, top + bevel);
    ctx.lineTo(f.x + f.w, top + hy - bevel);
    ctx.lineTo(f.x + f.w - bevel, top + hy);
    ctx.lineTo(f.x + bevel, top + hy);
    ctx.lineTo(f.x, top + hy - bevel);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.55;
    const r = Math.max(1, Math.round(hy * 0.08));
    drawDisc(ctx, f.x + f.w * 0.28, top + hy / 2, r);
    drawDisc(ctx, f.x + f.w * 0.62, top + hy / 2, r);
    ctx.globalAlpha = 1;
  } else {
    // Artillero: casco rectangular con una muesca frontal (glacis).
    const notch = Math.round(hy * 0.28);
    ctx.beginPath();
    ctx.moveTo(f.x, top);
    ctx.lineTo(f.x + f.w - notch, top);
    ctx.lineTo(f.x + f.w, top + notch);
    ctx.lineTo(f.x + f.w, top + hy - notch);
    ctx.lineTo(f.x + f.w - notch, top + hy);
    ctx.lineTo(f.x, top + hy);
    ctx.closePath();
    ctx.fill();
  }
}

/** Bandera: asta vertical a la izquierda + banderín triangular a la derecha. */
function drawFlag(ctx: CanvasRenderingContext2D, f: AtlasFrameSpec): void {
  const poleW = Math.max(2, Math.round(f.w * 0.16));
  ctx.fillRect(f.x, f.y, poleW, f.h);
  ctx.beginPath();
  ctx.moveTo(f.x + poleW, f.y);
  ctx.lineTo(f.x + f.w, f.y + f.h * 0.28);
  ctx.lineTo(f.x + poleW, f.y + f.h * 0.56);
  ctx.closePath();
  ctx.fill();
}

/** Icono de módulo: rombo macizo (marca de estado del vehículo). */
function drawDiamond(ctx: CanvasRenderingContext2D, f: AtlasFrameSpec): void {
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  ctx.beginPath();
  ctx.moveTo(cx, f.y);
  ctx.lineTo(f.x + f.w, cy);
  ctx.lineTo(cx, f.y + f.h);
  ctx.lineTo(f.x, cy);
  ctx.closePath();
  ctx.fill();
}

/** Humo: disco de borde suave (varias coronas de alfa decreciente). */
function drawSmoke(ctx: CanvasRenderingContext2D, f: AtlasFrameSpec): void {
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  const rMax = Math.min(f.w, f.h) / 2 - 1;
  for (let i = 4; i >= 1; i--) {
    ctx.globalAlpha = 0.18 * (5 - i);
    drawDisc(ctx, cx, cy, (rMax * i) / 4);
  }
  ctx.globalAlpha = 1;
}

/** Chispa: estrella de cuatro puntas (dos husos cruzados). */
function drawSpark(ctx: CanvasRenderingContext2D, f: AtlasFrameSpec): void {
  const cx = f.x + f.w / 2;
  const cy = f.y + f.h / 2;
  const mid = Math.max(1, Math.min(f.w, f.h) * 0.16);
  ctx.beginPath();
  ctx.moveTo(cx, f.y);
  ctx.lineTo(cx + mid, cy);
  ctx.lineTo(f.x + f.w, cy);
  ctx.lineTo(cx + mid, cy + mid);
  ctx.lineTo(cx, f.y + f.h);
  ctx.lineTo(cx - mid, cy + mid);
  ctx.lineTo(f.x, cy);
  ctx.lineTo(cx - mid, cy - mid);
  ctx.closePath();
  ctx.fill();
}
