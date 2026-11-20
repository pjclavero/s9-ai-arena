/**
 * EQ3 · Centro de Ayuda en navegador real (sin mocks de la API):
 *  - @fase1 OFFLINE: se bloquea en el navegador TODA petición que no sea del mismo
 *    origen (como en una LAN sin Internet) y se recorren TODAS las hojas del índice:
 *    cada una pinta su título y contenido, sin texto roto, sin una sola petición
 *    externa (GitHub incluido) y sin infracciones axe critical/serious;
 *  - @fase1 teclado: un ⓘ se abre con Enter, se cierra con Escape y devuelve el foco;
 *  - @fase1 móvil (390×844): sin desbordamiento horizontal, índice plegable con
 *    objetivo de 44 px y el panel del ⓘ dentro de la pantalla;
 *  - @fase3 API PARADA de verdad: la ayuda se lee entera; sólo la tabla de rulesets
 *    de la instalación dice que no está disponible.
 * Las hojas se descubren del propio índice (#/help): una hoja nueva entra sola.
 */
import { test, expect, type Page } from "@playwright/test";
import { forbiddenLines, mainText, runAxe, type AxeViolation } from "./ux-e-lib.js";

async function blockExternal(page: Page): Promise<string[]> {
  const external: string[] = [];
  const base = new URL(test.info().project.use.baseURL ?? process.env.S9_E2E_BASE ?? "http://127.0.0.1");
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin === base.origin || u.protocol === "data:" || u.protocol === "blob:") return route.continue();
    external.push(u.href);
    return route.abort("internetdisconnected");
  });
  return external;
}

async function goHelp(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(page.getByTestId("help-page")).toBeVisible();
}

async function leaves(page: Page): Promise<{ href: string; title: string }[]> {
  return page
    .getByTestId("help-index")
    .locator('a[href^="#/help/"]')
    .evaluateAll((as) => as.map((a) => ({ href: a.getAttribute("href")!, title: (a.textContent ?? "").trim() })));
}

const blocking = (v: AxeViolation[]) =>
  v.filter((x) => x.impact === "critical" || x.impact === "serious").map((x) => `${x.id}: ${x.nodes.join(" , ")}`);

test.describe("@fase1 EQ3 Centro de Ayuda", () => {
  test("offline: todas las hojas cargan sin red externa, sin texto roto y sin infracciones axe graves", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const external = await blockExternal(page);
    await page.goto("/#/help");
    await expect(page.getByTestId("help-page")).toBeVisible();
    const list = await leaves(page);
    expect(list.length, "el índice debe tener todas las hojas").toBeGreaterThanOrEqual(40);
    for (const l of list) {
      await goHelp(page, l.href);
      const art = page.getByTestId("help-article");
      await expect(art.getByRole("heading", { level: 3 }), l.href).toHaveText(l.title);
      // Si la hoja consulta /rulesets, que termine (ok o no disponible) antes de medir.
      await expect(page.getByTestId("help-platform-rulesets-loading")).toHaveCount(0, { timeout: 15_000 });
      const text = await mainText(page);
      expect.soft(text.length, `${l.href} vacía`).toBeGreaterThan(150);
      expect.soft(forbiddenLines(text), `texto roto en ${l.href}`).toEqual([]);
      expect.soft(blocking(await runAxe(page)), `axe ${l.href}`).toEqual([]);
    }
    expect(external, "ninguna petición fuera del mismo origen").toEqual([]);
  });

  test("teclado: ⓘ con Enter, Escape lo cierra y el foco vuelve al ⓘ", async ({ page }) => {
    await blockExternal(page);
    await page.goto("/#/help/torneos/ranking");
    const trigger = page.getByTestId("tip-vde-trigger");
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dlg = page.getByRole("dialog", { name: "V-D-E" });
    await expect(dlg).toBeVisible();
    await expect(dlg).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await expect(trigger).toBeFocused();
    // La X también cierra.
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Cerrar ayuda" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("ⓘ dentro de un <label>: leer la ayuda NO alterna la casilla (EQ6-P2); el texto del label sí", async ({
    page,
  }) => {
    await blockExternal(page);
    await page.goto("/#/help/bots/ejemplos");
    const box = page.getByTestId("help-wrap");
    await expect(box).not.toBeChecked();
    await page.getByTestId("tip-wrap-trigger").click();
    const panel = page.getByTestId("tip-wrap-panel");
    await expect(panel).toBeVisible();
    await expect(box, "abrir el ⓘ no cambia la casilla").not.toBeChecked();
    await panel.getByText("Parte las líneas largas").click();
    await expect(box, "clic en el TEXTO del panel").not.toBeChecked();
    await panel.locator(".infotip-title").click();
    await expect(box, "clic en el TÍTULO del panel").not.toBeChecked();
    await page.getByRole("button", { name: "Cerrar ayuda" }).click();
    await expect(box, "la X tampoco").not.toBeChecked();
    // Control positivo: el texto del propio label SÍ alterna la casilla (la prueba no es ciega).
    await page.getByTestId("help-wrap-text").click();
    await expect(box).toBeChecked();
  });

  test("Tab desde la X siendo el último enfocable cierra el panel (EQ6-P3)", async ({ page }) => {
    await blockExternal(page);
    await page.goto("/#/help/bots/ejemplos");
    await page.getByTestId("tip-wrap-trigger").click();
    await page.getByRole("button", { name: "Cerrar ayuda" }).focus();
    // Saca el foco a <body> como lo haría un Tab desde el último enfocable.
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await expect(page.getByTestId("tip-wrap-panel")).toHaveCount(0);
  });

  test("móvil 390×844: sin desbordamiento, índice plegable de 44 px y ⓘ dentro de la pantalla", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await blockExternal(page);
    await page.goto("/#/help");
    for (const h of [
      "#/help",
      "#/help/equipamiento/chassis",
      "#/help/referencia/reglas",
      "#/help/bots/comandos",
      "#/help/bots/sdk-python",
      "#/help/modos/zone_control",
    ]) {
      await goHelp(page, h);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect.soft(over, `desborda en ${h}`).toBeLessThanOrEqual(1);
    }
    await goHelp(page, "#/help");
    const toggle = page.getByRole("button", { name: "Índice de la ayuda" });
    await expect(toggle).toBeVisible();
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByTestId("help-index").locator('a[href="#/help/modos/zone_control"]')).toBeHidden();
    await toggle.click();
    await page.getByTestId("help-index").locator('a[href="#/help/modos/zone_control"]').click();
    await expect(page.getByTestId("help-page")).toHaveAttribute("data-help-section", "modos/zone_control");

    await goHelp(page, "#/help/torneos/ranking");
    const trigger = page.getByTestId("tip-rating-trigger");
    const tb = (await trigger.boundingBox())!;
    expect(tb.width).toBeGreaterThanOrEqual(44);
    expect(tb.height).toBeGreaterThanOrEqual(44);
    await trigger.click();
    const panel = page.getByTestId("tip-rating-panel");
    await expect(panel).toBeVisible();
    const pb = (await panel.boundingBox())!;
    expect(pb.x).toBeGreaterThanOrEqual(0);
    expect(pb.x + pb.width).toBeLessThanOrEqual(390);
    expect(pb.y + pb.height).toBeLessThanOrEqual(844);
  });
});

test.describe("@fase3 EQ3 Centro de Ayuda con la API parada", () => {
  test("la ayuda se lee entera; sólo los rulesets de la instalación no están", async ({ page }) => {
    const external = await blockExternal(page);
    await page.goto("/#/help/modos/zone_control");
    await expect(page.getByTestId("help-page")).toBeVisible();
    await expect(page.getByTestId("help-zone-control-rules").locator("li")).toHaveCount(6);
    await expect(page.getByTestId("help-mode-rulesets-zone_control")).toBeVisible();
    await expect(page.getByTestId("help-platform-rulesets-unavailable")).toBeVisible({ timeout: 20_000 });
    await goHelp(page, "#/help/bots/sdk-python");
    await expect(page.getByTestId("help-code-py-tutorial")).toContainText("class TutorialBot(ArenaBot)");
    expect(external).toEqual([]);
  });
});
