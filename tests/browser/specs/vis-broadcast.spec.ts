/**
 * VISIBILIDAD (2026-11) · §35 en navegador REAL y ANÓNIMO (sin sesión).
 *
 * NO lo lanza run.sh: lo orquesta tests/visibility-e2e/e2e.sh contra
 * tests/visibility-e2e/vis-live-env.ts (batalla real del motor en un torneo con
 * `broadcast`, A-DEF privado con código privado y B-PUB público con código privado).
 *
 * Comprueba en /broadcast: los dos nombres con su versión y equipo, el directo en
 * pantalla y que NINGUNA respuesta que recibe la página contiene código, ficheros,
 * dueño ni loadout privado. Después, desde el mismo navegador anónimo, que la ficha
 * y el código de A-DEF siguen sin existir y que el código de B-PUB sigue privado.
 */
import { test, expect } from "@playwright/test";

const IDS = JSON.parse(process.env.S9_VIS_IDS ?? "{}") as Record<string, string>;
const FORBIDDEN = [
  "SECRETO_CODIGO_A_DEF_7f3a",
  "estrategia-secreta-a-def",
  "duena-secreta-a-def",
  "Dueña Secreta ADEF",
  "loadout-secreto-a-def",
];

test.describe("@vis-e2e retransmisión pública con un bot privado", () => {
  test("/broadcast anónima: nombres, directo y cero datos privados", async ({ page }, info) => {
    const bodies: { url: string; text: string }[] = [];
    page.on("response", async (r) => {
      if (!r.url().includes("/api/v1/")) return;
      try {
        bodies.push({ url: r.url(), text: await r.text() });
      } catch {
        /* cuerpo no disponible (redirección) */
      }
    });
    const frames: string[] = [];
    page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));
    await page.goto(`/broadcast?battle=${IDS.TB}&event=Copa%20Visibilidad`);
    await expect(page.locator("body")).toContainText("A-DEF", { timeout: 30_000 });
    await expect(page.locator("body")).toContainText("B-PUB");
    await expect(page.locator("canvas").first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(5_000);
    await page.screenshot({ path: info.outputPath("broadcast-live.png"), fullPage: false });
    expect(frames.length, "el canal de espectador entrega mensajes").toBeGreaterThan(0);
    const init = frames.map((f) => JSON.parse(f)).find((m) => m.type === "init");
    expect(init?.meta?.roster?.map((r: any) => r.name).sort()).toEqual(["A-DEF", "B-PUB"]);
    for (const r of init.meta.roster) expect(Object.keys(r).sort()).toEqual(["botId", "chassis", "id", "name", "team"]);
    for (const { url, text } of [...bodies, ...frames.map((t) => ({ url: "ws", text: t }))]) {
      for (const f of FORBIDDEN) expect(text, `${url} contiene «${f}»`).not.toContain(f);
      expect(text, `${url} contiene el id de la dueña`).not.toContain(IDS.A);
    }
    console.log(`VIS · respuestas API=${bodies.length} frames WS=${frames.length}`);
  });

  test("la ficha y el código siguen protegidos para el mismo visitante", async ({ page }) => {
    await page.goto("/");
    const st = await page.evaluate(async (ids) => {
      const s = async (p: string) => (await fetch(`/api/v1${p}`)).status;
      return {
        botA: await s(`/bots/${ids.BOT_A}`),
        botAVersions: await s(`/bots/${ids.BOT_A}/versions`),
        botASource: await s(`/bots/${ids.BOT_A}/versions/1/source`),
        botB: await s(`/bots/${ids.BOT_B}`),
        botBSource: await s(`/bots/${ids.BOT_B}/versions/1/source`),
        botBFiles: await s(`/bots/${ids.BOT_B}/versions/1/files`),
        battle: await s(`/battles/${ids.TB}`),
        loose: await s(`/battles/${ids.S}`),
      };
    }, IDS);
    console.log(`VIS · estados anónimos ${JSON.stringify(st)}`);
    expect(st.botA).toBe(404);
    expect(st.botAVersions).toBe(404);
    expect([401, 404]).toContain(st.botASource);
    expect(st.botB).toBe(200);
    expect([401, 403]).toContain(st.botBSource);
    expect([401, 403]).toContain(st.botBFiles);
    expect(st.battle).toBe(200);
    expect(st.loose).toBe(404); // batalla suelta con bot privado: nada expuesto
  });
});
