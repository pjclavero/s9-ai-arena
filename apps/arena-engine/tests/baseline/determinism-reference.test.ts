/**
 * OLA 2 · ME · BASELINE · determinismo de la batalla de referencia (C-DET, C-RPL-1).
 *
 * Fija resultado, hash final, hashes intermedios, eventos públicos y snapshots de la
 * batalla de referencia del BASE_SHA f07ff6f. MD/MA/MB/MC pueden cambiar el HASH
 * (BACKWARD_COMPATIBILITY_REQUIRED=NO) pero no el resultado deportivo ni el orden de
 * eventos sin decidirlo: por eso el golden separa `sporting` (no debería cambiar) de
 * `hashes` (se regenera conscientemente al cambiar la forma del estado).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initPhysics } from "../../src/sim/physics.js";
import { fromJsonl, toJsonl, verify } from "../../src/replay.js";
import { assertBaselineGolden, sha256 } from "./helpers.js";
import { REFERENCE_TICKS, recordReference } from "./reference-battle.js";

beforeAll(async () => {
  await initPhysics();
});

function eventKindCounts(events: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort());
}

describe("baseline · batalla de referencia (determinismo, resultado, replay)", () => {
  it("resultado deportivo fijado: winner, endReason, ticks, score, disqualified y eventos públicos", async () => {
    const r = await recordReference();
    assertBaselineGolden("reference-sporting", {
      winner: r.result.winner,
      endReason: r.result.endReason ?? null,
      ticks: r.result.ticks,
      score: r.result.score,
      disqualified: r.result.disqualified,
      publicEventKinds: eventKindCounts(r.events),
      publicEventsDigest: sha256(r.events),
      snapshotCount: r.snapshots.length,
      commandCount: r.commands.length,
      maxTicks: REFERENCE_TICKS,
    });
  });

  it("hash fijado: finalStateHash y digest de todos los stateHashes (se regenera al cambiar la forma del estado)", async () => {
    const r = await recordReference();
    assertBaselineGolden("reference-hashes", {
      finalStateHash: r.result.finalStateHash,
      stateHashCount: r.stateHashes.length,
      stateHashesDigest: sha256(r.stateHashes),
      snapshotsDigest: sha256(r.snapshots),
      versions: r.result.versions,
    });
  });

  it("dos ejecuciones idénticas dan replay idéntico byte a byte (salvo recordedAt)", async () => {
    const a = await recordReference();
    const b = await recordReference();
    const strip = (r: any) => ({ ...r, header: { ...r.header, recordedAt: "" } });
    expect(toJsonl(strip(b))).toBe(toJsonl(strip(a)));
  });

  it("verify() reproduce el replay de referencia y sobrevive al round-trip JSONL", async () => {
    const r = await recordReference();
    const back = fromJsonl(toJsonl(r));
    const v = await verify(back);
    expect(v.matches).toBe(true);
    expect(v.divergedAtTick).toBeNull();
    expect(v.recomputedHash).toBe(r.result.finalStateHash);
    expect(v.recomputedResult.winner).toBe(r.result.winner);
  });

  it("verify() rechaza un replay con un comando manipulado (hashes de la grabación original)", async () => {
    const r = await recordReference();
    const tampered = JSON.parse(JSON.stringify(r));
    const i = tampered.commands.findIndex((c: any) => c.vehicleId === "veh_1" && c.command?.move);
    tampered.commands[i].command.move = { throttle: -1, steer: 1 };
    const v = await verify(tampered);
    expect(v.matches).toBe(false);
  });

  it("la batalla de referencia ejercita lo que dice ejercitar (control: hay disparos, minas e impactos)", async () => {
    const r = await recordReference();
    const projIds = new Set(r.snapshots.flatMap((s: any) => s.projectiles.map((p: any) => p.id)));
    expect(projIds.size).toBeGreaterThan(0);
    // Las minas no son públicas: se cuentan por los comandos aceptados del minero.
    expect(r.commands.some((c) => c.command?.deployMine)).toBe(true);
    const hpDrop = r.snapshots.some((s: any) => s.vehicles.some((v: any) => v.hullHp < v.hullHpMax));
    expect(hpDrop).toBe(true);
  });
});
