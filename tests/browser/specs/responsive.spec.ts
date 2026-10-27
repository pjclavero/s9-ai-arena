/**
 * UX-E · RESPONSIVE (fase 1, entorno aislado real): 1920×1080, 1366×768,
 * 768×1024 y 390×844 en todas las rutas. La página no puede desbordar en
 * horizontal (scroll lateral de toda la pantalla); las tablas y el cuadro del
 * torneo sí pueden desplazarse DENTRO de su caja. Capturas en $S9_E2E_OUT/shots.
 */
import { test, expect, type Page } from "@playwright/test";
import { registerNewUser, shot } from "./helpers.js";
import { PANEL_ROUTES, PUBLIC_ROUTES, visit } from "./ux-e-lib.js";

const VIEWPORTS = [
  { name: "1920", width: 1920, height: 1080 },
  { name: "1366", width: 1366, height: 768 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
] as const;

/**
 * Desbordamientos conocidos de PÁGINAS de otros carriles. Clave `<ruta>|<ancho>`.
 * El visor fija el canvas de Phaser a su tamaño de diseño (UX-D).
 */
const KNOWN: Record<string, string> = {
  "#/viewer/00000000-0000-0000-0000-000000000000|768": "UX-D: canvas del visor de ancho fijo",
  "#/viewer/00000000-0000-0000-0000-000000000000|390": "UX-D: canvas del visor de ancho fijo",
};

async function overflow(page: Page): Promise<{ px: number; culprits: string[] }> {
  return page.evaluate(() => {
    const px = document.documentElement.scrollWidth - window.innerWidth;
    const culprits = [...document.querySelectorAll("body *")]
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
      .filter((e) => !e.parentElement?.closest("table,.bracket,pre"))
      .slice(0, 5)
      .map(
        (e) => `${e.tagName.toLowerCase()}${e.getAttribute("data-testid") ? `[${e.getAttribute("data-testid")}]` : ""}`,
      );
    return { px, culprits };
  });
}

async function check(page: Page, route: string, vp: (typeof VIEWPORTS)[number]) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await visit(page, route);
  const o = await overflow(page);
  if (KNOWN[`${route}|${vp.name}`]) return o;
  expect.soft(o.px, `${route} @${vp.name}px desborda ${o.px}px: ${o.culprits.join(", ")}`).toBeLessThanOrEqual(1);
  return o;
}

test.describe("@fase1 UX-E responsive", () => {
  test("rutas públicas en 4 anchos", async ({ page }, info) => {
    await page.goto("/");
    for (const vp of VIEWPORTS) {
      await check(page, "#/bots", vp); // login
      if (vp.name === "390") await shot(page, info, "uxe-responsive-login-390");
      for (const r of PUBLIC_ROUTES) await check(page, r, vp);
    }
  });

  test("rutas del panel en 4 anchos (barra que se parte, sin scroll lateral)", async ({ page }, info) => {
    test.setTimeout(300_000);
    await registerNewUser(page);
    for (const vp of VIEWPORTS) {
      for (const r of PANEL_ROUTES) await check(page, r, vp);
      await visit(page, "#/battles");
      await shot(page, info, `uxe-responsive-batallas-${vp.name}`);
    }
  });
});
