/**
 * EQ5b · Administración → Streaming en navegador REAL.
 *
 * Dos bloques:
 *  - `@fase1`: en el entorno canónico de tests/browser/run.sh (API real, SIN
 *    streamer ni almacén sellado): RBAC visible (admin la ve; un usuario normal no
 *    y la API le dice que no), estados de la pantalla, botón «Retransmitir» que
 *    sólo PRESELECCIONA (ninguna orden de arranque), axe y móvil sin scroll lateral.
 *  - `@streaming-e2e`: la cadena REAL web → API → streamer (Chromium + Xvfb +
 *    FFmpeg + relé) → ingesta RTMPS local. NO lo lanza run.sh: lo orquesta
 *    tests/streaming-e2e/e2e.sh por pasos (entre paso y paso mide la ingesta, el
 *    argv de ffmpeg y las métricas desde fuera). La clave de PRUEBA llega por
 *    FICHERO (S9_STREAM_E2E_KEY_FILE), se teclea en la web y se comprueba que no
 *    vuelve: ni en respuestas de la API, ni en el DOM, ni en storage.
 */
import { readFileSync } from "node:fs";
import { test, expect, type Page, type Response, type TestInfo } from "@playwright/test";
import { login, registerNewUser, shot, REPLAY_ID } from "./helpers.js";
import { forbiddenLines, runAxe, visit } from "./ux-e-lib.js";

const ADMIN_EMAIL = "admin@dev.arena.local";
const PASSWORD = process.env.S9_E2E_DEV_PASSWORD ?? "";

async function blockingAxe(page: Page): Promise<string[]> {
  return (await runAxe(page))
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.join(" , ")}`);
}
async function hScroll(page: Page): Promise<number> {
  // Ronda 2 · con el armazón del CTA en móvil quien se desplaza es #root: se mide también.
  return page.evaluate(() =>
    Math.max(...[document.documentElement, document.getElementById("root")!].map((e) => e.scrollWidth - e.clientWidth)),
  );
}

const OUT_DIR = process.env.S9_E2E_OUT ?? "/out";
/**
 * Ronda 2 (MOBILE_CTA_NO_CONTENT_OVERLAP) · geometría del CTA fijo (INICIAR o DETENER) frente
 * a TODOS los controles visibles de la página (select, input, textarea, button, label, enlace,
 * summary), en la posición de scroll `frac` (0 = arriba, 1 = al fondo) del contenedor que se
 * desplaza. «Visible» = la parte del control que no recortan la ventana ni sus antecesores con
 * overflow ≠ visible. Un control cuenta si esa parte se cruza con la caja del CTA.
 */
async function ctaGeometry(page: Page, frac: number) {
  return page.evaluate((f) => {
    type R = { left: number; top: number; right: number; bottom: number };
    const cta = document.querySelector<HTMLElement>(".streaming-cta");
    if (!cta) throw new Error("no hay CTA");
    const root = document.getElementById("root")!;
    const rs = getComputedStyle(root).overflowY;
    const scroller =
      (rs === "auto" || rs === "scroll") && root.scrollHeight > root.clientHeight
        ? root
        : (document.scrollingElement as HTMLElement);
    scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) * f);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const box = (r: R) => ({ x: r.left, y: r.top, w: Math.max(0, r.right - r.left), h: Math.max(0, r.bottom - r.top) });
    const cut = (a: R, b: R): R => ({
      left: Math.max(a.left, b.left),
      top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom),
    });
    /** Parte visible: recortada por la ventana y por cada antecesor que recorta. */
    function visiblePart(el: Element): R {
      let r: R = cut(el.getBoundingClientRect(), { left: 0, top: 0, right: vw, bottom: vh });
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX !== "visible" || cs.overflowY !== "visible") r = cut(r, a.getBoundingClientRect());
      }
      return r;
    }
    const c = cta.getBoundingClientRect();
    const sel = "select, input:not([type=hidden]), textarea, button, label, a[href], summary";
    const controls = [...document.querySelectorAll(sel)].filter((el) => {
      if (cta === el || cta.contains(el)) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      const v = visiblePart(el);
      return v.right - v.left > 0.5 && v.bottom - v.top > 0.5;
    });
    const overlaps = controls
      .map((el) => {
        const v = cut(visiblePart(el), c);
        return { el, area: Math.max(0, v.right - v.left) * Math.max(0, v.bottom - v.top) };
      })
      .filter((o) => o.area > 0.5)
      .map(({ el, area }) => {
        const id = el.getAttribute("data-testid") ?? el.getAttribute("for") ?? el.textContent?.trim().slice(0, 30);
        return `${el.tagName.toLowerCase()}[${id}] ${Math.round(area)}px²`;
      });
    // El último control del contenido (orden de documento, fuera de los menús) y el campo Calidad.
    const content = controls.filter((el) => !el.closest("nav"));
    const last = content[content.length - 1];
    const quality = document.querySelector('[data-testid="simple-quality"]');
    const button = cta.matches("button") ? cta : cta.querySelector("button")!;
    const b = button.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    const scrollBottom = scroller === root ? root.getBoundingClientRect().bottom : vh;
    return {
      scroller: scroller === root ? "#root" : "document",
      scrollTop: scroller.scrollTop,
      maxScroll: scroller.scrollHeight - scroller.clientHeight,
      vw,
      vh,
      cta: box(c),
      button: box(b),
      buttonHit: !!hit && (hit === button || button.contains(hit)),
      /** Franja reservada bajo el área que se desplaza (≥ alto del CTA). */
      reserved: vh - scrollBottom,
      bodyPaddingBottom: parseFloat(getComputedStyle(document.body).paddingBottom),
      overlaps,
      last: last ? { what: last.tagName.toLowerCase(), ...box(last.getBoundingClientRect()) } : null,
      quality: quality ? box(quality.getBoundingClientRect()) : null,
    };
  }, frac);
}
function assertNoOverlap(g: Awaited<ReturnType<typeof ctaGeometry>>, where: string) {
  expect(g.overlaps, `${where}: controles bajo el CTA`).toEqual([]);
  // START/STOP alcanzables: enteros en la ventana, casi a lo ancho, ≥ 44 px y sin nada encima.
  expect(g.button.y, where).toBeGreaterThanOrEqual(0);
  expect(g.button.y + g.button.h, where).toBeLessThanOrEqual(g.vh + 0.5);
  expect(g.button.h, where).toBeGreaterThanOrEqual(44);
  expect(g.button.w, where).toBeGreaterThanOrEqual(g.vw * 0.8);
  expect(g.buttonHit, `${where}: el centro del botón es el botón`).toBe(true);
  // Franja reservada: el relleno inferior cubre el alto del CTA y nada se desplaza por ella.
  expect(g.bodyPaddingBottom, where).toBeGreaterThanOrEqual(g.cta.h - 0.5);
  expect(g.reserved, where).toBeGreaterThanOrEqual(g.cta.h - 0.5);
}
/** Arriba, en medio y al fondo (más dos intermedios); al fondo, el último campo entero encima. */
async function checkCtaAtScrollPoints(page: Page, info: TestInfo, tag: string) {
  const vp = page.viewportSize()!;
  for (const [name, frac] of [
    ["arriba", 0],
    ["25", 0.25],
    ["medio", 0.5],
    ["75", 0.75],
    ["fondo", 1],
  ] as const) {
    const g = await ctaGeometry(page, frac);
    const where = `${tag} ${vp.width}x${vp.height} ${name} (scroll ${g.scrollTop}/${g.maxScroll}, ${g.scroller})`;
    assertNoOverlap(g, where);
    if (name === "fondo") {
      expect(g.last, where).not.toBeNull();
      expect(g.last!.y + g.last!.h, `${where}: último control encima del CTA`).toBeLessThanOrEqual(g.cta.y + 0.5);
      if (g.quality) expect(g.quality.y + g.quality.h, `${where}: Calidad`).toBeLessThanOrEqual(g.cta.y + 0.5);
      await info.attach(`r2-cta-${tag}-${vp.width}x${vp.height}`, {
        body: JSON.stringify(g, null, 2),
        contentType: "application/json",
      });
    }
    if (name !== "25" && name !== "75") {
      await page.screenshot({ path: `${OUT_DIR}/shots/r2-cta-${tag}-${vp.width}x${vp.height}-${name}.png` });
    }
  }
}
/** Ronda 1 (LEFT_ALIGNED_NAV) · geometría real del menú de Streaming. */
async function navGeometry(page: Page) {
  return page.getByTestId("streaming-nav").evaluate((nav) => {
    const n = nav.getBoundingClientRect();
    const cs = getComputedStyle(nav);
    const buttons = [...nav.querySelectorAll("button")].map((b) => {
      const r = b.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(b);
      const t = range.getBoundingClientRect();
      const pl = parseFloat(getComputedStyle(b).paddingLeft);
      return { x: r.x, y: r.y, w: r.width, textOffset: t.x - r.x - pl };
    });
    return {
      x: n.x,
      w: n.width,
      flexWrap: cs.flexWrap,
      overflowX: cs.overflowX,
      scrollW: nav.scrollWidth,
      clientW: nav.clientWidth,
      buttons,
    };
  });
}

test.describe("@fase1 EQ5b Administración → Streaming", () => {
  test("admin: subnavegación, estado sin streamer, axe y móvil", async ({ page }, info) => {
    const starts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/admin/streaming/start")) starts.push(r.url());
    });
    await login(page, ADMIN_EMAIL, PASSWORD);
    await visit(page, "#/audit");
    const sub = page.getByRole("navigation", { name: "Administración" });
    await sub.getByRole("link", { name: "Streaming" }).click();
    await expect(page.getByRole("heading", { name: "Streaming", exact: true })).toBeVisible();
    // Recién migrado: desactivado; sin almacén sellado en este entorno.
    await expect(page.getByTestId("streaming-ux-state")).toHaveText("Desactivado");
    await expect(page.getByTestId("sealed-store-missing")).toBeVisible();
    await expect(page.getByTestId("stream-start")).toBeDisabled();
    expect(await blockingAxe(page)).toEqual([]);
    // Ronda 1 (LEFT_ALIGNED_NAV) · escritorio: cada botón ocupa la columna entera, pegado a
    // su borde izquierdo, y el texto empieza a la izquierda (no centrado).
    const desk = await navGeometry(page);
    expect(desk.buttons).toHaveLength(4);
    for (const b of desk.buttons) {
      expect(Math.abs(b.x - desk.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(b.w - desk.w)).toBeLessThanOrEqual(1);
      expect(Math.abs(b.textOffset)).toBeLessThanOrEqual(2);
    }
    await shot(page, info, "eq5b-streaming-1366");
    // STREAMING-UX · la clave vive en «Configuración avanzada».
    await page.getByTestId("streaming-tab-advanced").click();
    await expect(page.getByTestId("credential-youtube-input")).toBeDisabled();
    expect(await blockingAxe(page)).toEqual([]);
    await page.getByTestId("streaming-tab-streaming").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page, "#/streaming");
    await expect(page.getByTestId("streaming-page")).toBeVisible();
    expect(await hScroll(page)).toBeLessThanOrEqual(1);
    // Ronda 1 (LEFT_ALIGNED_NAV) · móvil: pestañas en UNA fila con scroll horizontal propio.
    const mob = await navGeometry(page);
    expect(new Set(mob.buttons.map((b) => Math.round(b.y))).size).toBe(1);
    expect(mob.flexWrap).toBe("nowrap");
    expect(mob.overflowX).toBe("auto");
    // Ronda 1 (P3) · INICIAR dentro de la ventana sin desplazarse (fijo abajo).
    const startBox = await page.getByTestId("stream-start").boundingBox();
    expect(startBox).not.toBeNull();
    expect(startBox!.y + startBox!.height).toBeLessThanOrEqual(844 + 1);
    expect(await blockingAxe(page)).toEqual([]);
    await shot(page, info, "eq5b-streaming-390");
    expect(starts).toEqual([]);
  });

  test("Ronda 2 · MOBILE_CTA_NO_CONTENT_OVERLAP: INICIAR/DETENER fijos no tapan ningún control", async ({
    page,
  }, info) => {
    const starts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/admin/streaming/start")) starts.push(r.url());
    });
    await login(page, ADMIN_EMAIL, PASSWORD);
    // 360×640 y 390×844 (estrechos) y 390×664 (barra inferior del navegador: ventana más baja).
    for (const vp of [
      { width: 360, height: 640 },
      { width: 390, height: 844 },
      { width: 390, height: 664 },
    ]) {
      await page.setViewportSize(vp);
      await visit(page, "#/streaming");
      await expect(page.getByTestId("stream-start")).toBeVisible();
      expect(await hScroll(page)).toBeLessThanOrEqual(1);
      await checkCtaAtScrollPoints(page, info, "iniciar");
    }
    // DETENER · sesión EN DIRECTO SIMULADA, sólo para la geometría (este entorno no tiene
    // streamer): se reescribe la respuesta real de GET /admin/streaming con una sesión activa.
    const STATE_URL = /\/api\/v1\/admin\/streaming$/;
    await page.route(STATE_URL, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const res = await route.fetch();
      const st = await res.json();
      await route.fulfill({
        response: res,
        json: {
          ...st,
          uxState: "live",
          pendingRestart: true,
          session: {
            id: "r2-geom",
            mode: "rtmps",
            target: { kind: "battle", id: "00000000-0000-4000-8000-000000000000" },
            startedAt: new Date().toISOString(),
          },
          streamer: { state: "streaming", desired: true, lastError: null, restarts: 0 },
        },
      });
    });
    for (const vp of [
      { width: 360, height: 640 },
      { width: 390, height: 664 },
    ]) {
      await page.setViewportSize(vp);
      await visit(page, "#/audit");
      await visit(page, "#/streaming");
      await expect(page.getByTestId("stream-stop")).toBeVisible();
      await expect(page.getByTestId("stream-restart")).toBeVisible();
      await checkCtaAtScrollPoints(page, info, "detener");
    }
    await page.unroute(STATE_URL);
    // Escritorio: el armazón no cambia nada (la página se desplaza como siempre).
    await page.setViewportSize({ width: 1280, height: 900 });
    await visit(page, "#/audit");
    await visit(page, "#/streaming");
    await expect(page.getByTestId("stream-start")).toBeVisible();
    const desk = await page.evaluate(() => [
      getComputedStyle(document.body).paddingBottom,
      getComputedStyle(document.getElementById("root")!).overflowY,
      getComputedStyle(document.querySelector(".streaming-cta")!).position,
    ]);
    expect(desk).toEqual(["0px", "visible", "static"]);
    expect(starts).toEqual([]);
  });

  test("«Retransmitir» en una batalla preselecciona el destino y NO arranca nada", async ({ page }, info) => {
    test.skip(!REPLAY_ID, "sin batalla sembrada en este entorno");
    const starts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/admin/streaming/")) starts.push(r.url());
    });
    await login(page, ADMIN_EMAIL, PASSWORD);
    await visit(page, `#/battles/${REPLAY_ID}`);
    await page.getByTestId("broadcast-battle").click();
    await expect(page).toHaveURL(new RegExp(`#/streaming\\?battle=${REPLAY_ID}`));
    // STREAMING-UX · preseleccionada en el selector de la vista simple (sin UUID a la vista)…
    await expect(page.getByTestId("simple-destination")).toHaveValue(`battle:${REPLAY_ID}`);
    await expect(page.getByTestId("stream-target-info")).toBeVisible();
    await shot(page, info, "eq5b-retransmitir");
    // …y el destino manual de «Avanzada» la comprueba con su retardo.
    await page.getByTestId("streaming-tab-advanced").click();
    await expect(page.getByTestId("stream-target-id")).toHaveValue(REPLAY_ID);
    await expect(page.getByTestId("stream-delay")).toContainText("Retardo del directo");
    expect(starts).toEqual([]);
  });

  test("usuario normal: ni enlace ni botón, y la API responde «sin permiso»", async ({ page }) => {
    await registerNewUser(page);
    await visit(page, "#/streaming");
    await expect(page.getByTestId("error-forbidden-hint")).toBeVisible();
    expect(forbiddenLines(await page.locator("body").innerText())).toEqual([]);
    await expect(page.getByRole("navigation", { name: "Administración" })).toHaveCount(0);
    if (REPLAY_ID) {
      await visit(page, `#/battles/${REPLAY_ID}`);
      await expect(page.getByTestId("broadcast-battle")).toHaveCount(0);
    }
  });
});

// ─────────────────────────────────────────────────────────── cadena real (§23)
const KEY_FILE = process.env.S9_STREAM_E2E_KEY_FILE ?? "";
const BATTLE = process.env.S9_STREAM_E2E_BATTLE ?? "";
const INGEST = process.env.S9_STREAM_E2E_INGEST ?? "";
const BITRATE = Number(process.env.S9_STREAM_E2E_BITRATE ?? "3000");

/** Ninguna respuesta de la API vista por el navegador contiene la clave. */
function watchKey(page: Page, key: string): string[] {
  const leaks: string[] = [];
  page.on("response", async (r: Response) => {
    if (!r.url().includes("/api/")) return;
    try {
      if ((await r.text()).includes(key)) leaks.push(r.url());
    } catch {
      /* respuesta sin cuerpo */
    }
  });
  return leaks;
}

async function streaming(page: Page, hash = "#/streaming") {
  await login(page, ADMIN_EMAIL, PASSWORD);
  await visit(page, hash);
  await expect(page.getByTestId("streaming-page")).toBeVisible();
}

async function saveSettings(page: Page) {
  await page.getByTestId("set-save").click();
  await expect(page.getByTestId("streaming-notice")).toContainText(/Guardado|Sin cambios/);
}

/**
 * STREAMING-UX · UUID_NOT_REQUIRED · elige en el selector la batalla EN CURSO por su
 * TEXTO visible («… · En curso · …»), como lo haría una persona: nada se teclea.
 */
async function pickLiveBattle(page: Page): Promise<string> {
  const sel = page.getByTestId("simple-destination");
  await expect(sel.locator("option", { hasText: "En curso" }).first()).toBeAttached({ timeout: 15_000 });
  const label = (await sel.locator("option", { hasText: "En curso" }).first().textContent())!.trim();
  await sel.selectOption({ label });
  await expect(page.getByTestId("simple-broadcastable")).toContainText("Retransmisible");
  return label;
}

/** STOP_ALWAYS_VISIBLE · «Detener» entero dentro de la ventana, sin desplazarse. */
async function stopInViewport(page: Page): Promise<boolean> {
  const box = await page.getByTestId("stream-stop").boundingBox();
  const vp = page.viewportSize()!;
  return !!box && box.y >= 0 && box.x >= 0 && box.y + box.height <= vp.height && box.x + box.width <= vp.width;
}

test.describe("@streaming-e2e EQ5b cadena real", () => {
  test.skip(!KEY_FILE, "sólo con tests/streaming-e2e/e2e.sh");

  test("@streaming-e2e-config credencial (no vuelve), RTMPS personalizado y bitrate desde la web", async ({ page }) => {
    const key = readFileSync(KEY_FILE, "utf8").trim();
    const leaks = watchKey(page, key);
    await streaming(page, "#/streaming?tab=advanced");
    await page.getByTestId("set-enabled").check();
    await page.getByTestId("set-mode").selectOption("rtmps");
    await page.getByTestId("set-platform").selectOption("custom");
    await page.getByTestId("set-ingest").fill(INGEST);
    await page.getByTestId("set-bitrate").fill(String(BITRATE));
    await saveSettings(page);
    await page.getByTestId("credential-custom-input").fill(key);
    await page.getByTestId("credential-custom").getByRole("button", { name: "Guardar clave" }).click();
    await expect(page.getByTestId("credential-custom-state")).toContainText(`Configurada · ****${key.slice(-4)}`);
    await expect(page.getByTestId("credential-custom-input")).toHaveValue("");
    // YOUTUBE_WEB_CONFIGURATION · se reabre la página y lo guardado sigue ahí; la clave, nunca.
    await page.reload();
    await page.getByTestId("streaming-tab-advanced").click();
    await expect(page.getByTestId("ing-primary")).toHaveValue(INGEST);
    await expect(page.getByTestId("credential-custom-state")).toContainText(`****${key.slice(-4)}`);
    expect(await page.content()).not.toContain(key);
    const storage = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    expect(storage).not.toContain(key);
    expect(leaks).toEqual([]);
  });

  test("@streaming-e2e-test probar ingesta (sin emitir)", async ({ page }) => {
    await streaming(page, "#/streaming?tab=advanced");
    await page.getByTestId("stream-test").click();
    await expect(page.getByTestId("streaming-notice")).toContainText("Prueba correcta");
    await expect(page.getByTestId("ingest-test-primary")).toContainText("Principal: OK");
  });

  test("@streaming-e2e-start iniciar desde la web SIN escribir ningún UUID: EN DIRECTO", async ({ page }, info) => {
    const key = readFileSync(KEY_FILE, "utf8").trim();
    const leaks = watchKey(page, key);
    // Streaming → batalla (por su nombre) → canal → INICIAR. Ni la URL lleva el destino.
    await streaming(page, "#/streaming");
    await pickLiveBattle(page);
    await expect(page.getByTestId("simple-channel")).toHaveValue("platform:custom");
    await page.getByTestId("stream-start").click();
    await expect(page.getByTestId("streaming-ux-state")).toHaveText("En directo", { timeout: 30_000 });
    await expect(page.getByTestId("live-badge")).toContainText("EN DIRECTO");
    // ffmpeg informa sus primeros FPS al cabo de unos segundos de publicar (Chromium arrancando).
    await expect(page.getByTestId("mon-rate")).toContainText(/\b(2[5-9]|30)(\.\d+)? fps/, { timeout: 60_000 });
    await expect(page.getByTestId("active-ingest")).toHaveText("Principal");
    await shot(page, info, "eq5b-e2e-en-directo");
    expect(await page.content()).not.toContain(key);
    expect(leaks).toEqual([]);
  });

  test("@streaming-e2e-liveux STOP siempre visible en escritorio y en móvil, sin scroll lateral", async ({
    page,
  }, info) => {
    await streaming(page, "#/streaming");
    await expect(page.getByTestId("live-badge")).toContainText("EN DIRECTO", { timeout: 30_000 });
    await page.setViewportSize({ width: 1366, height: 768 });
    expect(await stopInViewport(page)).toBe(true);
    await page.screenshot({ path: `/out/${process.env.PW_STEP}/live-1366.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await visit(page, "#/streaming");
    await expect(page.getByTestId("live-badge")).toContainText("EN DIRECTO");
    expect(await stopInViewport(page)).toBe(true);
    expect(await hScroll(page)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/out/${process.env.PW_STEP}/live-390.png` });
    // Bajando, la barra con DETENER sigue arriba (sticky).
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(300);
    expect(await stopInViewport(page)).toBe(true);
    await shot(page, info, "streaming-ux-live-390");
  });

  test("@streaming-e2e-restart cambiar bitrate con emisión activa: aviso y «Reiniciar»", async ({ page }) => {
    await streaming(page, "#/streaming?tab=advanced");
    await page.getByTestId("set-bitrate").fill(String(BITRATE - 500));
    await saveSettings(page);
    await expect(page.getByTestId("pending-restart")).toBeVisible();
    await page.getByTestId("streaming-tab-streaming").click();
    await page.getByTestId("stream-restart").click();
    await expect(page.getByTestId("pending-restart")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("streaming-ux-state")).toHaveText("En directo", { timeout: 30_000 });
  });

  test("@streaming-e2e-stop detener desde la web", async ({ page }) => {
    await streaming(page);
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("stream-stop").click();
    await expect(page.getByTestId("streaming-ux-state")).toHaveText("Listo", { timeout: 15_000 });
    await expect(page.getByTestId("stream-start")).toBeVisible();
  });

  test("@streaming-e2e-record grabar desde la web", async ({ page }) => {
    await streaming(page, "#/streaming?tab=advanced");
    await page.getByTestId("set-mode").selectOption("record");
    await saveSettings(page);
    await page.getByTestId("streaming-tab-streaming").click();
    await pickLiveBattle(page);
    await page.getByTestId("stream-start").click();
    await expect(page.getByTestId("streaming-ux-state")).toHaveText("Grabando", { timeout: 30_000 });
    await page.waitForTimeout(15_000);
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("stream-stop").click();
    await expect(page.getByTestId("streaming-ux-state")).toHaveText("Listo", { timeout: 15_000 });
  });

  test("@streaming-e2e-retention retención 7 días aplicada desde la web y auditada", async ({ page }, info) => {
    await streaming(page, "#/streaming?tab=recordings");
    await page.getByTestId("ret-age").selectOption("7");
    await page.getByTestId("ret-save").click();
    await expect(page.getByTestId("streaming-notice")).toContainText("Retención guardada");
    page.once("dialog", (d) => void d.accept());
    await page.getByTestId("ret-apply").click();
    await expect(page.getByTestId("streaming-notice")).toContainText(/Retención aplicada: [1-9]\d* grabaciones/);
    await page.getByTestId("streaming-tab-audit").click();
    await expect(page.getByTestId("streaming-audit")).toContainText("streaming.recording.deleted");
    await shot(page, info, "eq5b-e2e-retencion");
  });
});
