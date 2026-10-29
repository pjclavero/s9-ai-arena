/**
 * UX-EDITOR · Editor visual de mapas en navegador REAL contra la API real (fase 1).
 *
 * Ratón de verdad (page.mouse: down/move/up) sobre el lienzo SVG: crear desde la
 * paleta, seleccionar, mover arrastrando, redimensionar con un tirador, borrar,
 * duplicar, deshacer/rehacer por teclado, zoom (rueda y botones) y pan, validación
 * visible antes de guardar, guardar en el servidor y recargar sin perder lo que no
 * se guardó. OLD_MAP_REGRESSION: mvp-arena-01 (API), un procedural generado por la
 * API y el formato antiguo en px se abren y se guardan sin cambiar su contenido.
 * Capturas en 5 viewports (1920, 1366, 1024, 430, 360) sin desbordamiento horizontal.
 */
import { test, expect, type Page } from "@playwright/test";
import { go, login, registerNewUser, shot, watchProblems } from "./helpers.js";

/** Punto del mundo (m) → coordenadas de página, leyendo la vista que publica el lienzo. */
async function toPage(page: Page, x: number, y: number) {
  const stage = page.getByTestId("editor-stage");
  await stage.scrollIntoViewIfNeeded(); // un punto fuera del viewport no recibe el clic
  const box = (await page.getByTestId("editor-canvas").boundingBox())!;
  const z = Number(await stage.getAttribute("data-zoom"));
  const [cx, cy] = (await stage.getAttribute("data-center"))!.split(",").map(Number);
  return { x: box.x + box.width / 2 + (x - cx) * z, y: box.y + box.height / 2 + (y - cy) * z };
}
async function mouseDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}
const value = (page: Page, label: string) => page.getByLabel(label, { exact: true }).inputValue().then(Number);
const objects = (page: Page, kind: string) => page.locator(`[data-testid="editor-obj"][data-kind="${kind}"]`);
const palette = (page: Page, name: string) =>
  page.getByTestId("editor-palette").getByRole("button", { name, exact: true });

async function openAdvancedAndImport(page: Page, json: string) {
  await page.getByText("Opciones avanzadas: archivo JSON del mapa").click();
  await page.getByLabel("JSON a importar").fill(json);
  await page.getByRole("button", { name: "Importar", exact: true }).click();
}

test.describe("@fase1 UX-EDITOR editor visual", () => {
  test("crear, seleccionar, mover, redimensionar, borrar, duplicar, deshacer/rehacer, zoom, pan, validar, guardar y recargar", async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    const problems = watchProblems(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await registerNewUser(page);
    await go(page, "#/maps/editor");
    await expect(page.getByTestId("editor-canvas")).toBeVisible();
    const mapId = `uxed-${Date.now().toString(36)}`;
    await page.getByLabel("id del mapa").fill(mapId);
    await page.getByLabel("nombre del mapa").fill("UX editor");

    // CREATE: paleta → clic en el mapa.
    await palette(page, "Muro").click();
    const c = await toPage(page, 60, 40);
    await page.mouse.click(c.x, c.y);
    await expect(objects(page, "wall")).toHaveCount(1);
    await expect(objects(page, "wall").first()).toHaveAttribute("data-selected", "true");
    expect(await value(page, "Posición X")).toBeCloseTo(60, 0);

    // SELECT: clic sobre otro objeto (punto de aparición rojo en 10,40) y volver al muro.
    const sp = await toPage(page, 10, 40);
    await page.mouse.click(sp.x, sp.y);
    await expect(page.getByTestId("editor-props").locator("legend")).toHaveText("Punto de aparición rojo 1");
    await page.mouse.click(c.x, c.y);
    await expect(page.getByTestId("editor-props").locator("legend")).toHaveText("Muro 1");

    // DRAG real con el ratón: el muro va a (75, 30).
    await mouseDrag(page, c, await toPage(page, 75, 30));
    expect(await value(page, "Posición X")).toBeCloseTo(75, 0);
    expect(await value(page, "Posición Y")).toBeCloseTo(30, 0);

    // RESIZE con el tirador este: +5 m de anchura con el borde oeste fijo.
    const h = (await page.getByTestId("editor-handle-e").boundingBox())!;
    const hc = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
    const z = Number(await page.getByTestId("editor-stage").getAttribute("data-zoom"));
    const w0 = await value(page, "Anchura");
    await mouseDrag(page, hc, { x: hc.x + 5 * z, y: hc.y });
    expect(await value(page, "Anchura")).toBeCloseTo(w0 + 5, 0);
    await shot(page, info, "uxed-resize");

    // UNDO / REDO con el teclado.
    await page.keyboard.press("Control+z");
    expect(await value(page, "Anchura")).toBeCloseTo(w0, 1);
    await page.keyboard.press("Control+Shift+z");
    expect(await value(page, "Anchura")).toBeCloseTo(w0 + 5, 0);
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+y");
    expect(await value(page, "Anchura")).toBeCloseTo(w0 + 5, 0);

    // DUPLICATE y DELETE (+ deshacer el borrado).
    await page.getByRole("button", { name: "Duplicar objeto", exact: true }).click();
    await expect(objects(page, "wall")).toHaveCount(2);
    await page.keyboard.press("Delete");
    await expect(objects(page, "wall")).toHaveCount(1);
    await page.keyboard.press("Control+z");
    await expect(objects(page, "wall")).toHaveCount(2);
    await page
      .getByTestId("editor-objects")
      .getByRole("button", { name: /^Muro 2/ })
      .click();
    await page.getByRole("button", { name: "Eliminar objeto", exact: true }).click();
    await expect(objects(page, "wall")).toHaveCount(1);

    // ZOOM: rueda sobre el lienzo (sin hacer scroll de la página) y botones.
    const stage = page.getByTestId("editor-stage");
    const zoomOf = async () => Number(await stage.getAttribute("data-zoom"));
    const z0 = await zoomOf();
    const scroll0 = await page.evaluate(() => window.scrollY);
    await page.mouse.move(c.x, c.y);
    await page.mouse.wheel(0, -300);
    await expect.poll(zoomOf).toBeGreaterThan(z0 * 1.5);
    expect(await page.evaluate(() => window.scrollY)).toBe(scroll0);
    await page.getByRole("button", { name: "Encajar mapa" }).click();
    await expect.poll(zoomOf).toBeCloseTo(z0, 3);
    await page.getByRole("button", { name: "Acercar" }).click();
    await expect.poll(zoomOf).toBeCloseTo(z0 * 1.25, 3);
    await page.getByRole("button", { name: "100 %", exact: true }).click();
    await expect(page.getByTestId("editor-zoom")).toHaveText("100 %");

    // PAN: arrastrar en un hueco desplaza la vista.
    const center0 = await stage.getAttribute("data-center");
    const empty = await toPage(page, 50, 50);
    await mouseDrag(page, empty, { x: empty.x - 120, y: empty.y - 40 });
    await expect(stage).not.toHaveAttribute("data-center", center0!);
    await page.getByRole("button", { name: "Encajar mapa" }).click();

    // VALIDATION en vivo: un punto de aparición azul DENTRO del muro.
    await page
      .getByTestId("editor-objects")
      .getByRole("button", { name: /^Muro 1/ })
      .click(); // el pan en vacío deselecciona
    const wallPos = await toPage(page, await value(page, "Posición X"), await value(page, "Posición Y"));
    await palette(page, "Punto de aparición azul").click();
    await page.mouse.click(wallPos.x, wallPos.y);
    const issue = page.getByTestId("editor-issue").filter({ hasText: "está dentro de muro 1" });
    await expect(issue).toBeVisible();
    await expect(issue).toHaveAttribute("data-severity", "error");
    await expect(page.locator('[data-testid="editor-obj"][data-kind="spawn"][data-issue="error"]')).toHaveCount(1);
    await shot(page, info, "uxed-validacion");
    await page.keyboard.press("Delete"); // se quita el spawn mal puesto
    await expect(page.getByTestId("editor-validation-ok")).toBeVisible();

    // GUARDAR en el servidor.
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("editor-notice")).toContainText(`${mapId} v1`);
    await expect(page.getByTestId("editor-current")).toHaveText(`${mapId} v1`);

    // Cambio SIN guardar → recargar → sigue ahí (borrador local) sobre el mapa del servidor.
    await page
      .getByTestId("editor-objects")
      .getByRole("button", { name: /^Muro 1/ })
      .click(); // borrar el spawn deja sin selección
    const wp = await toPage(page, await value(page, "Posición X"), await value(page, "Posición Y"));
    await page.mouse.click(wp.x, wp.y);
    await mouseDrag(page, wp, await toPage(page, 30, 20));
    const movedX = await value(page, "Posición X");
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("s9.mapEditor.draft.v1") ?? ""))
      .toContain(mapId);
    await page.reload();
    await expect(page.getByTestId("editor-current")).toHaveText(`${mapId} v1`);
    await expect(page.getByTestId("editor-restored")).toBeVisible();
    await page
      .getByTestId("editor-objects")
      .getByRole("button", { name: /^Muro 1/ })
      .click();
    expect(await value(page, "Posición X")).toBeCloseTo(movedX, 3);
    await expect(page.getByLabel("nombre del mapa")).toHaveValue("UX editor");
    // Guardar de nuevo deja de ser borrador local.
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("editor-notice")).toContainText(`${mapId} v1`);
    await page.reload();
    await expect(page.getByTestId("editor-current")).toHaveText(`${mapId} v1`);
    await expect(page.getByTestId("editor-restored")).toHaveCount(0);
    await page
      .getByTestId("editor-objects")
      .getByRole("button", { name: /^Muro 1/ })
      .click();
    expect(await value(page, "Posición X")).toBeCloseTo(movedX, 3);
    expect(problems).toEqual([]);
  });

  test("OLD_MAP_REGRESSION: mvp-arena-01, procedural y formato antiguo en px abren y guardan sin cambiar", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const problems = watchProblems(page);
    // Generar un procedural exige rol organizer: se usa el organizador de la semilla de
    // desarrollo de la BD efímera (credenciales por entorno, no en el repo).
    const email = process.env.S9_E2E_DEV_EMAIL!;
    const password = process.env.S9_E2E_DEV_PASSWORD!;
    await login(page, email, password);
    // El panel guarda el token en memoria (no en cookie): las lecturas directas de la
    // API van con su propio Bearer para ver los borradores del usuario.
    const lr = await page.request.post("/api/v1/auth/login", { data: { email, password } });
    expect(lr.status()).toBe(200);
    const auth = { Authorization: `Bearer ${((await lr.json()) as { accessToken: string }).accessToken}` };
    const getJson = async (path: string) => {
      const res = await page.request.get(`/api/v1${path}`, { headers: auth });
      expect(res.status(), `${path}: ${await res.text()}`).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };
    const stamp = Date.now().toString(36);
    const strip = (m: Record<string, unknown>) => {
      const { checksum: _c, version: _v, ...rest } = m;
      return rest;
    };

    // 1) mvp-arena-01 de producción (API) importado, guardado con otro id y releído.
    const r = await page.request.get("/api/v1/maps/mvp-arena-01/versions/1/content");
    expect(r.status()).toBe(200);
    const raw = (await r.json()) as Record<string, unknown>;
    const mvp = ((raw as { content?: unknown }).content ?? raw) as Record<string, unknown>;
    await go(page, "#/maps/editor");
    await openAdvancedAndImport(page, JSON.stringify(mvp));
    await expect(objects(page, "wall")).toHaveCount(3);
    await expect(page.getByTestId("editor-base-effective")).toHaveCount(2);
    await expect(page.getByTestId("editor-validation-ok")).toBeVisible();
    const id1 = `uxed-mvp-${stamp}`;
    await page.getByLabel("id del mapa").fill(id1);
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("editor-notice")).toContainText(`${id1} v1`);
    const back = await getJson(`/maps/${id1}/versions/1/content`);
    expect(strip(back)).toEqual(strip({ ...mvp, mapId: id1 }));

    // 2) Procedural generado por la API: abrir en el editor y guardar SIN tocar.
    const gen = await page.request.post("/api/v1/maps/generate", {
      headers: auth,
      data: { seed: `uxed-${stamp}`, params: { widthM: 40, heightM: 40, modes: ["deathmatch"] } },
    });
    expect(gen.status(), await gen.text()).toBe(201);
    const g = (await gen.json()) as { mapId: string; version: number };
    const before = await getJson(`/maps/${g.mapId}/versions/${g.version}/content`);
    await go(page, `#/maps/editor?map=${g.mapId}&v=${g.version}`);
    await page.reload();
    await expect(page.getByTestId("editor-current")).toHaveText(`${g.mapId} v${g.version}`);
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("editor-notice")).toContainText("Guardado en el servidor");
    const notice = (await page.getByTestId("editor-notice").textContent()) ?? "";
    const v2 = Number(/ v(\d+)/.exec(notice)![1]);
    const after = await getJson(`/maps/${g.mapId}/versions/${v2}/content`);
    expect(strip(after)).toEqual(strip(before));

    // 3) Formato de autoría antiguo (px, 10 px = 1 m).
    const legacy = {
      id: "patio-antiguo",
      name: "Patio antiguo",
      width: 800,
      height: 600,
      walls: [{ x: 400, y: 300, width: 40, height: 200 }],
      obstacles: [{ id: "caja-1", x: 200, y: 150, width: 20, height: 20 }],
      spawns: [
        { id: "s1", team: "red", x: 100, y: 300, heading: 0 },
        { id: "s2", team: "blue", x: 700, y: 300, heading: 3.14 },
      ],
    };
    await go(page, "#/maps/editor");
    await page.getByRole("button", { name: "Nuevo", exact: true }).click();
    await openAdvancedAndImport(page, JSON.stringify(legacy));
    await expect(page.getByLabel("Anchura del mapa")).toHaveValue("80");
    await expect(objects(page, "wall")).toHaveCount(1);
    await expect(objects(page, "destructible")).toHaveCount(1);
    await page
      .getByTestId("editor-objects")
      .getByRole("button", { name: /^Muro 1/ })
      .click();
    expect(await value(page, "Posición X")).toBe(40);
    expect(await value(page, "Altura")).toBe(20);
    const id3 = `uxed-px-${stamp}`;
    await page.getByLabel("id del mapa").fill(id3);
    await page.getByTestId("editor-save").click();
    await expect(page.getByTestId("editor-notice")).toContainText(`${id3} v1`);
    expect(problems).toEqual([]);
  });

  test("capturas en 5 viewports sin desbordamiento horizontal; táctil en móvil", async ({ browser }) => {
    test.setTimeout(180_000);
    const ctx0 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page0 = await ctx0.newPage();
    const { email, password } = await registerNewUser(page0);
    const r = await page0.request.get("/api/v1/maps/mvp-arena-01/versions/1/content");
    const raw = (await r.json()) as Record<string, unknown>;
    const mvp = JSON.stringify((raw as { content?: unknown }).content ?? raw);
    await ctx0.close();
    const vps = [
      { name: "d1920", width: 1920, height: 1080, touch: false },
      { name: "d1366", width: 1366, height: 768, touch: false },
      { name: "t1024", width: 1024, height: 768, touch: true },
      { name: "m430", width: 430, height: 932, touch: true },
      { name: "m360", width: 360, height: 800, touch: true },
    ];
    for (const vp of vps) {
      const ctx = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: vp.width, height: vp.height },
        hasTouch: vp.touch,
        isMobile: vp.touch && vp.width < 500,
      });
      const page = await ctx.newPage();
      const problems = watchProblems(page);
      await login(page, email, password);
      await go(page, "#/maps/editor");
      await expect(page.getByTestId("editor-canvas")).toBeVisible();
      await openAdvancedAndImport(page, mvp);
      await page.getByText("Opciones avanzadas: archivo JSON del mapa").click(); // se vuelve a plegar
      // Táctil: tocar la paleta y luego el mapa coloca el objeto (puntero «touch»).
      await palette(page, "Caja").click();
      const p = await toPage(page, 40, 60);
      if (vp.touch) await page.touchscreen.tap(p.x, p.y);
      else await page.mouse.click(p.x, p.y);
      await expect(objects(page, "destructible")).toHaveCount(5);
      const box = (await page.getByTestId("editor-canvas").boundingBox())!;
      expect(box.width).toBeGreaterThan(Math.min(vp.width - 40, 300));
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${vp.name}: desbordamiento horizontal`).toBeLessThanOrEqual(1);
      await page.getByTestId("editor-stage").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${process.env.S9_E2E_OUT ?? "/out"}/shots/editor-${vp.name}.png`,
        fullPage: false,
      });
      await page.screenshot({
        path: `${process.env.S9_E2E_OUT ?? "/out"}/shots/editor-${vp.name}-full.png`,
        fullPage: true,
      });
      expect(problems).toEqual([]);
      await ctx.close();
    }
  });
});
