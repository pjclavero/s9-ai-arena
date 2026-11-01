/**
 * UX-VIEW · Minimapa como PANEL propio, FUERA del área del escenario.
 *
 * Un <canvas> 2D (no una segunda cámara de Phaser) que se repinta a ~8 Hz con el
 * estado de la escena (minimapState): límites, muros y destructibles, los
 * vehículos (radio mínimo garantizado, forma por bando, KO hueco), el rectángulo
 * de la cámara principal y la selección. Pulsar o arrastrar en él centra la
 * cámara en ese punto. Se puede ocultar y cambiar de tamaño.
 *
 * Expone en `data-*` lo que mide el E2E: puntos dibujados, vehículos dentro de la
 * vista de la cámara y el rectángulo de vista.
 */
import { useEffect, useRef, useState } from "react";
import type { MinimapState } from "./PhaserViewer.js";
import {
  computeMinimapLayout,
  minimapBoxHeight,
  minimapDots,
  minimapToWorld,
  minimapViewRect,
  minimapWidthFor,
  type MinimapSize,
} from "./minimap.js";
import { markerOutline, markerShape } from "./vehicle-tags.js";
import { S9_ENV, sortTeams } from "./art-direction.js";

const REDRAW_MS = 125;

function hex(n: number): string {
  return `#${(n >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
}

export interface MinimapPanelProps {
  /** Estado de la escena; null mientras no existe. */
  getState: () => MinimapState | null;
  onCenter(x: number, y: number): void;
  /** Abierto al empezar (escritorio sí; móvil, plegado). */
  defaultOpen?: boolean;
}

export function MinimapPanel({ getState, onCenter, defaultOpen = true }: MinimapPanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [size, setSize] = useState<MinimapSize>("m");
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const getRef = useRef(getState);
  getRef.current = getState;
  const centerRef = useRef(onCenter);
  centerRef.current = onCenter;

  useEffect(() => {
    if (!open) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const draw = () => {
      const canvas = canvasRef.current;
      const wrap = wrapRef.current;
      const st = getRef.current();
      if (!canvas || !wrap || !st || !st.world || !(st.world.widthM > 0)) return;
      const cssW = minimapWidthFor(size, wrap.clientWidth || 240);
      const cssH = minimapBoxHeight(st.world, cssW);
      const dpr = Math.max(1, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
      }
      const l = computeMinimapLayout(st.world, cssW, cssH);
      const dots = minimapDots(st.vehicles, l, st.selectedId);
      const rect = st.camera ? minimapViewRect(l, st.camera) : null;
      let inView = 0;
      if (st.camera) {
        const halfW = st.camera.viewportW / (2 * st.camera.zoom);
        const halfH = st.camera.viewportH / (2 * st.camera.zoom);
        for (const v of st.vehicles) {
          if (Math.abs(v.x - st.camera.centerX) <= halfW && Math.abs(v.y - st.camera.centerY) <= halfH) inView++;
        }
      }
      canvas.dataset.dots = String(dots.length);
      canvas.dataset.inView = String(inView);
      canvas.dataset.view = rect ? [rect.x, rect.y, rect.w, rect.h].map((n) => n.toFixed(1)).join(",") : "";
      canvas.dataset.mapPx = [l.offsetX, l.offsetY, l.mapW, l.mapH].map((n) => n.toFixed(1)).join(",");

      const ctx = canvas.getContext?.("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.fillStyle = S9_ENV.background;
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.fillStyle = hex(S9_ENV.ground);
      ctx.fillRect(l.offsetX, l.offsetY, l.mapW, l.mapH);
      const box = (
        arr: { position: { x: number; y: number }; halfW: number; halfH: number }[] | undefined,
        c: number,
      ) => {
        ctx.fillStyle = hex(c);
        for (const o of arr ?? []) {
          ctx.fillRect(
            l.offsetX + (o.position.x - o.halfW) * l.scale,
            l.offsetY + (o.position.y - o.halfH) * l.scale,
            Math.max(1, o.halfW * 2 * l.scale),
            Math.max(1, o.halfH * 2 * l.scale),
          );
        }
      };
      box(st.world.walls, S9_ENV.wall);
      box(st.world.destructibles, S9_ENV.destructible);
      // Límites del mapa.
      ctx.strokeStyle = "#7f8a85";
      ctx.lineWidth = 1;
      ctx.strokeRect(l.offsetX + 0.5, l.offsetY + 0.5, l.mapW - 1, l.mapH - 1);
      // Rectángulo de la cámara principal.
      if (rect) {
        ctx.fillStyle = "rgba(255,224,102,0.10)";
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.strokeStyle = hex(S9_ENV.tracer);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rect.x + 0.75, rect.y + 0.75, Math.max(0, rect.w - 1.5), Math.max(0, rect.h - 1.5));
      }
      // Vehículos: forma por bando (no sólo color), KO hueco con aspa, seleccionado con anillo.
      const teams = sortTeams(st.vehicles.map((v) => v.team).filter((t): t is string => !!t));
      for (const d of dots) {
        const color = hex(st.colorOf(d.team));
        const shape = markerShape("none", d.team ? teams.indexOf(d.team) : -1);
        const pts = markerOutline(shape, d.r + 0.5);
        ctx.beginPath();
        if (pts.length === 0) ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        else {
          ctx.moveTo(d.x + pts[0].x, d.y + pts[0].y);
          for (const q of pts.slice(1)) ctx.lineTo(d.x + q.x, d.y + q.y);
          ctx.closePath();
        }
        if (d.alive) {
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = "#0b0f0b";
          ctx.lineWidth = 1;
          ctx.stroke();
        } else {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(d.x - d.r, d.y - d.r);
          ctx.lineTo(d.x + d.r, d.y + d.r);
          ctx.moveTo(d.x - d.r, d.y + d.r);
          ctx.lineTo(d.x + d.r, d.y - d.r);
          ctx.stroke();
        }
        if (d.selected) {
          ctx.beginPath();
          ctx.arc(d.x, d.y, d.r + 3, 0, Math.PI * 2);
          ctx.strokeStyle = "#f2f5f0";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    };
    draw();
    timer = setInterval(draw, REDRAW_MS);
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [open, size]);

  // Pulsar/arrastrar en el minimapa centra la cámara principal en ese punto.
  const dragging = useRef(false);
  const centerAt = (ev: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const st = getRef.current();
    if (!canvas || !st) return;
    const r = canvas.getBoundingClientRect();
    const l = computeMinimapLayout(st.world, r.width, r.height);
    const w = minimapToWorld(l, st.world, ev.clientX - r.left, ev.clientY - r.top);
    centerRef.current(w.x, w.y);
  };

  return (
    <section className="s9v-card" data-testid="minimap" data-state={open ? "open" : "closed"} aria-label="Minimapa">
      <div style={{ display: "flex", flexWrap: "wrap", gap: ".35rem", alignItems: "center" }}>
        <h3 style={{ margin: 0, flex: "1 1 auto" }}>Minimapa</h3>
        {open && (
          <span role="group" aria-label="Tamaño del minimapa" style={{ display: "inline-flex", gap: ".2rem" }}>
            {(["s", "m", "l"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={size === s}
                aria-label={`Minimapa ${s === "s" ? "pequeño" : s === "m" ? "mediano" : "grande"}`}
                onClick={() => setSize(s)}
              >
                {s.toUpperCase()}
              </button>
            ))}
          </span>
        )}
        <button type="button" aria-expanded={open} data-testid="minimap-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? "Ocultar minimapa" : "Mostrar minimapa"}
        </button>
      </div>
      {open && (
        <div ref={wrapRef} style={{ marginTop: ".4rem", minWidth: 0 }}>
          <canvas
            ref={canvasRef}
            data-testid="minimap-canvas"
            aria-label="Minimapa: pulsa para centrar la cámara en ese punto"
            role="img"
            style={{ display: "block", maxWidth: "100%", touchAction: "none", cursor: "crosshair", borderRadius: 4 }}
            onPointerDown={(e) => {
              dragging.current = true;
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* sin captura: se sigue igual */
              }
              centerAt(e);
            }}
            onPointerMove={(e) => {
              if (dragging.current) centerAt(e);
            }}
            onPointerUp={() => {
              dragging.current = false;
            }}
            onPointerCancel={() => {
              dragging.current = false;
            }}
          />
        </div>
      )}
    </section>
  );
}
