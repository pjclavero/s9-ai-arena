/**
 * Primitivas geométricas compartidas por las comprobaciones. Reproducen las MISMAS
 * convenciones que apps/map-service/src/to-engine-map.ts (la fuente de verdad sobre
 * cómo se interpreta una `Shape`), para que validador y motor no diverjan:
 *   - rect: `position` es el CENTRO; `widthM`/`heightM` son dimensiones COMPLETAS;
 *           `rotation` (radianes) rota el rectángulo alrededor de su centro.
 *   - circle: `position` es el centro; `radiusM` el radio.
 *   - polygon: `points` en coordenadas de mundo (metros).
 */
import type { Shape, Vec2 } from "../types.js";

/** ¿Está el punto `p` (metros) dentro de la forma? Borde incluido. */
export function pointInShape(p: Vec2, shape: Shape): boolean {
  const c = shape.position ?? { x: 0, y: 0 };
  switch (shape.shape) {
    case "circle": {
      const r = shape.radiusM ?? 0;
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      // Comparo cuadrados para no calcular una raíz por celda (esto se llama mucho).
      return dx * dx + dy * dy <= r * r;
    }
    case "rect": {
      const hw = (shape.widthM ?? 0) / 2;
      const hh = (shape.heightM ?? 0) / 2;
      const rot = shape.rotation ?? 0;
      // Llevo el punto al marco local del rect deshaciendo la rotación (giro -rot).
      const dx = p.x - c.x;
      const dy = p.y - c.y;
      if (rot === 0) return Math.abs(dx) <= hw && Math.abs(dy) <= hh;
      const cos = Math.cos(-rot);
      const sin = Math.sin(-rot);
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
    }
    case "polygon":
      return pointInPolygon(p, shape.points ?? []);
    default:
      return false;
  }
}

/** Ray casting clásico (par/impar). Suficiente para polígonos simples del editor. */
export function pointInPolygon(p: Vec2, pts: Vec2[]): boolean {
  if (pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    const intersects = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Caja delimitadora axis-aligned {minX,minY,maxX,maxY} de una forma (para acotar barridos). */
export function aabb(shape: Shape): { minX: number; minY: number; maxX: number; maxY: number } {
  const c = shape.position ?? { x: 0, y: 0 };
  if (shape.shape === "circle") {
    const r = shape.radiusM ?? 0;
    return { minX: c.x - r, minY: c.y - r, maxX: c.x + r, maxY: c.y + r };
  }
  if (shape.shape === "rect") {
    const hw = (shape.widthM ?? 0) / 2;
    const hh = (shape.heightM ?? 0) / 2;
    const rot = shape.rotation ?? 0;
    if (rot === 0) return { minX: c.x - hw, minY: c.y - hh, maxX: c.x + hw, maxY: c.y + hh };
    // Rectángulo girado: la caja crece con |cos|+|sin|.
    const cos = Math.abs(Math.cos(rot));
    const sin = Math.abs(Math.sin(rot));
    const ex = hw * cos + hh * sin;
    const ey = hw * sin + hh * cos;
    return { minX: c.x - ex, minY: c.y - ey, maxX: c.x + ex, maxY: c.y + ey };
  }
  const pts = shape.points ?? [];
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** Centro representativo de una forma (para comprobaciones de límites y distancias). */
export function shapeCenter(shape: Shape): Vec2 {
  if (shape.position) return shape.position;
  const box = aabb(shape);
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
}
