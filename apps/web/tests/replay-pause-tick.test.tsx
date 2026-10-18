// @vitest-environment jsdom
/**
 * Pausa del reproductor: el tick que muestra la página al pausar es el tick REAL
 * en el que se paró el reproductor, no el último que el publicador a ~4 Hz
 * (R3.3) había emitido hasta 250 ms antes.
 *
 * Origen: `functional-e2e / golden` en `main` (run 39175128559) falló en
 * `replay.spec.ts` «pausa»: tras `data-state=paused`, `data-tick` pasó de 108 a
 * 110 sin que el reproductor avanzara — era el publicador poniéndose al día.
 *
 * Determinista: replay REAL (motor + replay-service), precargado en memoria, y
 * reloj falso (rAF, timers y performance.now) para fijar el instante de la pausa
 * entre dos publicaciones.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { IdleBot } from "../../arena-engine/src/stubs.js";
import { ingestReplay } from "../../replay-service/src/store.js";
import { createReplayServer } from "../../replay-service/src/server.js";
import type { ReplayIndexData, ReplaySegment, ReplaySource } from "../src/viewer/replay-player.js";

const BATTLE = "pause-tick";
const TICKS = 900;

// Fuente en memoria (sin E/S durante el render): se rellena en beforeAll con el
// índice y TODOS los segmentos servidos por el replay-service real.
const memory: { index: ReplayIndexData | null; segments: Map<string, ReplaySegment> } = {
  index: null,
  segments: new Map(),
};

vi.mock("../src/viewer/replay-player.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/viewer/replay-player.js")>();
  const memorySource = (): ReplaySource => ({
    index: async () => memory.index!,
    segment: async (from: number, to: number) => {
      const s = memory.segments.get(`${from}-${to}`);
      if (!s) throw new Error(`segmento no precargado ${from}-${to}`);
      return s;
    },
  });
  return { ...real, httpReplaySource: memorySource };
});

// Escena de Phaser: stub que acepta cualquier método (este test mide la página).
// `then` NO: si no, al devolverlo desde una función async se trataría como una
// promesa que nunca se resuelve.
// `overlay.score` es lo único que la página LEE de la escena (marcador).
const sceneStub = new Proxy(
  { overlay: { score: {} } },
  { get: (t, prop) => (prop === "then" ? undefined : prop in t ? (t as any)[prop] : () => undefined) },
);
vi.mock("../src/viewer/PhaserViewer.js", () => ({
  createViewerGame: () => ({ destroy: () => undefined }),
  waitForViewerScene: async () => sceneStub,
}));

let dir: string;

beforeAll(async () => {
  await initPhysics();
  const replay = await record(
    {
      battleId: BATTLE,
      seed: BATTLE,
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: TICKS }),
      map: emptyArena(),
      participants: [
        { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
        { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_red", new IdleBot("bot_red"));
      b.attachBot("v_blue", new IdleBot("bot_blue"));
    },
  );
  dir = mkdtempSync(join(tmpdir(), "replay-pause-"));
  ingestReplay(dir, replay, { official: true });
  const app = createReplayServer({ dir });
  const idx = await request(app).get(`/replays/${BATTLE}/index`);
  expect(idx.status).toBe(200);
  memory.index = idx.body;
  // Precarga de todos los trozos que puede pedir el reproductor. CHUNK_TICKS = 600
  // en replay-player.ts (no exportado): los rangos son [c·600, min((c+1)·600−1, ticks)].
  const CHUNK_TICKS = 600;
  const total: number = idx.body.ticks;
  for (let from = 0; from <= total; from += CHUNK_TICKS) {
    const to = Math.min(from + CHUNK_TICKS - 1, total);
    const seg = await request(app).get(`/replays/${BATTLE}/segment?fromTick=${from}&toTick=${to}`);
    expect(seg.status).toBe(200);
    memory.segments.set(`${from}-${to}`, seg.body);
  }
}, 60_000);

afterAll(() => {
  cleanup();
  vi.useRealTimers();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("ReplayPage · pausa", () => {
  it("al pausar, data-tick es el tick real del reproductor (no el último publicado a 4 Hz)", async () => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "performance",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    const { ReplayPage } = await import("../src/pages/ReplayPage.js");
    render(<ReplayPage battleId={BATTLE} />);

    const status = () => screen.getByTestId("replay-status");
    const tickOf = () => Number(screen.getByTestId("replay-tick").getAttribute("data-tick"));

    // Arranque hasta «playing» (todo es memoria + microtareas + timers falsos).
    for (let i = 0; i < 50 && status().getAttribute("data-state") !== "playing"; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });
    }
    expect(status().getAttribute("data-state"), status().textContent ?? "").toBe("playing");

    // 1100 ms de reproducción: el publicador (250 ms) emitió por última vez hacia
    // los 1000 ms, así que el valor mostrado va ~100 ms (≈3 ticks) por detrás.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pausa" }));
    });
    expect(status().getAttribute("data-state")).toBe("paused");
    const shownAtPause = tickOf();

    // Con el reproductor parado, el publicador sigue emitiendo el tick REAL.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const realPausedTick = tickOf();

    expect(realPausedTick).toBeGreaterThan(0);
    expect(shownAtPause).toBe(realPausedTick);
  }, 30_000);
});
