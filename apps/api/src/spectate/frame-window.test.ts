/**
 * V1 REPLAYS · PR-1 · el gateway del directo lee la ventana acotada del motor
 * (`frames`/`events` con índices absolutos) y se resincroniza si se queda por detrás.
 * Mutante G1/G2 en apps/arena-engine/scripts/replay-sink-mutants.mjs.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SpectateGateway, type SpectatableBattle } from "./gateway.js";
import { AudienceProjector, audienceKey } from "../../../../packages/projection/index.js";
import { WindowLog } from "../../../arena-engine/src/sim/replay-sink.js";

beforeAll(() => {
  process.env.ARENA_DEV_INSECURE_SECRETS ??= "1";
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `plain`: vistas sin `onEvict` (otro tipo de log): ejercita la ruta de resincronización del bombeo. */
function windowed(frameCap: number, eventCap: number, plain = false) {
  const frames = new WindowLog<any>(frameCap);
  const events = new WindowLog<any>(eventCap);
  const view = (w: WindowLog<any>) => ({
    get length() {
      return w.length;
    },
    get base() {
      return w.base;
    },
    get: (i: number) => w.get(i),
  });
  const battle: SpectatableBattle = {
    frames: plain ? view(frames) : frames,
    events: plain ? view(events) : events,
    isFinished: () => false,
    getResult: () => null,
  };
  return { battle, frames, events };
}
const frame = (tick: number) => ({ tick, vehicles: [], projectiles: [], score: {}, objectives: [] });

describe("G1 gateway con ventana de frames", () => {
  it("G1 se adjunta a una ventana que ya no empieza en 0, sin romper, y entrega el resto en orden", async () => {
    const gw = new SpectateGateway({ publicSpectateEnabled: true });
    cleanups.push(() => gw.close());
    const { battle, frames } = windowed(4, 4);
    for (let t = 0; t < 10; t++) frames.push(frame(t));
    expect(frames.base).toBe(6);
    gw.attachBattle("b-win", battle, { pollIntervalMs: 5 });
    const feed = (gw as any).feeds.get("b-win");
    expect(feed.sentSnapshots).toBe(10);
    for (let t = 10; t < 13; t++) frames.push(frame(t));
    await sleep(80);
    expect(feed.sentSnapshots).toBe(13);
    expect(feed.droppedFrames).toBe(0);
  });

  it("G2 (log sin onEvict) un bombeo que se queda por detrás de la ventana se resincroniza y cuenta lo perdido (frames y eventos)", async () => {
    const gw = new SpectateGateway({ publicSpectateEnabled: true });
    cleanups.push(() => gw.close());
    const { battle, frames, events } = windowed(5, 3, true);
    gw.attachBattle("b-lag", battle, { pollIntervalMs: 200 });
    const feed = (gw as any).feeds.get("b-lag");
    // el motor produce 20 frames y 8 eventos antes del siguiente sondeo
    for (let t = 0; t < 20; t++) frames.push(frame(t));
    for (let e = 0; e < 8; e++) events.push({ tick: e, kind: "spawn" });
    await sleep(450);
    expect(feed.droppedFrames).toBe(15);
    expect(feed.droppedEvents).toBe(5);
    expect(feed.sentSnapshots).toBe(20);
    expect(feed.sentEvents).toBe(8);
  });
});

const pframe = (tick: number): any => ({
  tick,
  vehicles: [],
  projectiles: [{ id: `proj_${tick}`, position: { x: tick, y: 1 }, heading: 0 }],
  score: {},
  objectives: [],
});

describe("G3 saltar frames no altera la numeración pública ni el estado del proyector", () => {
  it("G3 con la ventana desbordada, las ids públicas de todos los proyectiles coinciden con una pasada completa", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const gw = new SpectateGateway({ publicSpectateEnabled: true });
      cleanups.push(() => gw.close());
      const { battle, frames } = windowed(5, 5);
      gw.attachBattle("b-num", battle, { pollIntervalMs: 200 });
      const feed = (gw as any).feeds.get("b-num");
      const TOTAL = 40;
      // el bombeo no corre hasta pasados 200 ms: el motor da 40 vueltas a una ventana de 5
      for (let t = 0; t < TOTAL; t++) frames.push(pframe(t));
      await sleep(450);

      const reference = new AudienceProjector({ battleId: "b-num", audience: audienceKey("public_live"), roster: [] });
      for (let t = 0; t < TOTAL; t++) reference.project(pframe(t));

      for (const view of ["public_live", "broadcast", "staff"] as const) {
        const got = feed.audiences.get(view).projector;
        const ref =
          view === "public_live"
            ? reference
            : new AudienceProjector({ battleId: "b-num", audience: audienceKey(view), roster: [] });
        if (view !== "public_live") for (let t = 0; t < TOTAL; t++) ref.project(pframe(t));
        for (let t = 0; t < TOTAL; t++) {
          expect(got.ids.toPublic(`proj_${t}`), `${view} proj_${t}`).toBe(ref.ids.toPublic(`proj_${t}`));
        }
      }
      expect(feed.droppedFrames).toBe(TOTAL - 5);
      expect(feed.sentSnapshots).toBe(TOTAL);
      // métrica y log
      expect(gw.dropStats().droppedFrames).toBe(TOTAL - 5);
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain("spectate_dropped");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("G4 re-attach del mismo battleId", () => {
  it("G4 el feed anterior se da de baja: los descartes no se cuentan dos veces", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const gw = new SpectateGateway({ publicSpectateEnabled: true });
      cleanups.push(() => gw.close());
      const { battle, frames } = windowed(5, 5);
      gw.attachBattle("b-re", battle, { pollIntervalMs: 200 });
      gw.attachBattle("b-re", battle, { pollIntervalMs: 200 });
      for (let t = 0; t < 20; t++) frames.push(pframe(t));
      await sleep(450);
      expect(gw.dropStats().droppedFrames).toBe(15);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("G5 re-attach cierra los clientes del feed anterior", () => {
  it("G5 los clientes del feed anterior reciben el cierre 1001 battle_detached y el bombeo anterior se detiene", async () => {
    const gw = new SpectateGateway({ publicSpectateEnabled: true });
    cleanups.push(() => gw.close());
    const { battle } = windowed(5, 5);
    gw.attachBattle("b-cl", battle, { pollIntervalMs: 200 });
    const old = (gw as any).feeds.get("b-cl");
    const close = vi.fn();
    const conn = { timers: new Set(), heartbeat: null, ws: { readyState: 1, close } };
    old.audiences.get("public_live").clients.add(conn);
    gw.attachBattle("b-cl", battle, { pollIntervalMs: 200 });
    expect(close).toHaveBeenCalledWith(1001, "battle_detached");
    expect(old.audiences.get("public_live").clients.size).toBe(0);
    expect((gw as any).feeds.get("b-cl")).not.toBe(old);
  });
});
