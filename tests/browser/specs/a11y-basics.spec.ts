/**
 * UX-E · Accesibilidad BÁSICA (fase 1, entorno aislado real, sin mocks):
 *  - axe-core (WCAG 2.0/2.1 A y AA) en todas las rutas: ninguna infracción
 *    `critical`/`serious` salvo las ya asignadas a otro carril (KNOWN, con el
 *    carril dueño: se quitan de la lista al corregirse);
 *  - teclado: «Saltar al contenido» es la primera parada y lleva al <main>;
 *    tras navegar con la barra el foco va al encabezado de la pantalla nueva;
 *    toda parada de tabulación tiene foco visible;
 *  - el arranque anónimo NO hace POST /auth/refresh (C-G13: 400 en consola).
 */
import { test, expect } from "@playwright/test";
import { registerNewUser } from "./helpers.js";
import { PANEL_ROUTES, PUBLIC_ROUTES, runAxe, visit, type AxeViolation } from "./ux-e-lib.js";

/**
 * Infracciones conocidas de PÁGINAS de otros carriles (no de los componentes
 * comunes). Clave: `<ruta>|<regla axe>`. Cada una está en el informe de UX-E
 * con fichero:línea y fix propuesto.
 */
const KNOWN: Record<string, string> = {
  [`#/replay/00000000-0000-0000-0000-000000000000?t=0|label`]:
    "UX-D: ReplayPage, <input type=range data-testid=timeline> sin nombre",
  [`#/maps/editor|aria-prohibited-attr`]: "UX-C: MapEditorPage, aria-label en <circle> sin role",
};

function blocking(route: string, v: AxeViolation[]): string[] {
  return v
    .filter((x) => x.impact === "critical" || x.impact === "serious")
    .filter((x) => !KNOWN[`${route}|${x.id}`])
    .map((x) => `${x.id} (${x.impact}): ${x.nodes.join(" , ")}`);
}

test.describe("@fase1 UX-E accesibilidad básica", () => {
  test("arranque anónimo: sin POST /auth/refresh (C-G13) y login accesible", async ({ page }) => {
    const refreshes: number[] = [];
    page.on("response", (r) => {
      if (/\/api\/v1\/auth\/refresh/.test(r.url())) refreshes.push(r.status());
    });
    await page.goto("/");
    await expect(page.getByLabel("email")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(refreshes, "una carga anónima no debe preguntar por una sesión que no existe").toEqual([]);
    expect(blocking("login", await runAxe(page))).toEqual([]);
  });

  test("axe en las rutas públicas", async ({ page }) => {
    await page.goto("/");
    for (const r of PUBLIC_ROUTES) {
      await visit(page, r);
      expect.soft(blocking(r, await runAxe(page)), `axe ${r}`).toEqual([]);
    }
  });

  test("axe en todas las rutas del panel", async ({ page }) => {
    test.setTimeout(240_000);
    await registerNewUser(page);
    for (const r of PANEL_ROUTES) {
      await visit(page, r);
      expect.soft(blocking(r, await runAxe(page)), `axe ${r}`).toEqual([]);
    }
  });

  test("teclado: «Saltar al contenido» primero; foco al encabezado tras navegar; foco visible", async ({ page }) => {
    await registerNewUser(page);
    await page.reload();
    await expect(page.getByTestId("logout")).toBeVisible();
    await page.keyboard.press("Tab");
    const first = page.locator(":focus");
    await expect(first).toHaveText("Saltar al contenido");
    await expect(first).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    await expect(page).toHaveURL(/#\/bots|\/$/);

    // Navegar con la barra: el foco acaba en el encabezado de la pantalla nueva.
    // Acotado a la barra: la home (UX-A) tiene también «Ir a Equipos» en la checklist.
    await page
      .getByRole("navigation", { name: "principal" })
      .getByRole("link", { name: "Equipos", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Equipos", exact: true })).toBeFocused();

    // Todas las paradas de tabulación de la barra y del contenido tienen foco visible.
    await page.locator("body").focus();
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      const outline = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        if (!a || a === document.body) return "body";
        const cs = getComputedStyle(a);
        return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0
          ? "ok"
          : `sin foco visible: ${a.outerHTML.slice(0, 80)}`;
      });
      if (outline === "body") break;
      expect.soft(outline).toBe("ok");
    }
  });
});
