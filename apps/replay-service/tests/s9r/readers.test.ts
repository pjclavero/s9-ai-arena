/**
 * V1 REPLAYS PR-4 · Lectores INCREMENTALES de S9R/1.
 *
 * RD1 RecipeCursor: cada comando llega en su tick, cada fragmento se lee UNA vez y la ventana
 *     retenida no pasa de ~2 fragmentos (45 000 ticks x 8 vehículos sintéticos, sin motor).
 * RD2 un tick repartido entre dos fragmentos se entrega completo (`<=` en ensure).
 * RD3 `official()`: hashes y checkpoints exactos sin retener comandos.
 * RD4 registro desconocido o "=" sin comando previo = CORRUPCIÓN (nunca se salta).
 * RD5 ViewReader: un rango sólo lee los fragmentos que lo cubren y devuelve exactamente lo del rango.
 * RD7 estadísticas desde la receta (por fragmentos) = estadísticas del Replay en memoria.
 * RD8 verify por cursor: un replay íntegro casa; con UN comando alterado no casa y dice dónde.
 * Mutantes: apps/replay-service/scripts/replay-pr4-mutants.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayRecorder } from "../../src/s9r/recorder.js";
import { publishPair } from "../../src/s9r/publish.js";
import { RecipeCursor } from "../../src/s9r/recipe.js";
import { ViewReader } from "../../src/s9r/view.js";
import { S9rReader } from "../../src/s9r/reader.js";
import { S9rWriter } from "../../src/s9r/writer.js";
import { CorruptReplayError } from "../../src/s9r/errors.js";
import { writeS9rReplay } from "../../src/testing/s9r-fixture.js";
import { verifyRecipePath } from "../../src/recipe-verify.js";
import { computeBattleStats, computeBattleStatsFrom, recipeStatsSource } from "../../src/stats.js";
import { initPhysics } from "../../../arena-engine/src/sim/physics.js";
import { record, type Replay } from "../../../arena-engine/src/replay.js";
import { loadRuleset } from "../../../../packages/game-rules/index.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../../arena-engine/src/stubs.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pr4-rd-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Receta sintética publicada: `ticks` x `veh` comandos (1 de cada 3 repetido), hash cada 30, ckpt cada 300. */
async function syntheticRecipe(ticks: number, veh: number, fragmentBytes: number) {
  const dir = tmp();
  const rec = await ReplayRecorder.create({
    dir,
    battleId: "rd_synth",
    attempt: 1,
    owner: "t",
    recipeHeader: { formatVersion: 2 },
    viewHeader: {},
    recipeFragmentBytes: fragmentBytes,
    recipeMaxPendingBytes: 8 * 1024 * 1024,
  });
  const cmd = (t: number, v: number) => (t % 3 === 0 ? { move: { throttle: 1 } } : { move: { throttle: t % 7 }, v });
  for (let t = 0; t < ticks; t++) {
    for (let v = 0; v < veh; v++) rec.command({ tick: t, vehicleId: `veh_${v + 1}`, command: cmd(t, v) });
    if (t % 30 === 0) rec.hash({ tick: t, hash: `h${t}` });
    if (t % 300 === 0) rec.checkpoint({ tick: t, hash: `k${t}`, components: { a: String(t) } });
    if (t % 200 === 0) await rec.drain();
  }
  const closed = await rec.finish({ ticks });
  await publishPair(
    {
      recipe: { partial: closed.recipe.partial, final: closed.recipe.final },
      view: { partial: closed.view.partial, final: closed.view.final },
    },
    { proof: closed.recipe.summary, viewProof: closed.view.summary },
  );
  return { path: closed.recipe.final, cmd };
}

describe("RecipeCursor (receta por fragmentos)", () => {
  it("RD1 comandos tick a tick, cada fragmento leído una vez y ventana acotada (45 000 x 8)", async () => {
    const TICKS = 45_000;
    const VEH = 8;
    const { path, cmd } = await syntheticRecipe(TICKS, VEH, 256 * 1024);
    const cursor = await RecipeCursor.open(path);
    const frags = (cursor as any).frags.length as number;
    expect(frags).toBeGreaterThan(20);
    for (let t = 0; t < TICKS; t++) {
      await cursor.ensure(t);
      for (let v = 0; v < VEH; v++) {
        const got = cursor.commandFor(`veh_${v + 1}`, t);
        if (JSON.stringify(got) !== JSON.stringify(cmd(t, v))) {
          throw new Error(`tick ${t} veh_${v + 1}: ${JSON.stringify(got)} != ${JSON.stringify(cmd(t, v))}`);
        }
      }
    }
    expect(cursor.fragmentReads).toBe(frags + 1); // + el frame de resultado al abrir
    const ticksPerFragment = TICKS / frags;
    expect(cursor.peakWindowTicks).toBeLessThanOrEqual(Math.ceil(ticksPerFragment * 2) + 2);
    await cursor.close();
  }, 120_000);

  it("RD2 un tick repartido entre dos fragmentos se entrega completo", async () => {
    const { path, cmd } = await syntheticRecipe(200, 8, 300);
    const r = await S9rReader.open(path);
    const data = r.dataFragments.map((f) => f.entry);
    await r.close();
    const straddles = data.some((e, i) => i > 0 && e.firstTick === data[i - 1].lastTick);
    expect(straddles).toBe(true);
    const cursor = await RecipeCursor.open(path);
    for (let t = 0; t < 200; t++) {
      await cursor.ensure(t);
      for (let v = 0; v < 8; v++) expect(cursor.commandFor(`veh_${v + 1}`, t)).toEqual(cmd(t, v));
    }
    await cursor.close();
  });

  it("RD3 official(): hashes y checkpoints exactos sin retener comandos", async () => {
    const { path } = await syntheticRecipe(3000, 2, 4096);
    const cursor = await RecipeCursor.open(path);
    await cursor.ensure(10);
    const o = await cursor.official();
    expect(o.stateHashes.map((h) => h.tick)).toEqual(Array.from({ length: 100 }, (_, i) => i * 30));
    expect(o.checkpoints.map((k) => [k.tick, k.hash])).toEqual(
      Array.from({ length: 10 }, (_, i) => [i * 300, `k${i * 300}`]),
    );
    expect(o.result).toEqual({ ticks: 3000 });
    expect(cursor.commandFor("veh_1", 10)).toBeNull(); // official() suelta la ventana
    await cursor.close();
  });

  it("RD4 registro desconocido o '=' sin comando previo: CorruptReplayError, nunca se salta", async () => {
    for (const bad of ['{"k":"x","t":1}', '{"k":"c","t":1,"v":"veh_1","=":1}']) {
      const dir = tmp();
      mkdirSync(join(dir, ".partial"), { recursive: true });
      const p = join(dir, ".partial", "f.s9r.part");
      const w = await S9rWriter.create(p, {
        kind: "R",
        header: { battleId: "rd4", s9r: { content: "s9.replay.recipe/v1" } },
        maxBytes: 1 << 20,
      });
      await w.append(bad, 1);
      await w.close({ result: { ticks: 1 } });
      const cursor = await RecipeCursor.open(p);
      await expect(cursor.ensure(1)).rejects.toBeInstanceOf(CorruptReplayError);
      await cursor.close();
    }
  });
});

let battle: Replay;
beforeAll(async () => {
  await initPhysics();
  battle = await record(
    {
      battleId: "rd_battle",
      seed: "rd_battle",
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
}, 120_000);

describe("ViewReader, estadísticas y verify sobre S9R/1", () => {
  it("RD5 un rango de la vista sólo lee los fragmentos que lo cubren y devuelve exactamente lo del rango", async () => {
    const fx = await writeS9rReplay(tmp(), battle, { viewFragmentBytes: 8 * 1024 });
    const view = await ViewReader.open(fx.viewPath);
    const r = (view as any).reader as S9rReader;
    const all = r.dataFragments.length;
    expect(all).toBeGreaterThan(4);
    const expectedFrags = r.fragmentsForTicks(300, 330).length;
    const before = view.fragmentReads;
    const got: number[] = [];
    for await (const x of view.records(300, 330)) got.push(x.tick);
    expect(view.fragmentReads - before).toBe(expectedFrags);
    expect(expectedFrags).toBeLessThan(all);
    const want = [
      ...battle.snapshots.filter((s) => s.tick >= 300 && s.tick <= 330).map((s) => s.tick),
      ...battle.events.filter((e) => e.tick >= 300 && e.tick <= 330).map((e) => e.tick),
    ].sort((a, b) => a - b);
    expect([...got].sort((a, b) => a - b)).toEqual(want);
    expect(view.summary.snapshotCount).toBe(battle.snapshots.length);
    expect(view.summary.keyframes[1]).toEqual({ tick: battle.snapshots[30].tick, snapshotIndex: 30 });
    await view.close();
  });

  it("RD7 estadísticas desde la receta por fragmentos = estadísticas del Replay en memoria", async () => {
    const fx = await writeS9rReplay(tmp(), battle, { recipeFragmentBytes: 8 * 1024 });
    const mem = await computeBattleStats(battle);
    const s9r = await computeBattleStatsFrom(await recipeStatsSource(fx.path));
    expect(s9r).toEqual(mem);
    // no vacuo: hubo combate y movimiento
    const red = (mem.perBot as any).v_red;
    expect(red.shotsFired + (mem.perBot as any).v_blue.shotsFired).toBeGreaterThan(0);
    expect(red.distanceM).toBeGreaterThan(0);
  }, 120_000);

  it("RD8 verify por cursor: íntegro casa; con UN comando alterado no casa y dice dónde", async () => {
    const ok = await writeS9rReplay(tmp(), battle, { recipeFragmentBytes: 8 * 1024 });
    const v1 = await verifyRecipePath(ok.path);
    expect(v1.verification.matches).toBe(true);
    expect(v1.fragmentReads).toBeGreaterThan(3);
    const i = battle.commands.findIndex((c) => c.tick > 200 && c.command?.move);
    const forged: Replay = {
      ...battle,
      commands: battle.commands.map((c, j) =>
        j === i ? { ...c, command: { ...c.command, move: { throttle: -1, steer: 1 } } } : c,
      ),
    };
    const bad = await writeS9rReplay(tmp(), forged, { recipeFragmentBytes: 8 * 1024 });
    const v2 = await verifyRecipePath(bad.path);
    expect(v2.verification.matches).toBe(false);
    expect(v2.verification.divergedAtTick).not.toBeNull();
    expect(v2.verification.divergedAtTick!).toBeGreaterThanOrEqual(battle.commands[i].tick);
  }, 120_000);
});
