/**
 * UX-E · RESPONSIVE (fase 1, entorno aislado real) en todas las rutas de
 * ux-e-lib.ts. La página no puede desbordar en horizontal (scroll lateral de
 * toda la pantalla). Capturas en $S9_E2E_OUT/shots.
 *
 * UX-MOBILE (2026-10-29) amplía:
 *  - 7 anchos: 1920, 1366, 1024 (tablet horizontal), 768 (vertical), 430, 390 y 360;
 *  - con DATOS reales (staff: la batalla del golden, sus replays, mapas, ranking):
 *    ninguna celda ni fila de tabla se sale de la pantalla (antes se excluían las
 *    tablas porque desplazaban dentro de su caja) y en ≤720 px las tablas son
 *    tarjetas con «Etiqueta: valor», conservando los data-testid de fila;
 *  - la barra se pliega tras «Menú» en ≤1024 px (aria-expanded, Escape devuelve el
 *    foco, cambiar de pantalla cierra) y en escritorio sigue entera;
 *  - objetivos táctiles de al menos 44 px en móvil.
 */
import { test, expect, type Page } from "@playwright/test";
import { REPLAY_ID, login, registerNewUser, shot } from "./helpers.js";
import { PANEL_ROUTES, PUBLIC_ROUTES, visit } from "./ux-e-lib.js";

const VIEWPORTS = [
  { name: "1920", width: 1920, height: 1080 },
  { name: "1366", width: 1366, height: 768 },
  { name: "1024", width: 1024, height: 768 },
  { name: "768", width: 768, height: 1024 },
  { name: "430", width: 430, height: 932 },
  { name: "390", width: 390, height: 844 },
  { name: "360", width: 360, height: 800 },
] as const;
type Vp = (typeof VIEWPORTS)[number];
/** Los cinco del bloque H (capturas de evidencia). */
const H_VIEWPORTS = VIEWPORTS.filter((v) => ["1920", "1366", "1024", "430", "360"].includes(v.name));
const MOBILE = (vp: Vp) => vp.width <= 720;
const COLLAPSED = (vp: Vp) => vp.width <= 1024;

/**
 * Desbordamientos conocidos de PÁGINAS de otros carriles. Clave `<ruta>|<ancho>`.
 */
// Vacía: el canvas del visor sigue al contenedor desde UX-R (b5b8e8a, 7a33000).
const KNOWN: Record<string, string> = {};

/**
 * Desbordamiento de la página y culpables. Con `strict`, cuentan también las
 * celdas y filas de tabla (UX-MOBILE: las tablas ya no desplazan en su caja);
 * sólo el cuadro del torneo y los bloques de código pueden hacerlo.
 */
async function overflow(page: Page, strict = false): Promise<{ px: number; culprits: string[] }> {
  return page.evaluate((strictMode) => {
    const px = document.documentElement.scrollWidth - window.innerWidth;
    const scrollers = strictMode ? ".bracket,pre,textarea" : "table,.bracket,pre";
    const culprits = [...document.querySelectorAll("body *")]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.right > window.innerWidth + 1;
      })
      .filter((e) => !e.parentElement?.closest(scrollers))
      .slice(0, 5)
      .map(
        (e) => `${e.tagName.toLowerCase()}${e.getAttribute("data-testid") ? `[${e.getAttribute("data-testid")}]` : ""}`,
      );
    return { px, culprits };
  }, strict);
}

async function check(page: Page, route: string, vp: Vp, strict = false) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await visit(page, route);
  const o = await overflow(page, strict);
  if (KNOWN[`${route}|${vp.name}`]) return o;
  expect.soft(o.px, `${route} @${vp.name}px desborda ${o.px}px: ${o.culprits.join(", ")}`).toBeLessThanOrEqual(1);
  if (strict) expect.soft(o.culprits, `${route} @${vp.name}px: elementos fuera de pantalla`).toEqual([]);
  return o;
}

/** Abre el menú si la barra está plegada (≤1024 px). */
async function openMenu(page: Page) {
  const toggle = page.getByTestId("nav-toggle");
  if (await toggle.isVisible()) {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }
}

test.describe("@fase1 UX-E responsive", () => {
  test("rutas públicas en 7 anchos", async ({ page }, info) => {
    await page.goto("/");
    for (const vp of VIEWPORTS) {
      await check(page, "#/bots", vp); // login
      if (vp.name === "390") await shot(page, info, "uxe-responsive-login-390");
      for (const r of PUBLIC_ROUTES) await check(page, r, vp);
    }
  });

  test("rutas del panel en 7 anchos (sin scroll lateral)", async ({ page }, info) => {
    test.setTimeout(420_000);
    await registerNewUser(page);
    for (const vp of VIEWPORTS) {
      for (const r of PANEL_ROUTES) await check(page, r, vp);
      await visit(page, "#/battles");
      await shot(page, info, `uxe-responsive-batallas-${vp.name}`);
    }
  });
});

test.describe("@fase1 UX-MOBILE", () => {
  test("tablas con datos reales: tarjetas en móvil, nada fuera de pantalla en 7 anchos", async ({ page }, info) => {
    test.setTimeout(420_000);
    expect(REPLAY_ID, "run.sh debe dar la batalla del golden (S9_E2E_REPLAY_ID)").not.toBe("");
    await login(page, process.env.S9_E2E_DEV_EMAIL ?? "", process.env.S9_E2E_DEV_PASSWORD ?? "");
    const detail = `#/battles/${encodeURIComponent(REPLAY_ID)}`;
    /** ruta → testid de fila que la tabla DEBE enseñar con estos datos. */
    const tables: [string, string, string][] = [
      ["#/battles", "battle-row", "batallas"],
      [detail, "participant-row", "detalle"],
      ["#/replays", "replay-row", "replays"],
      ["#/maps", "", "mapas"],
      ["#/ranking", "", "ranking"],
    ];
    for (const vp of VIEWPORTS) {
      for (const [route, rowId, name] of tables) {
        await check(page, route, vp, true);
        if (rowId) {
          const row = page.getByTestId(rowId).first();
          await expect(row, `${route} @${vp.name}: ${rowId}`).toBeVisible();
          const look = await row.evaluate((tr) => ({
            display: getComputedStyle(tr).display,
            labels: [...(tr as HTMLTableRowElement).cells].map((c) => c.getAttribute("data-label")),
            before: getComputedStyle((tr as HTMLTableRowElement).cells[0], "::before").content,
          }));
          if (MOBILE(vp)) {
            // tarjeta: la fila es un bloque y cada celda dice de qué columna es
            expect.soft(look.display, `${route} @${vp.name}`).toBe("block");
            expect
              .soft(
                look.labels.every((l) => !!l),
                `${route} @${vp.name}: ${look.labels}`,
              )
              .toBe(true);
            expect.soft(look.before, `${route} @${vp.name}`).toContain(look.labels[0] ?? "?");
          } else {
            expect.soft(look.display, `${route} @${vp.name}: escritorio sin cambios`).toBe("table-row");
          }
        }
        if (H_VIEWPORTS.some((h) => h.name === vp.name)) await shot(page, info, `uxm-${name}-${vp.name}`);
      }
    }
    // El detalle 4v4 (si lo es) enseña también los bandos como tarjetas.
    await page.setViewportSize({ width: 360, height: 800 });
    await visit(page, detail);
    const sides = page.getByTestId("side-row");
    if ((await sides.count()) > 0) {
      await expect(sides.first()).toBeVisible();
      expect(await sides.first().evaluate((tr) => getComputedStyle(tr).display)).toBe("block");
    }
  });

  test("menú plegable en móvil y tablet, barra entera en escritorio", async ({ page }, info) => {
    test.setTimeout(240_000);
    await registerNewUser(page);
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await visit(page, "#/");
      const nav = page.getByRole("navigation", { name: "principal" });
      const toggle = page.getByTestId("nav-toggle");
      const battles = nav.getByRole("link", { name: "Batallas", exact: true });
      if (!COLLAPSED(vp)) {
        await expect(toggle, `@${vp.name}`).toBeHidden();
        await expect(battles).toBeVisible();
        await expect(page.getByTestId("logout")).toBeVisible();
        continue;
      }
      // plegada: sólo marca + «Menú»; la barra deja de comerse ~220 px
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(battles).toBeHidden();
      const navH = (await nav.boundingBox())!.height;
      expect(navH, `@${vp.name}: alto de la barra plegada`).toBeLessThanOrEqual(64);
      const tb = (await toggle.boundingBox())!;
      expect(Math.min(tb.width, tb.height), `@${vp.name}: botón «Menú»`).toBeGreaterThanOrEqual(44);

      // teclado: Enter abre, Escape cierra y el foco vuelve al botón
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(battles).toBeVisible();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Escape");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toBeFocused();
      await expect(battles).toBeHidden();

      // táctil: abrir, enlaces ≥44 px, usuario y «Salir» dentro, navegar cierra
      await toggle.click();
      if (vp.name === "360" || vp.name === "430" || vp.name === "768")
        await shot(page, info, `uxm-menu-abierto-${vp.name}`);
      const links = nav.locator(".nav-menu a");
      for (let i = 0; i < (await links.count()); i++) {
        const b = (await links.nth(i).boundingBox())!;
        expect(b.height, `@${vp.name}: enlace ${i}`).toBeGreaterThanOrEqual(44);
        expect(b.x + b.width, `@${vp.name}: enlace ${i} dentro de pantalla`).toBeLessThanOrEqual(vp.width + 1);
      }
      await expect(page.getByTestId("nav-user")).toBeVisible();
      await expect(page.getByTestId("nav-user")).toContainText("Piloto E2E");
      await expect(page.getByTestId("logout")).toBeVisible();
      expect((await page.getByTestId("logout").boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await battles.click();
      await expect(page).toHaveURL(/#\/battles$/);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("heading", { name: "Batallas", exact: true })).toBeVisible();
    }
    // «Salir» funciona desde el menú plegado
    await page.setViewportSize({ width: 390, height: 844 });
    await openMenu(page);
    await page.getByTestId("logout").click();
    await expect(page.getByLabel("email")).toBeVisible();
  });

  test("objetivos táctiles ≥44 px en móvil (barra, botones y campos)", async ({ page }) => {
    test.setTimeout(240_000);
    await registerNewUser(page);
    for (const w of [360, 430]) {
      await page.setViewportSize({ width: w, height: 800 });
      for (const r of ["#/bots", "#/teams", "#/battles", "#/maps", "#/replays", "#/ranking"]) {
        await visit(page, r);
        const small = await page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              'nav button, main button, main select, main input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"])',
            ),
          ]
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
            })
            .filter((e) => e.getBoundingClientRect().height < 44)
            .map(
              (e) =>
                `${e.tagName.toLowerCase()}«${(e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 30)}» ${Math.round(e.getBoundingClientRect().height)}px`,
            ),
        );
        expect.soft(small, `${r} @${w}: objetivos < 44 px`).toEqual([]);
      }
    }
  });
});
