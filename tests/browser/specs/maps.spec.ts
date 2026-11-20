/**
 * UX-C · C4 + C5 · Mapas de punta a punta en navegador real contra la API real
 * (fase 1, sin builds): importar al editor, guardar, F5 (reabrir desde la API),
 * validar, publicar como DUEÑO (rol user, no organizer), verlo en la lista y
 * seleccionarlo al crear una batalla SÓLO en los modos que declara.
 */
import { test, expect } from "@playwright/test";
import { go, registerNewUser, shot, watchProblems } from "./helpers.js";

test.describe("@fase1 UX-C mapas", () => {
  test("editor → guardar → F5 → publicar (dueño) → lista → selector de batalla filtra por modo", async ({
    page,
  }, info) => {
    const problems = watchProblems(page);
    await registerNewUser(page); // rol user: publicar lo puede el DUEÑO, no hace falta organizer
    const stamp = Date.now().toString(36);
    const mapId = `uxc-${stamp}`;

    // Geometría de la serie (mvp-arena-01): sólo declara team_deathmatch y capture_the_flag.
    const r = await page.request.get("/api/v1/maps/mvp-arena-01/versions/1/content");
    expect(r.status(), await r.text()).toBe(200);
    const base = (await r.json()) as Record<string, unknown>;
    const content = (base as { content?: unknown }).content ?? base;

    await go(page, "#/maps/editor");
    await expect(page.getByTestId("editor-perimeter-note")).toContainText("el borde del mapa es un muro", {
      ignoreCase: true,
    });
    // UX-EDITOR: el JSON vive plegado en «Opciones avanzadas» del editor visual.
    await page.getByText("Opciones avanzadas: archivo JSON del mapa").click();
    await page.getByLabel("JSON a importar").fill(JSON.stringify(content));
    await page.getByRole("button", { name: "Importar", exact: true }).click();
    await page.getByLabel("id del mapa").fill(mapId);
    await page.getByLabel("nombre del mapa").fill("UXC mapa");
    // Modos: se deja SOLO team_deathmatch (no deathmatch).
    for (const m of ["deathmatch", "capture_the_flag", "zone_control"]) {
      const cb = page.getByLabel(`modo ${m}`);
      if (await cb.isChecked()) await cb.uncheck();
    }
    const tdm = page.getByLabel("modo team_deathmatch");
    if (!(await tdm.isChecked())) await tdm.check();
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("editor-notice")).toContainText(`${mapId} v1`);
    await page.reload(); // reabre desde la API
    await expect(page.getByLabel("nombre del mapa")).toHaveValue("UXC mapa");
    await page.getByTestId("editor-publish").click();
    await expect(page.getByTestId("editor-notice")).toContainText("Publicado");

    // Lista: estado legible y sin botón de publicar (ya publicado).
    await go(page, "#/maps");
    const row = page.getByRole("row", { name: new RegExp(`UXC mapa · ${mapId}`) });
    await expect(row).toContainText("publicado");
    await expect(row).toContainText("team_deathmatch");
    await expect(row.getByText("Disponible para batallas")).toBeVisible();
    await shot(page, info, "uxc-mapa-publicado");

    // C5: el selector sólo ofrece el mapa en los modos que soporta.
    await go(page, "#/battles/new");
    await page.getByLabel("modo").selectOption("team_deathmatch");
    await expect(page.getByLabel("mapa").locator(`option[value="${mapId}@1"]`)).toHaveCount(1);
    await page.getByLabel("modo").selectOption("deathmatch");
    await expect(page.getByLabel("mapa").locator(`option[value="${mapId}@1"]`)).toHaveCount(0);
    expect(problems).toEqual([]);
  });
});
