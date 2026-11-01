/**
 * UX-EDITOR · Lienzo interactivo del editor de mapas (SVG).
 *
 * Toda la geometría es pura (objects.ts, shared/view-transform.ts); aquí sólo se
 * cablea el puntero:
 *  - clic con una herramienta de la paleta activa → crea el objeto en ese punto;
 *  - clic sobre un objeto → lo selecciona; arrastrar → lo mueve (con rejilla o con
 *    guías de alineación);
 *  - arrastrar un tirador del seleccionado → redimensiona;
 *  - arrastrar en vacío, botón central o un dedo en vacío → pan; rueda → zoom al
 *    cursor; dos dedos → pellizco (zoom + pan).
 * Los gestos continuos avisan al empezar/terminar para que el historial apile UNA
 * entrada por gesto. El acierto se hace por geometría (no por el elemento DOM), igual
 * con ratón que con dedo.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  clampCenter,
  fitView,
  panByPixels,
  pinchView,
  screenToWorld,
  wheelZoomFactor,
  zoomAt,
  type Pt,
  type Size,
  type View,
  type ZoomLimits,
} from "../shared/view-transform.js";
import type { EditorMap, ObjKind, ObjRef, Vec2 } from "./model.js";
import {
  alignToOthers,
  boundsOf,
  engineBaseRadius,
  FLAG_RADIUS_M,
  getObj,
  handlePosition,
  hitTest,
  layerOf,
  objLabel,
  RECT_HANDLES,
  replaceObj,
  resizable,
  resizeWithHandle,
  snapValue,
  SPAWN_RADIUS_M,
  translateObj,
  type AnyObj,
  type Guides,
  type Handle,
  type Tool,
  DRAW_ORDER,
} from "./objects.js";

export const TEAM_COLOR: Record<string, string> = { red: "#e5534b", blue: "#4c8dff" };
export const teamColor = (t: unknown) =>
  typeof t === "string" && Object.prototype.hasOwnProperty.call(TEAM_COLOR, t) ? TEAM_COLOR[t] : "#b8bdb5";

/** «100 %» = 10 píxeles por metro (la escala del formato de autoría antiguo). */
export const PX_PER_M_100 = 10;
export const MAX_ZOOM = 80;

export function zoomLimits(map: EditorMap, vp: Size): ZoomLimits {
  const fit = fitView({ w: map.widthM, h: map.heightM }, vp).zoom;
  return { minZoom: Math.min(fit * 0.5, 2), maxZoom: Math.max(MAX_ZOOM, fit) };
}

export interface GridOpts {
  show: boolean;
  snap: boolean;
  step: number;
}

interface Props {
  map: EditorMap;
  selected: ObjRef | null;
  tool: Tool | null;
  view: View | null;
  grid: GridOpts;
  flagged: Map<string, "error" | "warning">;
  onView(v: View): void;
  onViewport(vp: Size): void;
  onSelect(ref: ObjRef | null): void;
  onPlace(tool: Tool, p: Vec2): void;
  onGestureStart(): void;
  onGestureLive(next: EditorMap): void;
  onGestureEnd(): void;
  onCursor(p: Vec2 | null): void;
}

type Gesture =
  | { type: "pan"; last: Pt }
  | { type: "move"; ref: ObjRef; startMap: EditorMap; startWorld: Vec2; startPx: Pt; moved: boolean }
  | { type: "resize"; ref: ObjRef; handle: Handle; startMap: EditorMap }
  | { type: "pinch"; prev: [Pt, Pt] };

const DEFAULT_VP: Size = { w: 800, h: 500 };

function ShapeEl({ o, ...rest }: { o: AnyObj } & React.SVGProps<SVGElement>) {
  const c = o.position ?? { x: 0, y: 0 };
  if (o.shape === "circle") return <circle cx={c.x} cy={c.y} r={o.radiusM ?? 0} {...(rest as object)} />;
  if (o.shape === "polygon")
    return <polygon points={(o.points ?? []).map((p) => `${p.x},${p.y}`).join(" ")} {...(rest as object)} />;
  const w = o.widthM ?? 0;
  const h = o.heightM ?? 0;
  const deg = ((o.rotation ?? 0) * 180) / Math.PI;
  return (
    <rect
      x={c.x - w / 2}
      y={c.y - h / 2}
      width={w}
      height={h}
      transform={deg ? `rotate(${deg} ${c.x} ${c.y})` : undefined}
      {...(rest as object)}
    />
  );
}

export function EditorCanvas(props: Props) {
  const { map, selected, tool, grid, flagged } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [vp, setVp] = useState<Size>(DEFAULT_VP);
  const [guides, setGuides] = useState<Guides>({ x: [], y: [] });
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, Pt>());
  const view = props.view ?? fitView({ w: map.widthM, h: map.heightM }, vp);
  // Últimos valores para los manejadores nativos (rueda) y los gestos.
  const latest = useRef({ props, view, vp });
  latest.current = { props, view, vp };

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const next = { w: Math.round(r.width), h: Math.round(r.height) };
        setVp((p) => (p.w === next.w && p.h === next.h ? p : next));
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => props.onViewport(vp), [vp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rueda: listener NATIVO no pasivo para poder impedir el scroll de la página.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { props: p, view: v, vp: size } = latest.current;
      const r = svg.getBoundingClientRect();
      const pt = { x: e.clientX - r.left, y: e.clientY - r.top };
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      const next = zoomAt(v, wheelZoomFactor(dy), pt, size, zoomLimits(p.map, size));
      p.onView(clampCenter(next, { w: p.map.widthM, h: p.map.heightM }));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const local = (e: React.PointerEvent): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toWorld = (pt: Pt) => screenToWorld(pt, latest.current.view, latest.current.vp);
  const snapPt = (p: Vec2): Vec2 => (grid.snap ? { x: snapValue(p.x, grid.step), y: snapValue(p.y, grid.step) } : p);
  const handleTolPx = (e: React.PointerEvent) => (e.pointerType === "touch" ? 18 : 10);

  function endGesture() {
    const g = gesture.current;
    if ((g?.type === "move" && g.moved) || g?.type === "resize") props.onGestureEnd();
    gesture.current = null;
    setGuides({ x: [], y: [] });
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && typeof active.blur === "function") active.blur();
    const pt = local(e);
    pointers.current.set(e.pointerId, pt);
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom / puntero ya liberado */
    }
    if (pointers.current.size >= 2) {
      endGesture();
      const [a, b] = [...pointers.current.values()];
      gesture.current = { type: "pinch", prev: [a, b] };
      return;
    }
    if (e.button === 1) {
      gesture.current = { type: "pan", last: pt };
      return;
    }
    const v = latest.current.view;
    const world = toWorld(pt);
    // 1) Tirador del seleccionado.
    const selObj = getObj(map, selected);
    const rz = selected ? resizable(selected.kind, selObj) : null;
    if (selected && selObj && rz) {
      const hs: Handle[] = rz === "rect" ? RECT_HANDLES : ["n", "e", "s", "w"];
      const tol = handleTolPx(e);
      for (const h of hs) {
        const hp = handlePosition(selected.kind, selObj, h);
        const sx = (hp.x - v.centerX) * v.zoom + latest.current.vp.w / 2;
        const sy = (hp.y - v.centerY) * v.zoom + latest.current.vp.h / 2;
        if (Math.abs(sx - pt.x) <= tol && Math.abs(sy - pt.y) <= tol) {
          gesture.current = { type: "resize", ref: selected, handle: h, startMap: map };
          props.onGestureStart();
          return;
        }
      }
    }
    // 2) Paleta: colocar.
    if (tool) {
      props.onPlace(tool, snapPt(world));
      return;
    }
    // 3) Objeto: seleccionar y preparar el arrastre.
    const hit = hitTest(map, world, (e.pointerType === "touch" ? 10 : 4) / v.zoom);
    if (hit) {
      props.onSelect(hit);
      gesture.current = { type: "move", ref: hit, startMap: map, startWorld: world, startPx: pt, moved: false };
      return;
    }
    // 4) Vacío: deseleccionar y pan.
    props.onSelect(null);
    gesture.current = { type: "pan", last: pt };
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const pt = local(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, pt);
    const world = toWorld(pt);
    props.onCursor(world);
    const g = gesture.current;
    if (!g) return;
    const { view: v, vp: size } = latest.current;
    const worldSize = { w: map.widthM, h: map.heightM };
    if (g.type === "pinch") {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      props.onView(clampCenter(pinchView(v, g.prev, [a, b], size, zoomLimits(map, size)), worldSize));
      g.prev = [a, b];
      return;
    }
    if (g.type === "pan") {
      props.onView(clampCenter(panByPixels(v, pt.x - g.last.x, pt.y - g.last.y), worldSize));
      g.last = pt;
      return;
    }
    if (g.type === "move") {
      if (!g.moved) {
        if (Math.hypot(pt.x - g.startPx.x, pt.y - g.startPx.y) < 3) return;
        g.moved = true;
        props.onGestureStart();
      }
      const o0 = getObj(g.startMap, g.ref);
      if (!o0) return;
      let dx = world.x - g.startWorld.x;
      let dy = world.y - g.startWorld.y;
      const c0 = boundsOf(g.ref.kind, o0);
      const cx0 = (c0.minX + c0.maxX) / 2;
      const cy0 = (c0.minY + c0.maxY) / 2;
      let gd: Guides = { x: [], y: [] };
      if (grid.snap) {
        dx = snapValue(cx0 + dx, grid.step) - cx0;
        dy = snapValue(cy0 + dy, grid.step) - cy0;
      } else {
        const moved = boundsOf(g.ref.kind, translateObj(o0, dx, dy));
        const al = alignToOthers(g.startMap, g.ref, moved, 6 / v.zoom);
        dx += al.dx;
        dy += al.dy;
        gd = al.guides;
      }
      setGuides(gd);
      props.onGestureLive(replaceObj(g.startMap, g.ref, translateObj(o0, dx, dy)));
      return;
    }
    if (g.type === "resize") {
      const o0 = getObj(g.startMap, g.ref);
      if (!o0) return;
      props.onGestureLive(
        replaceObj(g.startMap, g.ref, resizeWithHandle(o0, g.handle, world, grid.snap ? grid.step : 0)),
      );
    }
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.type === "pinch") {
      if (pointers.current.size < 2) gesture.current = null;
      return;
    }
    endGesture();
  }

  const z = view.zoom;
  const px = 1 / z;
  const tx = vp.w / 2 - view.centerX * z;
  const ty = vp.h / 2 - view.centerY * z;
  const W = map.widthM;
  const H = map.heightM;

  // Rejilla: sólo si las líneas quedan al menos a 5 px (si no, sería ruido).
  let gridPath = "";
  let gridMajor = "";
  if (grid.show && grid.step > 0 && grid.step * z >= 5 && W / grid.step < 4000 && H / grid.step < 4000) {
    const minor: string[] = [];
    const major: string[] = [];
    for (let i = 0, x = 0; x <= W + 1e-9; i++, x = i * grid.step) (i % 5 === 0 ? major : minor).push(`M${x} 0V${H}`);
    for (let i = 0, y = 0; y <= H + 1e-9; i++, y = i * grid.step) (i % 5 === 0 ? major : minor).push(`M0 ${y}H${W}`);
    gridPath = minor.join("");
    gridMajor = major.join("");
  }

  const selObj = getObj(map, selected);
  const selBox = selected && selObj ? boundsOf(selected.kind, selObj) : null;
  const selResize = selected ? resizable(selected.kind, selObj) : null;
  const handleSize = 10 * px;
  const flagStroke = (k: ObjKind, i: number) => {
    const f = flagged.get(`${k}:${i}`);
    return f === "error" ? "#ff4d4f" : f === "warning" ? "#f5a623" : null;
  };

  const renderObj = (kind: ObjKind, o: AnyObj, index: number) => {
    const isSel = selected?.kind === kind && selected.index === index;
    const warn = flagStroke(kind, index);
    const common = {
      "data-testid": "editor-obj",
      "data-kind": kind,
      "data-index": index,
      "data-selected": isSel ? "true" : "false",
      "data-issue": flagged.get(`${kind}:${index}`) ?? "none",
    };
    const outline = warn ? (
      <ShapeEl o={o} fill="none" stroke={warn} strokeWidth={3 * px} strokeDasharray={`${4 * px} ${3 * px}`} />
    ) : null;
    const label = objLabel(map, { kind, index });
    if (kind === "wall")
      return (
        <g key={`w${index}`} {...common}>
          <ShapeEl o={o} fill="#3a4440" stroke="#66736e" strokeWidth={1 * px} />
          {outline}
        </g>
      );
    if (kind === "destructible")
      return (
        <g key={`d${index}`} {...common}>
          <ShapeEl o={o} fill="#6a5a30" stroke="#b09858" strokeWidth={1 * px} strokeDasharray={`${3 * px} ${2 * px}`} />
          {outline}
        </g>
      );
    if (kind === "zone") {
      const dmg = o.zoneType === "damage";
      const cap = o.zoneType === "capture";
      return (
        <g key={`z${index}`} {...common}>
          <ShapeEl
            o={o}
            fill={dmg ? "rgba(229,83,75,0.25)" : cap ? "rgba(241,196,15,0.18)" : "rgba(160,160,160,0.15)"}
            stroke={dmg ? "#e5534b" : cap ? "#f1c40f" : "#9aa"}
            strokeWidth={1.5 * px}
            strokeDasharray={cap ? `${6 * px} ${4 * px}` : undefined}
          />
          {outline}
        </g>
      );
    }
    if (kind === "base") {
      const c = o.position ?? { x: 0, y: 0 };
      const col = teamColor(o.team);
      return (
        <g key={`b${index}`} {...common}>
          {/* Lo dibujado (rectángulo) y lo que JUEGA el motor (círculo inscrito). */}
          <ShapeEl
            o={o}
            fill="none"
            stroke={col}
            strokeOpacity={0.45}
            strokeWidth={1 * px}
            strokeDasharray={`${3 * px} ${3 * px}`}
          />
          <circle
            cx={c.x}
            cy={c.y}
            r={engineBaseRadius(o)}
            fill={col}
            fillOpacity={0.18}
            stroke={col}
            strokeWidth={2 * px}
            data-testid="editor-base-effective"
          />
          {outline}
        </g>
      );
    }
    if (kind === "flag") {
      const c = o.position ?? { x: 0, y: 0 };
      const col = teamColor(o.team);
      const r = FLAG_RADIUS_M;
      return (
        <g key={`f${index}`} {...common}>
          <circle
            cx={c.x}
            cy={c.y}
            r={r}
            fill="#10141a"
            stroke={col}
            strokeWidth={2 * px}
            role="img"
            aria-label={label}
          />
          <path
            d={`M${c.x - r * 0.3} ${c.y + r * 0.6}V${c.y - r * 0.7}L${c.x + r * 0.7} ${c.y - r * 0.35}L${c.x - r * 0.3} ${c.y}`}
            fill={col}
            stroke="none"
          />
          {outline}
        </g>
      );
    }
    // spawn
    const c = o.position ?? { x: 0, y: 0 };
    const col = teamColor(o.team);
    const hd = typeof o.heading === "number" ? o.heading : 0;
    const r = SPAWN_RADIUS_M;
    return (
      <g key={`s${index}`} {...common}>
        <circle
          cx={c.x}
          cy={c.y}
          r={r}
          fill={col}
          stroke="#f2f5f0"
          strokeWidth={1.5 * px}
          role="img"
          aria-label={label}
        />
        <line
          x1={c.x}
          y1={c.y}
          x2={c.x + Math.cos(hd) * r * 1.9}
          y2={c.y + Math.sin(hd) * r * 1.9}
          stroke="#f2f5f0"
          strokeWidth={2 * px}
          strokeLinecap="round"
        />
        {outline}
      </g>
    );
  };

  return (
    <div
      ref={hostRef}
      className="s9-me-stage"
      data-testid="editor-stage"
      data-zoom={z.toFixed(4)}
      data-center={`${view.centerX.toFixed(3)},${view.centerY.toFixed(3)}`}
    >
      <svg
        ref={svgRef}
        role="application"
        aria-label={`Lienzo del mapa ${map.meta.name ?? map.mapId}`}
        aria-roledescription="lienzo del editor"
        data-testid="editor-canvas"
        width={vp.w}
        height={vp.h}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          display: "block",
          touchAction: "none",
          userSelect: "none",
          cursor: tool ? "crosshair" : "default",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => props.onCursor(null)}
        onAuxClick={(e) => e.preventDefault()}
      >
        <g transform={`translate(${tx} ${ty}) scale(${z})`}>
          <rect x={0} y={0} width={W} height={H} fill="#18201a" data-testid="editor-map-bounds" />
          {gridPath && <path d={gridPath} stroke="#ffffff" strokeOpacity={0.06} strokeWidth={px} fill="none" />}
          {gridMajor && <path d={gridMajor} stroke="#ffffff" strokeOpacity={0.13} strokeWidth={px} fill="none" />}
          {DRAW_ORDER.flatMap((kind) => layerOf(map, kind).map((o, i) => renderObj(kind, o, i)))}
          <rect
            x={0}
            y={0}
            width={W}
            height={H}
            fill="none"
            stroke="#7fb4ff"
            strokeOpacity={0.55}
            strokeWidth={2 * px}
          />
          {guides.x.map((x, i) => (
            <line
              key={`gx${i}`}
              x1={x}
              y1={-H}
              x2={x}
              y2={2 * H}
              stroke="#ff5ad1"
              strokeWidth={px}
              data-testid="editor-guide"
            />
          ))}
          {guides.y.map((y, i) => (
            <line
              key={`gy${i}`}
              x1={-W}
              y1={y}
              x2={2 * W}
              y2={y}
              stroke="#ff5ad1"
              strokeWidth={px}
              data-testid="editor-guide"
            />
          ))}
          {selBox && (
            <rect
              data-testid="editor-selection"
              x={selBox.minX}
              y={selBox.minY}
              width={selBox.maxX - selBox.minX}
              height={selBox.maxY - selBox.minY}
              fill="none"
              stroke="#7fb4ff"
              strokeWidth={1.5 * px}
              strokeDasharray={`${5 * px} ${3 * px}`}
              pointerEvents="none"
            />
          )}
          {selected &&
            selObj &&
            selResize &&
            (selResize === "rect" ? RECT_HANDLES : (["n", "e", "s", "w"] as Handle[])).map((h) => {
              const hp = handlePosition(selected.kind, selObj, h);
              return (
                <rect
                  key={h}
                  data-testid={`editor-handle-${h}`}
                  x={hp.x - handleSize / 2}
                  y={hp.y - handleSize / 2}
                  width={handleSize}
                  height={handleSize}
                  fill="#10141a"
                  stroke="#7fb4ff"
                  strokeWidth={1.5 * px}
                />
              );
            })}
        </g>
      </svg>
    </div>
  );
}
