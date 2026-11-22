/**
 * V1 REPLAYS · PR-1 · el gateway del directo lee la ventana acotada del motor
 * (`frames`/`events` con índices absolutos) y se resincroniza si se queda por detrás.
 * Mutante G1/G2 en apps/arena-engine/scripts/replay-sink-mutants.mjs.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SpectateGateway, type SpectatableBattle } from "./gateway.js";
import { WindowLog } from "../../../arena-engine/src/sim/replay-sink.js";

beforeAll(() => {
  process.env.ARENA_DEV_INSECURE_SECRETS ??= "1";
});
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function windowed(frameCap: number, eventCap: number) {
  const frames = new WindowLog<any>(frameCap);
  const events = new WindowLog<any>(eventCap);
  const battle: SpectatableBattle = { frames, events, isFinished: () => false, getResult: () => null };
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

  it("G2 un bombeo que se queda por detrás de la ventana se resincroniza y cuenta lo perdido (frames y eventos)", async () => {
    const gw = new SpectateGateway({ publicSpectateEnabled: true });
    cleanups.push(() => gw.close());
    const { battle, frames, events } = windowed(5, 3);
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
