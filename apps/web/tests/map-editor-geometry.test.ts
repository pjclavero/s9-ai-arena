/**
 * UX-EDITOR · Lógica pura del editor: geometría de objetos (acierto, mover,
 * redimensionar, duplicar, crear, guías), historial deshacer/rehacer y validación
 * en vivo. Incluye OLD_MAP_REGRESSION a nivel de datos: los mapas reales del repo
 * (mvp-arena-01/02, procedurales y el formato antiguo en px) se abren sin falsos
 * problemas y mover+deshacer los deja byte a byte como estaban.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { newMap, parseImport, toDocument, type EditorMap } from "../src/map-editor/model.js";
import {
  alignToOthers,
  allRefs,
  boundsOf,
  createAt,
  duplicateObj,
  engineBaseRadius,
  freshId,
  getObj,
  hitTest,
  objLabel,
  removeObj,
  replaceObj,
  resizable,
  resizeWithHandle,
  translateObj,
  MIN_SIZE_M,
} from "../src/map-editor/objects.js";
import { canRedo, canUndo, commit, commitFrom, createHistory, live, redo, undo } from "../src/map-editor/history.js";
import { fullValidation, issuesByObject, liveIssues } from "../src/map-editor/validation.js";
import { validateMap } from "../../map-service/src/validate/index.js";
import { toEngineMap } from "../../map-service/src/to-engine-map.js";

const REPO = join(__dirname, "..", "..", "..");
const load = (rel: string) => parseImport(readFileSync(join(REPO, "maps", rel), "utf8"));

function realMaps(): [string, EditorMap][] {
  const mvp = load("mvp-arena-01.json");
  // mvp-arena-02 = misma geometría con sus modos reales (apps/api/src/db/seeds/dev.ts).
  const mvp02: EditorMap = {
    ...mvp,
    mapId: "mvp-arena-02",
    meta: { ...mvp.meta, name: "Arena MVP 02", supportedModes: ["deathmatch", "team_deathmatch", "capture_the_flag"] },
  };
  const procs = readdirSync(join(REPO, "maps", "procedural")).map(
    (f) => [`procedural/${f}`, load(`procedural/${f}`)] as [string, EditorMap],
  );
  return [["mvp-arena-01", mvp], ["mvp-arena-02", mvp02], ["training-yard (px)", load("training-yard.json")], ...procs];
}

describe("geometría de objetos", () => {
  const base = () => {
    let m = newMap("geo", "Geo");
    m = createAt(m, "wall", { x: 30, y: 40 }).map; // 4×12 centrado en (30,40)
    m = createAt(m, "damage-zone", { x: 80, y: 40 }).map;
    return m;
  };

  it("crear desde la paleta: cada herramienta crea su tipo, con id válido y único", () => {
    let m = newMap("x", "x");
    for (const t of [
      "wall",
      "crate",
      "damage-zone",
      "capture-zone",
      "spawn-red",
      "spawn-blue",
      "base-red",
      "base-blue",
      "flag-red",
      "flag-blue",
    ] as const)
      m = createAt(m, t, { x: 50, y: 30 }).map;
    expect(m.layers.walls).toHaveLength(1);
    expect(m.layers.destructibles).toHaveLength(1);
    expect(m.layers.zones!.map((z) => z.zoneType)).toEqual(["damage", "capture"]);
    expect(m.layers.spawns.map((s) => s.team)).toEqual(["red", "blue", "red", "blue"]);
    expect(m.layers.bases!.map((b) => b.team)).toEqual(["red", "blue"]);
    expect(m.layers.flags!.map((f) => f.team)).toEqual(["red", "blue"]);
    const ids = allRefs(m)
      .map((r) => getObj(m, r)!.objectId)
      .filter(Boolean) as string[];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9_-]{1,32}$/);
    expect(m.layers.zones![0].damagePerSecond).toBe(8);
    expect(freshId(m, "spawn_red")).toBe("spawn_red_2");
  });

  it("acierto: gana el de encima; el vacío es null; la tolerancia agranda el blanco", () => {
    const m = base();
    expect(hitTest(m, { x: 30, y: 40 })).toEqual({ kind: "wall", index: 0 });
    expect(hitTest(m, { x: 80, y: 40 })).toEqual({ kind: "zone", index: 0 });
    expect(hitTest(m, { x: 10, y: 40 })).toEqual({ kind: "spawn", index: 0 });
    expect(hitTest(m, { x: 50, y: 70 })).toBeNull();
    expect(hitTest(m, { x: 32.5, y: 40 })).toBeNull();
    expect(hitTest(m, { x: 32.5, y: 40 }, 1)).toEqual({ kind: "wall", index: 0 });
  });

  it("mover traslada posición (y vértices de polígono) y conserva el giro importado", () => {
    const moved = translateObj(
      { shape: "rect", position: { x: 1, y: 2 }, widthM: 2, heightM: 2, rotation: 0.5 },
      3,
      -1,
    );
    expect(moved).toMatchObject({ position: { x: 4, y: 1 }, rotation: 0.5 });
    const poly = translateObj(
      {
        shape: "polygon",
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 0, y: 2 },
        ],
      },
      1,
      1,
    );
    expect(poly.points).toEqual([
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 1, y: 3 },
    ]);
    expect(resizable("wall", { shape: "rect", rotation: 0.5, widthM: 1, heightM: 1 })).toBeNull();
    expect(resizable("wall", { shape: "rect", widthM: 1, heightM: 1 })).toBe("rect");
    expect(resizable("zone", { shape: "circle", radiusM: 1 })).toBe("circle");
    expect(resizable("spawn", { position: { x: 0, y: 0 } })).toBeNull();
  });

  it("redimensionar: el borde opuesto queda fijo, con rejilla y con tamaño mínimo", () => {
    const wall = { shape: "rect" as const, position: { x: 30, y: 40 }, widthM: 4, heightM: 12 };
    const se = resizeWithHandle(wall, "se", { x: 40, y: 50 });
    expect(se).toMatchObject({ position: { x: 34, y: 42 }, widthM: 12, heightM: 16 }); // esquina NO fija en (28,34)
    const e = resizeWithHandle(wall, "e", { x: 35.3, y: 0 }, 1);
    expect(e).toMatchObject({ widthM: 7, heightM: 12, position: { x: 31.5, y: 40 } });
    const tiny = resizeWithHandle(wall, "w", { x: 999, y: 40 });
    expect(tiny.widthM).toBe(MIN_SIZE_M);
    const circ = resizeWithHandle({ shape: "circle", position: { x: 0, y: 0 }, radiusM: 6 }, "e", { x: 9, y: 4 });
    expect(circ.radiusM).toBe(9);
  });

  it("duplicar y borrar", () => {
    const m = base();
    const d = duplicateObj(m, { kind: "zone", index: 0 })!;
    expect(d.ref).toEqual({ kind: "zone", index: 1 });
    expect(d.map.layers.zones![1].position).toEqual({ x: 82, y: 42 });
    expect(d.map.layers.zones![1].objectId).not.toBe(d.map.layers.zones![0].objectId);
    const r = removeObj(d.map, { kind: "zone", index: 0 });
    expect(r.layers.zones).toHaveLength(1);
    expect(r.layers.zones![0].position).toEqual({ x: 82, y: 42 });
  });

  it("guías de alineación: un borde cercano se ajusta al de otro objeto", () => {
    const m = base();
    const ref = { kind: "spawn" as const, index: 0 };
    const al = alignToOthers(m, ref, { minX: 25, maxX: 29.8, minY: 10, maxY: 13 }, 0.5);
    expect(al.dx).toBeCloseTo(0.2, 9); // maxX 29.8 → 30 (centro del muro)
    expect(al.guides.x).toEqual([30]);
    expect(al.guides.y).toEqual([]);
  });

  it("la base se dibuja con el radio que JUEGA el motor (to-engine-map: círculo inscrito)", () => {
    const mvp = load("mvp-arena-01.json");
    const eng = toEngineMap({ ...mvp, checksum: "x" } as never);
    mvp.layers.bases!.forEach((b, i) => expect(engineBaseRadius(b as never)).toBe(eng.bases[i].radiusM));
  });

  it("nombres de usuario, sin ids internos", () => {
    const m = load("mvp-arena-01.json");
    const labels = allRefs(m).map((r) => objLabel(m, r));
    expect(labels).toContain("Base roja 1");
    expect(labels).toContain("Punto de aparición azul 2");
    expect(labels).toContain("Zona de daño 2");
    expect(labels.join(" ")).not.toMatch(/base_red|acid_pool|sp_/);
  });
});

describe("historial deshacer/rehacer", () => {
  it("commit/undo/redo y una rama nueva borra el futuro", () => {
    let h = createHistory(1);
    h = commit(h, 2);
    h = commit(h, 3);
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toBe(2);
    h = redo(h);
    expect(h.present).toBe(3);
    h = undo(undo(h));
    expect(h.present).toBe(1);
    expect(canUndo(h)).toBe(false);
    h = commit(h, 9);
    expect(canRedo(h)).toBe(false);
    expect(undo(h).present).toBe(1);
  });

  it("misma clave = una sola entrada (teclear en un campo); un gesto = una entrada", () => {
    let h = createHistory("a");
    h = commit(h, "ab", "w");
    h = commit(h, "abc", "w");
    h = commit(h, "abcd", "w");
    expect(h.past).toEqual(["a"]);
    const before = h.present;
    h = live(h, "x1");
    h = live(h, "x2");
    h = live(h, "x3");
    h = commitFrom(h, before);
    expect(h.past).toEqual(["a", "abcd"]);
    expect(undo(h).present).toBe("abcd");
    // Un gesto que no cambia nada no apila.
    expect(commitFrom(h, h.present)).toBe(h);
  });

  it("mover, crear, borrar, redimensionar y propiedades se deshacen sobre mapas reales", () => {
    const m0 = load("mvp-arena-01.json");
    let h = createHistory(m0);
    h = commit(h, createAt(h.present, "crate", { x: 20, y: 20 }).map);
    h = commit(
      h,
      replaceObj(h.present, { kind: "wall", index: 1 }, translateObj(h.present.layers.walls[1] as never, 5, 0)),
    );
    h = commit(h, removeObj(h.present, { kind: "zone", index: 0 }));
    h = commit(
      h,
      replaceObj(
        h.present,
        { kind: "wall", index: 0 },
        resizeWithHandle(h.present.layers.walls[0] as never, "n", { x: 0, y: 10 }),
      ),
    );
    h = commit(h, { ...h.present, layers: { ...h.present.layers, spawns: [] } });
    for (let i = 0; i < 5; i++) h = undo(h);
    expect(h.present).toBe(m0);
    expect(JSON.stringify(toDocument(h.present))).toBe(JSON.stringify(toDocument(m0)));
  });
});

describe("validación en vivo", () => {
  it("spawn fuera del mapa o dentro de un muro, objetos fuera, bases inválidas, zonas solapadas, spawns por modo", () => {
    let m = newMap("val", "Val");
    m = toggleModes(m, ["deathmatch", "team_deathmatch", "capture_the_flag", "zone_control"]);
    m = createAt(m, "wall", { x: 60, y: 40 }).map;
    m = createAt(m, "spawn-red", { x: 60, y: 40 }).map; // dentro del muro
    m = createAt(m, "spawn-blue", { x: 130, y: 40 }).map; // fuera
    m = createAt(m, "crate", { x: 300, y: 300 }).map; // totalmente fuera
    m = createAt(m, "base-red", { x: 2, y: 2 }).map; // sobresale
    m = { ...m, layers: { ...m.layers, bases: [...m.layers.bases!, { ...m.layers.bases![0], team: "Rojo!" }] } };
    m = createAt(m, "damage-zone", { x: 30, y: 60 }).map;
    m = createAt(m, "capture-zone", { x: 33, y: 60 }).map;
    const codes = liveIssues(m).map((i) => `${i.severity}:${i.code}`);
    expect(codes).toContain("error:spawn-in-wall");
    expect(codes).toContain("error:spawn-out");
    expect(codes).toContain("error:out-of-bounds");
    expect(codes).toContain("warning:overflows");
    expect(codes).toContain("error:base-team");
    expect(codes).toContain("warning:zone-overlap");
    expect(codes).toContain("error:mode-ctf");
    const flagged = issuesByObject(liveIssues(m));
    expect(flagged.get("spawn:2")).toBe("error");
    expect(flagged.get("wall:0")).toBe("error");

    const few = { ...newMap("pocos", "p"), layers: { ...newMap().layers, spawns: [newMap().layers.spawns[0]] } };
    const msgs = liveIssues(toggleModes(few, ["deathmatch", "team_deathmatch"])).map((i) => i.message);
    expect(msgs.join("\n")).toMatch(/Deathmatch necesita al menos 2 puntos de aparición \(hay 1\)/);
    expect(msgs.join("\n")).toMatch(/Deathmatch por equipos necesita puntos de aparición de los dos equipos/);
    expect(liveIssues({ ...newMap(), widthM: 0 }).map((i) => i.code)).toEqual(["map-size"]);
    expect(liveIssues(toggleModes(newMap(), ["zone_control"])).map((i) => i.code)).toContain("mode-zone");
  });

  it("textos para usuario: sin JSON, halfW/halfH ni ids internos", () => {
    let m = newMap("val", "Val");
    m = createAt(m, "base-red", { x: -50, y: 2 }).map;
    for (const i of liveIssues(m)) expect(i.message).not.toMatch(/halfW|halfH|objectId|base_red_1|\{|\[/);
  });

  it("el validador completo del navegador es EL del servidor (mismo resultado)", () => {
    const m = createAt(load("mvp-arena-01.json"), "spawn-red", { x: 60, y: 40 }).map;
    expect(fullValidation(m)).toEqual(validateMap(m as never).checks);
    expect(fullValidation(m).some((c) => c.severity === "error")).toBe(true);
  });

  it("OLD_MAP_REGRESSION: mapas reales sin falsos problemas; mover+deshacer los deja idénticos", () => {
    for (const [name, m] of realMaps()) {
      const errs = liveIssues(m).filter((i) => i.severity === "error");
      expect(errs, name).toEqual([]);
      expect(
        fullValidation(m).filter((c) => c.severity === "error"),
        name,
      ).toEqual([]);
      for (const r of allRefs(m)) expect(Number.isFinite(boundsOf(r.kind, getObj(m, r)!).minX), name).toBe(true);
      let h = createHistory(m);
      const ref = allRefs(m)[0];
      h = commit(h, replaceObj(h.present, ref, translateObj(getObj(h.present, ref)!, 3, 3)));
      expect(JSON.stringify(h.present)).not.toBe(JSON.stringify(m));
      h = undo(h);
      expect(JSON.stringify(toDocument(h.present)), name).toBe(JSON.stringify(toDocument(m)));
    }
  });
});

function toggleModes(m: EditorMap, modes: string[]): EditorMap {
  return { ...m, meta: { ...m.meta, supportedModes: modes } };
}
