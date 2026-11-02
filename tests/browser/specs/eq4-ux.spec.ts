/**
 * EQ4 · UX, navegación y organización en navegador real contra la API real
 * (fase 1, sin builds):
 *  - barra: grupo «Bots y equipos»; «Administración» sólo con rol admin (organizador
 *    semilla = no la ve; admin semilla = una entrada + subnavegación de 4);
 *  - «Mis bots» maestro-detalle: escritorio en dos columnas, móvil apilado y sin
 *    scroll horizontal; Activos/Retirados con retirar y reactivar REALES;
 *  - «Equipos» maestro-detalle;
 *  - En directo con sesión y sin batallas: el texto de vacío, no el de permiso;
 *  - Replays: formulario de búsqueda accesible;
 *  - axe (critical/serious) en las pantallas tocadas y capturas por viewport.
 */
import { test, expect, type Page } from "@playwright/test";
import { go, login, registerNewUser, shot } from "./helpers.js";
import { runAxe, visit } from "./ux-e-lib.js";

const ADMIN_EMAIL = "admin@dev.arena.local";

async function hScroll(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
async function blockingAxe(page: Page): Promise<string[]> {
  return (await runAxe(page))
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.join(" , ")}`);
}

test.describe("@fase1 EQ4 navegación y organización", () => {
  test("barra agrupada y Administración según el rol real", async ({ page, browser }, info) => {
    await registerNewUser(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await visit(page, "#/bots");
    const nav = page.getByRole("navigation", { name: "principal" });
    const group = nav.getByRole("group", { name: "Bots y equipos" });
    await expect(group.getByRole("link", { name: "Mis bots", exact: true })).toBeVisible();
    await expect(group.getByRole("link", { name: "Equipos", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Administración" })).toHaveCount(0);
    await shot(page, info, "eq4-nav-usuario-1366");

    // admin semilla en OTRO contexto (otra sesión)
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const adm = await ctx.newPage();
    await adm.setViewportSize({ width: 1366, height: 900 });
    await login(adm, ADMIN_EMAIL, process.env.S9_E2E_DEV_PASSWORD ?? "");
    await expect(adm.getByTestId("logout")).toBeAttached();
    await visit(adm, "#/audit");
    const anav = adm.getByRole("navigation", { name: "principal" });
    await expect(anav.getByRole("link", { name: "Administración" })).toHaveAttribute("aria-current", "page");
    for (const n of ["Sistema", "Auditoría", "Roles"])
      await expect(anav.getByRole("link", { name: n, exact: true })).toHaveCount(0);
    const sub = adm.getByRole("navigation", { name: "Administración" });
    await expect(sub.getByRole("link")).toHaveText([
      "Usuarios y seguridad",
      "Sistema",
      "Auditoría",
      "Roles y permisos",
    ]);
    await sub.getByRole("link", { name: "Roles y permisos" }).click();
    await expect(adm.getByRole("heading", { name: "Roles y permisos" })).toBeVisible();
    expect(await blockingAxe(adm)).toEqual([]);
    await shot(adm, info, "eq4-admin-subnav-1366");
    await ctx.close();
  });

  test("Mis bots: maestro-detalle, móvil apilado y Activos/Retirados reales", async ({ page }, info) => {
    test.setTimeout(180_000);
    await registerNewUser(page);
    const stamp = Date.now().toString(36);
    const names = [`eq4-a-${stamp}`, `eq4-b-${stamp}`];
    await go(page, "#/bots");
    for (const n of names) {
      await page.getByLabel("nuevo-bot").fill(n);
      await page.getByRole("button", { name: "Crear bot" }).click();
      await expect(page.getByTestId("bots-active").getByRole("button", { name: n })).toBeVisible();
    }
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.getByTestId("bots-active").getByRole("button", { name: names[0] }).click();
    await expect(page.getByTestId("bot-summary")).toBeVisible();
    // escritorio: lista y detalle lado a lado
    const list = (await page.locator(".master-list").first().boundingBox())!;
    const pane = (await page.getByTestId("bot-pane").boundingBox())!;
    expect(pane.x, "detalle a la derecha de la lista").toBeGreaterThan(list.x + list.width - 1);
    expect(await blockingAxe(page)).toEqual([]);
    await shot(page, info, "eq4-bots-maestro-detalle-1366");

    // retirar ⇒ sale de Activos y entra en Retirados (desplegable); reactivar ⇒ vuelve
    await page.getByTestId("bot-retire").click();
    await expect(page.getByTestId("bots-retired")).toContainText("Retirados (1)");
    await expect(page.getByTestId("bots-active").getByRole("button", { name: names[0] })).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("bots-retired")).toContainText("Retirados (1)"); // persiste en el servidor
    await shot(page, info, "eq4-bots-retirados-1366");
    await page.getByTestId("bots-retired").locator("summary").click();
    await page.getByTestId("bots-retired").getByRole("button", { name: names[0] }).click();
    await page.getByTestId("bot-retire").click();
    await expect(page.getByTestId("bots-active").getByRole("button", { name: names[0] })).toBeVisible();

    for (const w of [430, 360]) {
      await page.setViewportSize({ width: w, height: 800 });
      await visit(page, "#/bots");
      await page.getByTestId("bots-active").getByRole("button", { name: names[1] }).click();
      await expect(page.getByTestId("bot-summary")).toBeVisible();
      const l = (await page.locator(".master-list").first().boundingBox())!;
      const p = (await page.getByTestId("bot-pane").boundingBox())!;
      expect(p.y, `@${w}: detalle debajo de la lista`).toBeGreaterThanOrEqual(l.y + l.height - 1);
      expect.soft(await hScroll(page), `@${w}: scroll horizontal`).toBeLessThanOrEqual(1);
      await shot(page, info, `eq4-bots-movil-${w}`);
    }
  });

  test("Equipos maestro-detalle (escritorio y móvil)", async ({ page }, info) => {
    await registerNewUser(page);
    const stamp = Date.now().toString(36);
    await go(page, "#/teams");
    for (const n of [`EQ4 Uno ${stamp}`, `EQ4 Dos ${stamp}`]) {
      await page.getByLabel("nuevo-equipo").fill(n);
      await page.getByRole("button", { name: "Crear equipo" }).click();
      await expect(page.getByRole("region", { name: `equipo ${n}` })).toBeVisible();
    }
    await page.setViewportSize({ width: 1366, height: 900 });
    await page
      .getByTestId("teams-list")
      .getByRole("button", { name: `EQ4 Uno ${stamp}` })
      .click();
    await expect(page.getByRole("region", { name: `equipo EQ4 Uno ${stamp}` })).toBeVisible();
    await expect(page.getByRole("region", { name: `equipo EQ4 Dos ${stamp}` })).toHaveCount(0);
    expect(await blockingAxe(page)).toEqual([]);
    await shot(page, info, "eq4-equipos-1366");
    await page.setViewportSize({ width: 360, height: 800 });
    await visit(page, "#/teams");
    expect.soft(await hScroll(page), "@360: scroll horizontal").toBeLessThanOrEqual(1);
    await shot(page, info, "eq4-equipos-360");
  });

  test("En directo con sesión y sin batallas; Replays con búsqueda; Ranking con ⓘ", async ({ page }, info) => {
    await registerNewUser(page);
    await visit(page, "#/live");
    await expect(page.getByTestId("live-empty")).toHaveText(
      "No hay ninguna batalla en directo en este momento. Cuando una batalla esté en curso aparecerá aquí.",
    );
    await expect(page.getByTestId("live-disabled")).toHaveCount(0);
    await shot(page, info, "eq4-en-directo-sesion");
    await visit(page, "#/replays");
    await expect(page.getByRole("search")).toBeVisible();
    expect(await blockingAxe(page)).toEqual([]);
    await shot(page, info, "eq4-replays-filtros-1280");
    await page.setViewportSize({ width: 360, height: 800 });
    await visit(page, "#/replays");
    expect.soft(await hScroll(page), "@360 replays: scroll horizontal").toBeLessThanOrEqual(1);
    await shot(page, info, "eq4-replays-filtros-360");
    await visit(page, "#/ranking");
    await page.getByTestId("ranking-mode").selectOption("zone_control");
    await page.getByTestId("tip-mode-zone_control-trigger").click();
    await expect(page.getByTestId("tip-mode-zone_control-panel")).toContainText("Disputada o vacía");
    await shot(page, info, "eq4-ranking-ayuda-modos-360");
  });
});
