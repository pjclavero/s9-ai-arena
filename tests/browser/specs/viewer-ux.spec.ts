/**
 * UX-VIEW · Visor/replay en navegador REAL (stack de run.sh, sin mocks):
 * bloques A (escenario principal, zoom, pan, cámara), B (vida y etiquetas),
 * C (minimapa FUERA del escenario) y D (móvil/tablet: táctil, pinch, sin
 * desbordamiento), con capturas en los viewports del bloque H.
 *
 *  - @golden: sobre el replay 4v4 REAL que acaba de crear team-battle-4v4.spec
 *    (8 bots que combaten), leído de /out/review/team-4v4.json.
 *  - @fase1: regresión 1v1 sobre el replay del golden path (S9_E2E_REPLAY_ID).
 *
 * Se entra como el usuario semilla de staff: puede ver cualquier replay.
 * Capturas en /out/shots/view-*.png (run.sh las deja en $STATE/out/shots).
 */
import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { OUT, REPLAY_ID, go, login, watchProblems } from "./helpers.js";

const STAFF = { email: process.env.S9_E2E_DEV_EMAIL ?? "", password: process.env.S9_E2E_DEV_PASSWORD ?? "" };

/** Viewports del bloque H (+ tablet vertical del bloque D). */
const VIEWPORTS = [
  { name: "d1920", width: 1920, height: 1080 },
  { name: "d1366", width: 1366, height: 768 },
  { name: "t1024", width: 1024, height: 768 },
  { name: "t768", width: 768, height: 1024 },
  { name: "m430", width: 430, height: 932 },
  { name: "m360", width: 360, height: 800 },
] as const;

function battle4v4(): string {
  if (process.env.S9_E2E_UX_BATTLE) return process.env.S9_E2E_UX_BATTLE;
  const f = `${OUT}/review/team-4v4.json`;
  if (!existsSync(f)) return "";
  return (JSON.parse(readFileSync(f, "utf8")) as { battleId?: string }).battleId ?? "";
}

const canvasOf = (page: Page) => page.getByTestId("replay-canvas-host").locator("canvas");
const pct = async (page: Page) => Number(await page.getByTestId("zoom-level").getAttribute("data-percent"));
const mode = async (page: Page) => (await page.getByTestId("camera-mode").getAttribute("data-mode")) ?? "";
const mini = (page: Page) => page.getByTestId("minimap-canvas");
const miniAttr = async (page: Page, k: string) => (await mini(page).getAttribute(`data-${k}`)) ?? "";

async function shotTo(page: Page, name: string) {
  await page.screenshot({ path: `${OUT}/shots/${name}.png`, fullPage: true });
}

async function openReplay(page: Page, id: string) {
  await go(page, `#/replay/${encodeURIComponent(id)}?t=0`);
  await expect(page.getByTestId("replay-status")).toHaveAttribute("data-state", /playing|paused|finished/, {
    timeout: 30_000,
  });
  await expect(canvasOf(page)).toHaveCount(1);
  // La escena ya pintó al menos un encuadre (el % de zoom viene de la cámara real).
  await expect.poll(() => pct(page), { timeout: 15_000 }).toBeGreaterThan(0);
}

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b, "elemento sin caja").not.toBeNull();
  return b!;
}

function overlap(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function noHorizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function ensureMinimapOpen(page: Page) {
  const t = page.getByTestId("minimap-toggle");
  if ((await t.getAttribute("aria-expanded")) !== "true") await t.click();
  await expect(mini(page)).toBeVisible();
}

/** Comprobaciones de escritorio: zoom, pan, límites, cámara, teclado y minimapa. */
async function desktopChecks(page: Page, expectedBots: number) {
  const canvas = canvasOf(page);
  const vp = page.viewportSize()!;

  // A1 · el escenario es el elemento principal: ancho y alto dominantes, visible sin scroll.
  const cb = await box(canvas);
  expect(cb.width, "ancho del escenario").toBeGreaterThanOrEqual(vp.width * 0.6);
  expect(cb.height, "alto del escenario").toBeGreaterThanOrEqual(vp.height * 0.5);
  expect(cb.y, "el escenario empieza en la mitad superior").toBeLessThan(vp.height * 0.45);

  // C · minimapa FUERA del escenario, con todos los bots.
  await ensureMinimapOpen(page);
  expect(overlap(cb, await box(mini(page))), "el minimapa no tapa el escenario").toBe(false);
  await expect.poll(() => miniAttr(page, "dots")).toBe(String(expectedBots));
  // Vista completa: los N bots dentro de la vista de la cámara.
  await page.getByRole("button", { name: "Encajar mapa" }).click();
  await expect.poll(() => mode(page)).toBe("global");
  await expect.poll(() => miniAttr(page, "in-view")).toBe(String(expectedBots));
  const fit = await pct(page);

  // A2 · rueda sobre el escenario: zoom hacia el cursor, SIN scroll de la página.
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.5);
  await page.mouse.wheel(0, -300);
  await expect.poll(() => pct(page)).toBeGreaterThan(fit);
  expect(await page.evaluate(() => window.scrollY), "la rueda no hace scroll de la página").toBe(scrollBefore);
  await expect.poll(() => mode(page)).toBe("manual");
  await expect(page.getByTestId("camera-mode")).toContainText("libre");

  // BUG de cámara: con el replay avanzando, el zoom manual NO se pierde.
  const zoomed = await pct(page);
  const tickEl = page.getByTestId("replay-tick");
  const t0 = Number(await tickEl.getAttribute("data-tick"));
  if ((await page.getByTestId("replay-status").getAttribute("data-state")) === "playing") {
    await expect
      .poll(async () => Number(await tickEl.getAttribute("data-tick")), { timeout: 15_000 })
      .toBeGreaterThan(t0 + 20);
  }
  expect(await mode(page)).toBe("manual");
  expect(await pct(page)).toBe(zoomed);

  // A3 · pan con clic y arrastre: el rectángulo de vista del minimapa se mueve.
  const v0 = await miniAttr(page, "view");
  await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cb.x + cb.width * 0.5 + 25 * i, cb.y + cb.height * 0.5 + 12 * i);
  await page.mouse.up();
  await expect.poll(() => miniAttr(page, "view")).not.toBe(v0);
  // Arrastrar no selecciona texto de la página.
  expect(await page.evaluate(() => String(window.getSelection() ?? ""))).toBe("");

  // A2 · límites: alejar del todo → nunca menos que el mínimo y con los N bots a la vista.
  const minus = page.getByRole("button", { name: "Alejar" });
  for (let i = 0; i < 25; i++) await minus.click();
  await expect.poll(() => miniAttr(page, "in-view"), { timeout: 10_000 }).toBe(String(expectedBots));
  const minPct = await pct(page);
  expect(minPct).toBeGreaterThan(0);
  expect(minPct).toBeLessThanOrEqual(Math.max(fit, 100));
  const plus = page.getByRole("button", { name: "Acercar" });
  for (let i = 0; i < 25; i++) await plus.click();
  await expect.poll(() => pct(page), { timeout: 10_000 }).toBe(600);
  // «100 %» y «Encajar mapa».
  await page.getByRole("button", { name: "100 %" }).click();
  await expect.poll(() => pct(page), { timeout: 10_000 }).toBe(100);
  await page.getByRole("button", { name: "Encajar mapa" }).click();
  await expect.poll(() => mode(page)).toBe("global");
  await expect.poll(() => pct(page), { timeout: 10_000 }).toBe(fit);

  // A4 · seguimiento, cambio de bot y «Centrar seleccionado».
  const rows = page.getByTestId("bot-row");
  await expect(rows).toHaveCount(expectedBots);
  const first = rows.first().getByRole("button");
  await first.click();
  await expect.poll(() => mode(page)).toBe("follow");
  await expect(page.getByTestId("camera-mode")).toContainText("siguiendo a");
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await rows.nth(1).getByRole("button").click();
  await expect(rows.nth(1).getByRole("button")).toHaveAttribute("aria-pressed", "true");
  const center = page.getByRole("button", { name: "Centrar seleccionado" });
  await expect(center).toBeEnabled();
  await center.click();
  await expect.poll(() => mode(page)).toBe("manual");

  // Teclado SÓLO con el foco en el escenario: en un botón, «1» no mueve la cámara.
  await page.getByRole("button", { name: "Vista global" }).click();
  await expect.poll(() => mode(page)).toBe("global");
  await page.getByRole("button", { name: "Vista global" }).focus();
  await page.keyboard.press("1");
  expect(await mode(page)).toBe("global");
  await page.getByTestId("replay-canvas-host").focus();
  await page.keyboard.press("2");
  await expect.poll(() => mode(page)).toBe("follow");
  await page.keyboard.press("g");
  await expect.poll(() => mode(page)).toBe("global");

  // C · pulsar el minimapa centra la cámara ahí (cámara libre).
  await page.getByRole("button", { name: "Acercar" }).click();
  await page.getByRole("button", { name: "Acercar" }).click();
  const mb = await box(mini(page));
  await page.mouse.click(mb.x + mb.width * 0.15, mb.y + mb.height * 0.2);
  await expect.poll(() => mode(page)).toBe("manual");
  // Ocultar y mostrar el minimapa.
  await page.getByTestId("minimap-toggle").click();
  await expect(mini(page)).toHaveCount(0);
  await page.getByTestId("minimap-toggle").click();
  await expect(mini(page)).toBeVisible();
}

/** Capturas y comprobaciones por viewport (bloque H). */
async function viewportPass(page: Page, id: string, tag: string, expectedBots: number) {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.reload();
    await openReplay(page, id);
    // Foto estable: pausa y vista completa.
    const pause = page.getByRole("button", { name: "Pausa" });
    if (await pause.isVisible()) await pause.click();
    await ensureMinimapOpen(page);
    await expect.poll(() => miniAttr(page, "dots")).toBe(String(expectedBots));
    const cb = await box(canvasOf(page));
    expect(overlap(cb, await box(mini(page))), `${vp.name}: minimapa fuera del escenario`).toBe(false);
    expect(cb.width, `${vp.name}: el escenario usa el ancho`).toBeGreaterThanOrEqual(
      vp.width * (vp.width >= 1100 ? 0.6 : 0.85),
    );
    expect.soft(await noHorizontalOverflow(page), `${vp.name}: sin scroll horizontal`).toBeLessThanOrEqual(1);
    // Controles alcanzables y de tamaño táctil en móvil.
    for (const name of ["Acercar", "Alejar", "Encajar mapa"]) {
      const b = await box(page.getByRole("button", { name }));
      expect(b.x + b.width, `${vp.name}: «${name}» dentro de la pantalla`).toBeLessThanOrEqual(vp.width + 1);
    }
    await page.getByRole("button", { name: "Encajar mapa" }).click();
    await expect.poll(() => miniAttr(page, "in-view")).toBe(String(expectedBots));
    await shotTo(page, `view-${tag}-${vp.name}-replay`);
    // Con zoom: barras de vida y nombres sobre los bots (no tapan el escenario).
    await page.getByRole("button", { name: "Seguir", exact: false }).first().click();
    await expect.poll(() => mode(page)).toBe("follow");
    const followPct = await pct(page);
    await page.getByRole("button", { name: "Acercar" }).click();
    await expect.poll(() => pct(page)).toBeGreaterThan(followPct);
    await shotTo(page, `view-${tag}-${vp.name}-zoom`);
  }
}

/** Móvil real con táctil: pan de un dedo y pinch (CDP de Chromium, gestos de verdad). */
async function touchChecks(browser: Browser, id: string, tag: string, expectedBots: number) {
  const ctx = await browser.newContext({
    baseURL: process.env.S9_E2E_BASE,
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const problems = watchProblems(page);
  try {
    await login(page, STAFF.email, STAFF.password);
    await openReplay(page, id);
    const pause = page.getByRole("button", { name: "Pausa" });
    if (await pause.isVisible()) await pause.click();
    await ensureMinimapOpen(page);
    await expect.poll(() => miniAttr(page, "dots")).toBe(String(expectedBots));
    expect(await noHorizontalOverflow(page)).toBeLessThanOrEqual(1);
    const canvas = canvasOf(page);
    await canvas.scrollIntoViewIfNeeded();
    const cb = await box(canvas);
    const cx = cb.x + cb.width / 2;
    const cy = cb.y + cb.height / 2;
    const cdp = await ctx.newCDPSession(page);
    const scroll0 = await page.evaluate(() => window.scrollY);
    const p0 = await pct(page);

    // Pinch: dos dedos que se separan → acerca.
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: cx - 30, y: cy, id: 1 },
        { x: cx + 30, y: cy, id: 2 },
      ],
    });
    for (let i = 1; i <= 10; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: cx - 30 - 8 * i, y: cy, id: 1 },
          { x: cx + 30 + 8 * i, y: cy, id: 2 },
        ],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => pct(page), { message: "el pinch acerca" }).toBeGreaterThan(p0 * 1.5);
    await expect.poll(() => mode(page)).toBe("manual");

    // Un dedo: pan del escenario (el rectángulo de vista se mueve) y la página NO hace scroll.
    const v0 = await miniAttr(page, "view");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy, id: 3 }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: cx - 10 * i, y: cy - 12 * i, id: 3 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => miniAttr(page, "view"), { message: "un dedo mueve la cámara" }).not.toBe(v0);
    expect(await page.evaluate(() => window.scrollY), "el gesto sobre el escenario no desplaza la página").toBe(
      scroll0,
    );

    // Fuera del escenario el scroll vertical sigue siendo el del navegador (gesto
    // táctil real sobre la cabecera de la página).
    // (El escenario se desplazó a la vista para el pinch: se vuelve arriba primero.)
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    const head = await box(page.getByTestId("replay-title"));
    const hx = Math.round(head.x + 20);
    const hy = Math.round(head.y + head.height / 2);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: hx, y: hy, id: 9 }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: hx, y: hy + 6 * i, id: 9 }] });
    }
    for (let i = 1; i <= 24; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: hx, y: Math.max(1, hy + 72 - 12 * i), id: 9 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // Control positivo INFORMATIVO: el scroll táctil emulado por CDP no siempre
    // desplaza la página en Chromium headless (run 40963564405: synthesizeScrollGesture
    // dejó scrollY=0). Se registra, no se usa como prueba de que el escenario no bloquee.
    const pageScroll = await page.evaluate(() => window.scrollY);
    test.info().annotations.push({
      type: "touch-page-scroll",
      description: `scrollY tras arrastrar la cabecera: ${pageScroll}`,
    });

    // Lo que SÍ es determinista: sólo el escenario y el minimapa capturan los gestos;
    // el resto de la página deja el scroll y el zoom del navegador como están.
    const touchActions = await page.evaluate(() => ({
      stage: getComputedStyle(document.querySelector('[data-testid="replay-canvas-host"]')!).touchAction,
      body: getComputedStyle(document.body).touchAction,
      main: getComputedStyle(document.querySelector("main")!).touchAction,
      side: getComputedStyle(document.querySelector(".s9v-side")!).touchAction,
    }));
    expect(touchActions).toEqual({ stage: "none", body: "auto", main: "auto", side: "auto" });

    // Botones táctiles de tamaño suficiente (≥ 40 px).
    for (const name of ["Acercar", "Alejar", "Encajar mapa", "Pausa", "Reproducir"]) {
      const b = page.getByRole("button", { name, exact: true });
      if ((await b.count()) === 0) continue;
      const bb = await box(b.first());
      expect(bb.height, `«${name}» táctil`).toBeGreaterThanOrEqual(40);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await shotTo(page, `view-${tag}-m390-touch`);
    expect(problems.filter((p) => !p.startsWith("console.error"))).toEqual([]);
  } finally {
    await ctx.close();
  }
}

test.describe("@golden UX-VIEW · replay 4v4", () => {
  test("escenario principal, zoom/pan/pinch, cámara visible y minimapa fuera del mapa, en 6 viewports", async ({
    page,
    browser,
  }) => {
    test.setTimeout(420_000);
    const id = battle4v4();
    expect(id, "team-battle-4v4.spec debe dejar /out/review/team-4v4.json").not.toBe("");
    const problems = watchProblems(page);
    await login(page, STAFF.email, STAFF.password);
    await openReplay(page, id);
    await desktopChecks(page, 8);
    await viewportPass(page, id, "4v4", 8);
    await touchChecks(browser, id, "4v4", 8);
    expect(problems.filter((p) => !p.startsWith("console.error"))).toEqual([]);
  });
});

test.describe("@fase1 UX-VIEW · replay 1v1 (regresión)", () => {
  test("1v1: mismo escenario, zoom, pan, cámara y minimapa con 2 bots", async ({ page }) => {
    test.setTimeout(240_000);
    expect(REPLAY_ID, "run.sh debe sembrar un replay (S9_E2E_REPLAY_ID)").not.toBe("");
    const problems = watchProblems(page);
    await login(page, STAFF.email, STAFF.password);
    await openReplay(page, REPLAY_ID);
    await desktopChecks(page, 2);
    for (const vp of [VIEWPORTS[0], VIEWPORTS[5]]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.reload();
      await openReplay(page, REPLAY_ID);
      await ensureMinimapOpen(page);
      expect(overlap(await box(canvasOf(page)), await box(mini(page)))).toBe(false);
      expect.soft(await noHorizontalOverflow(page)).toBeLessThanOrEqual(1);
      await shotTo(page, `view-1v1-${vp.name}-replay`);
    }
    expect(problems).toEqual([]);
  });
});
