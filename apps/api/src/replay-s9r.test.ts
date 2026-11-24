/**
 * V1 REPLAYS PR-4 · RD6 · La proyección pública EN STREAMING sobre la vista S9R/1 es idéntica a la
 * proyección del stream completo (`projectReplayStream`, la de PRE-1/MA): mismos frames, mismos
 * eventos y mismos ids públicos; y un segmento proyectado por streaming = el mismo segmento cortado
 * del documento entero. Sin BD (la nómina se pasa a mano).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../arena-engine/src/replay.js";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { audienceKey, projectReplayStream } from "../../../packages/projection/index.js";
import { writeS9rReplay } from "../../replay-service/src/testing/s9r-fixture.js";
import { ViewReader } from "../../replay-service/src/s9r/view.js";
import { projectSegment, projectViewStream, projectedReplayStream, type ViewerMeta } from "./replay-projection.js";
import { projectedSegment, rawSegment } from "./replay-s9r.js";

let replay: Replay;
let dir: string;
let viewPath: string;
const meta = (): ViewerMeta => ({
  world: {},
  roster: replay.header.participants.map((p: any) => ({ id: p.id, botId: p.botId, team: p.team })),
  mapEntityIds: [],
});

beforeAll(async () => {
  await initPhysics();
  replay = await record(
    {
      battleId: "rd6_battle",
      seed: "rd6_battle",
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 900 }),
      map: emptyArena(),
      participants: [
        { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
        { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_red", new HunterBot("bot_red"));
      b.attachBot("v_blue", new HunterBot("bot_blue"));
    },
  );
  dir = mkdtempSync(join(tmpdir(), "rd6-"));
  viewPath = (await writeS9rReplay(dir, replay, { viewFragmentBytes: 8 * 1024 })).viewPath;
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("RD6 · proyección pública en streaming = proyección del stream completo", () => {
  it("documento entero: mismos frames, eventos e ids públicos", async () => {
    const full = projectReplayStream({
      battleId: "b",
      audience: audienceKey("public_replay"),
      roster: meta().roster,
      mapEntityIds: [],
      snapshots: replay.snapshots,
      events: replay.events,
    });
    const view = await ViewReader.open(viewPath);
    const snaps: any[] = [];
    const evs: any[] = [];
    const done = await projectViewStream("b", meta(), view.records(), {
      onSnapshot: (s) => snaps.push(s),
      onEvent: (e) => evs.push(e),
    });
    await view.close();
    expect(snaps).toEqual(full.snapshots);
    expect(evs).toEqual(full.events);
    expect(done.mappingId).toBe(full.mappingId);
    expect(evs.length).toBeGreaterThan(0); // no vacuo: hay eventos públicos
  });

  for (const [from, to] of [
    [0, 90],
    [300, 450],
    [870, 900],
  ] as const) {
    it(`segmento ${from}-${to}: proyectado por streaming = cortado del documento entero`, async () => {
      const battle = { id: "b" };
      const view = await ViewReader.open(viewPath);
      const raw = await rawSegment(battle, view, { from, to });
      const got = await projectedSegment(battle, view, meta(), raw);
      await view.close();
      const full = projectedReplayStream(
        { header: { battleId: "b" }, snapshots: replay.snapshots, events: replay.events },
        meta(),
      );
      const want = projectSegment(raw, full);
      expect(got.snapshots).toEqual(want.snapshots);
      expect(got.events).toEqual(want.events);
      expect(got.mappingId).toBe(want.mappingId);
      expect((got.snapshots as any[]).length).toBeGreaterThan(0);
    });
  }
});

/**
 * V1 REPLAYS PR-4b · recupera la aserción directa del antiguo «segmento por ticks: arranca en el
 * keyframe anterior y respeta el rango» (sliceSegment, retirado) sobre `rawSegment` (revisión de
 * #345, P3-3).
 */
describe("rawSegment · arranca en el keyframe anterior y respeta el rango", () => {
  it("fromKeyframeTick = keyframe anterior, primer snapshot = keyframe, nada pasado de toTick, y aterriza en el tick pedido", async () => {
    const view = await ViewReader.open(viewPath);
    try {
      const kfs = view.summary.keyframes;
      expect(kfs.length).toBeGreaterThan(2);
      const midTick = Math.floor(replay.result.ticks / 2);
      const kf = view.nearestKeyframe(midTick)!;
      expect(kf.tick).toBeLessThanOrEqual(midTick);
      // Un mid que NO es keyframe: el segmento tiene que retroceder hasta él.
      expect(kfs.some((k) => k.tick === midTick)).toBe(false);
      const seg = (await rawSegment({ id: "rd6_battle" }, view, { from: midTick, to: midTick + 90 })) as any;
      expect(seg.fromKeyframeTick).toBe(kf.tick);
      expect(seg.snapshots[0].tick).toBe(kf.tick);
      expect(seg.snapshots.at(-1).tick).toBeLessThanOrEqual(midTick + 90);
      expect(seg.snapshots.some((s: { tick: number }) => Math.abs(s.tick - midTick) <= 3)).toBe(true);
      for (const e of seg.events) expect(e.tick).toBeLessThanOrEqual(midTick + 90);
    } finally {
      await view.close();
    }
  });
});
