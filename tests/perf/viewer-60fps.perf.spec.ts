/**
 * R3.3 · ERR-VIS-11 — Prueba de RENDIMIENTO del visor (Playwright headless).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ NO EJECUTADA en el entorno de desarrollo (ia-server VM102): sin navegador,│
 * │ sin docker, sin sudo. Escrita, bien formada, PARA LA CI REAL. Ver el      │
 * │ informe/PR de R3.3: figura como NO EJECUTADA por falta de infraestructura.│
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Qué mide (Definition of Done de R3.3):
 *  1. Visor con 8 bots y proyectiles densos ⇒ 60 fps sostenidos y draw calls
 *     por frame en un PUÑADO (no ~35): gracias al atlas batcheable, la RetroFont,
 *     la capa estática horneada y el pool de proyectiles con techo.
 *  2. Vista /broadcast a 1080p ⇒ 30 fps sostenidos (targetFps=30).
 *
 * Cómo mide: la escena publica `window.__s9perf` (render-stats.ts) con fps(),
 * worstFrameMs() y drawCalls() reales (el contador envuelve las llamadas de
 * dibujo del contexto WebGL). El test deja correr una ventana de warmup, luego
 * muestrea y afirma los umbrales.
 *
 * Cómo se alimenta el escenario denso: la página de rendimiento (o el arnés de
 * CI) debe exponer un modo de estrés con 8 bots y proyectiles densos. Aquí se
 * asume una ruta `/#/perf?bots=8&projectiles=200` servida por el arnés; ajústese
 * a la ruta real cuando el pipeline la fije.
 */
import { test, expect, type Page } from "@playwright/test";

/** Deja pasar `frames` frames reales de RAF antes de muestrear (warmup del meter). */
async function settleFrames(page: Page, frames: number): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n;
        const tick = (): void => {
          if (--left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );
}

interface PerfSample {
  fps: number | null;
  worstFrameMs: number | null;
  drawCalls: number | null;
}

async function readPerf(page: Page): Promise<PerfSample> {
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).__s9perf !== "undefined"), { timeout: 30_000 })
    .toBe(true);
  return page.evaluate(() => {
    const p = (window as any).__s9perf;
    return { fps: p.fps(), worstFrameMs: p.worstFrameMs(), drawCalls: p.drawCalls() };
  });
}

test.describe("Rendimiento del visor (ERR-VIS-11)", () => {
  test("60 fps sostenidos con 8 bots + proyectiles densos y pocos draw calls", async ({ page }) => {
    await page.goto("/#/perf?bots=8&projectiles=200");
    // Warmup: llena la ventana deslizante del FpsMeter (~2 s) antes de afirmar.
    await settleFrames(page, 150);
    const s = await readPerf(page);

    expect(s.fps, "fps debe estar medido (hay contexto de render)").not.toBeNull();
    // Umbral con holgura para el jitter del runner de CI (headless/swiftshader).
    expect(s.fps!).toBeGreaterThanOrEqual(55);
    // Ningún stall largo: el peor hueco entre frames por debajo de 2 frames de 60 fps.
    expect(s.worstFrameMs!).toBeLessThanOrEqual(34);

    // DoD ERR-VIS-09: los draw calls bajan de ~35 (Shapes+Text) a un puñado.
    expect(s.drawCalls, "draw calls deben medirse sobre WebGL").not.toBeNull();
    expect(s.drawCalls!).toBeLessThanOrEqual(12);
  });

  test("/broadcast sostiene 1080p30", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/#/broadcast/perf?bots=8&projectiles=200");
    await settleFrames(page, 120);
    const s = await readPerf(page);

    expect(s.fps, "fps debe estar medido").not.toBeNull();
    // targetFps=30 en /broadcast: se sostiene la cadencia de captura (con holgura).
    expect(s.fps!).toBeGreaterThanOrEqual(28);
    expect(s.drawCalls, "draw calls deben medirse").not.toBeNull();
    expect(s.drawCalls!).toBeLessThanOrEqual(12);
  });
});
