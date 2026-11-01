/**
 * [UX-REVIEW] Pruebas de ROTURA del visor, del layout responsive y del editor de
 * mapas (bloques H e I del encargo UX 2026-10-29), sobre el stack real de run.sh.
 *
 * Diseño: casi todo con `expect.soft` y métricas volcadas a /out/review/review-ux-*.json,
 * para que una rotura no oculte las siguientes. Capturas en /out/shots/rev-*.png.
 * Batalla 4v4: la que deja team-battle-4v4.spec (/out/review/team-4v4.json);
 * 1v1: la del golden path (S9_E2E_REPLAY_ID).
 */
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { OUT, REPLAY_ID, go, login, registerNewUser, watchProblems } from "./helpers.js";

const STAFF = { email: process.env.S9_E2E_DEV_EMAIL ?? "", password: process.env.S9_E2E_DEV_PASSWORD ?? "" };
const VPS = [
  { name: "d1920", width: 1920, height: 1080, touch: false },
  { name: "d1366", width: 1366, height: 768, touch: false },
  { name: "t1024", width: 1024, height: 768, touch: true },
  { name: "m430", width: 430, height: 932, touch: true },
  { name: "m360", width: 360, height: 800, touch: true },
] as const;

function battle4v4(): string {
  if (process.env.S9_E2E_UX_BATTLE) return process.env.S9_E2E_UX_BATTLE;
  const f = `${OUT}/review/team-4v4.json`;
  if (!existsSync(f)) return "";
  return (JSON.parse(readFileSync(f, "utf8")) as { battleId?: string }).battleId ?? "";
}
function dump(name: string, data: unknown) {
  mkdirSync(`${OUT}/review`, { recursive: true });
  writeFileSync(`${OUT}/review/review-ux-${name}.json`, JSON.stringify(data, null, 2));
}
async function snap(page: Page, name: string, fullPage = false) {
  await page.screenshot({ path: `${OUT}/shots/rev-${name}.png`, fullPage });
}
async function ctxFor(browser: Browser, vp: (typeof VPS)[number]): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: process.env.S9_E2E_BASE,
    ignoreHTTPSErrors: true,
    viewport: { width: vp.width, height: vp.height },
    hasTouch: vp.touch,
    isMobile: vp.touch && vp.width < 500,
    deviceScaleFactor: vp.width < 500 ? 2 : 1,
  });
}

const canvasOf = (page: Page) => page.getByTestId("replay-canvas-host").locator("canvas");
const pct = async (page: Page) => Number(await page.getByTestId("zoom-level").getAttribute("data-percent"));
const mode = async (page: Page) => (await page.getByTestId("camera-mode").getAttribute("data-mode")) ?? "";
const mini = (page: Page) => page.getByTestId("minimap-canvas");
const miniAttr = async (page: Page, k: string) => (await mini(page).getAttribute(`data-${k}`)) ?? "";
const tickOf = async (page: Page) => Number(await page.getByTestId("replay-tick").getAttribute("data-tick"));
const overflowX = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function settled(page: Page) {
  let prev = -1;
  await expect
    .poll(
      async () => {
        const p = await pct(page);
        const same = p === prev;
        prev = p;
        return same;
      },
      { intervals: [400], timeout: 12_000 },
    )
    .toBe(true);
}
async function openReplay(page: Page, id: string, t = 0) {
  await go(page, `#/replay/${encodeURIComponent(id)}?t=${t}`);
  await expect(page.getByTestId("replay-status")).toHaveAttribute("data-state", /playing|paused|finished/, {
    timeout: 30_000,
  });
  await expect(canvasOf(page)).toHaveCount(1);
  await expect.poll(() => pct(page), { timeout: 15_000 }).toBeGreaterThan(0);
}
async function pause(page: Page) {
  const b = page.getByRole("button", { name: "Pausa", exact: true });
  if (await b.isVisible()) await b.click();
}
async function ensureMinimap(page: Page) {
  const t = page.getByTestId("minimap-toggle");
  if ((await t.getAttribute("aria-expanded")) !== "true") await t.click();
  await expect(mini(page)).toBeVisible();
}
type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Geometría del layout del replay en el viewport actual (sin scroll). */
async function layout(page: Page) {
  return page.evaluate(() => {
    const r = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        x: Math.round(b.x),
        y: Math.round(b.y + window.scrollY),
        w: Math.round(b.width),
        h: Math.round(b.height),
      };
    };
    const host = r('[data-testid="replay-canvas-host"]');
    const canvas = r('[data-testid="replay-canvas-host"] canvas');
    const c = document.querySelector('[data-testid="replay-canvas-host"] canvas') as HTMLCanvasElement | null;
    const btnH = [...document.querySelectorAll(".s9v-bar button")].map((b) =>
      Math.round(b.getBoundingClientRect().height),
    );
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      scrollH: document.documentElement.scrollHeight,
      nav: r("nav"),
      head: r(".s9v-head"),
      transport: r('[data-testid="replay-controls"]'),
      camera: r('[data-testid="replay-camera"]'),
      host,
      canvas,
      canvasBuffer: c ? { w: c.width, h: c.height } : null,
      minimap: r('[data-testid="minimap-canvas"]'),
      botSelector: r('[data-testid="bot-selector"]'),
      hud: r('[data-testid="hud"]'),
      btnMinH: Math.min(...btnH),
      btnMaxH: Math.max(...btnH),
      stageVisibleFrac: host
        ? Math.max(0, Math.min(window.innerHeight, host.y + host.h) - host.y) / Math.max(1, host.h)
        : 0,
      stageBottomInFirstScreen: host ? host.y + host.h <= window.innerHeight : false,
    };
  });
}

/** Contraste WCAG de algunos elementos (fondo: primer ancestro con color no transparente). */
async function contrasts(page: Page, sels: string[]) {
  return page.evaluate((sels) => {
    const parse = (s: string) => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = "1"] = m[1].split(",").map((x) => x.trim());
      return { r: +r, g: +g, b: +b, a: +a };
    };
    const lum = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const out: Record<string, number | null> = {};
    for (const sel of sels) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) {
        out[sel] = null;
        continue;
      }
      const fg = parse(getComputedStyle(el).color)!;
      let bg = null as ReturnType<typeof parse>;
      for (let e: HTMLElement | null = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c.a > 0.5) {
          bg = c;
          break;
        }
      }
      bg ??= { r: 0, g: 0, b: 0, a: 1 };
      let op = 1;
      for (let e: HTMLElement | null = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
      const fgm = { r: fg.r * op + bg.r * (1 - op), g: fg.g * op + bg.g * (1 - op), b: fg.b * op + bg.b * (1 - op) };
      const [l1, l2] = [lum(fgm), lum(bg)].sort((a, b) => b - a);
      out[sel] = Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
    }
    return out;
  }, sels);
}

test.describe("@fase1 REVIEWUX visor", () => {
  test("REVIEWUX visor 4v4: layout real en 5 viewports (+tablet táctil/no táctil)", async ({ browser }) => {
    test.setTimeout(600_000);
    const id = battle4v4();
    expect(id, "falta la batalla 4v4").not.toBe("");
    const metrics: Record<string, unknown> = {};
    const all = [...VPS, { name: "t1024nt", width: 1024, height: 768, touch: false } as const];
    for (const vp of all) {
      const ctx = await ctxFor(browser, vp as (typeof VPS)[number]);
      const page = await ctx.newPage();
      const problems = watchProblems(page);
      await login(page, STAFF.email, STAFF.password);
      await openReplay(page, id, 0);
      await pause(page);
      await ensureMinimap(page);
      await page.getByRole("button", { name: "Encajar mapa" }).click();
      await settled(page);
      const lay = await layout(page);
      const m: Record<string, unknown> = { layout: lay, overflowX: await overflowX(page) };
      m.dots = await miniAttr(page, "dots");
      m.inView = await miniAttr(page, "in-view");
      m.fitPct = await pct(page);
      m.minimapOverlapsStage =
        lay.minimap && lay.host
          ? overlap(
              { x: lay.minimap.x, y: lay.minimap.y, width: lay.minimap.w, height: lay.minimap.h },
              { x: lay.host.x, y: lay.host.y, width: lay.host.w, height: lay.host.h },
            )
          : null;
      m.contrast = await contrasts(page, [
        '[data-testid="camera-mode"]',
        ".s9v-help",
        ".s9v-hptext",
        '[data-testid="zoom-level"]',
        '[data-testid="replay-tick"]',
        '[data-testid="replay-status"]',
      ]);
      await snap(page, `view-${vp.name}-fit`);
      await snap(page, `view-${vp.name}-fit-full`, true);
      // Mitad de la batalla, a vista completa.
      const total = Number(await page.getByTestId("replay-tick").getAttribute("data-total"));
      await openReplay(page, id, Math.round(total * 0.35));
      await pause(page);
      await page.getByRole("button", { name: "Encajar mapa" }).click();
      await settled(page);
      await snap(page, `view-${vp.name}-mid`);
      // Seguir al primer bot y acercar dos veces: barras de vida y nombres.
      await page.getByTestId("bot-row").first().getByRole("button").click();
      await page.getByRole("button", { name: "Acercar" }).click();
      await page.getByRole("button", { name: "Acercar" }).click();
      await settled(page);
      m.followPct = await pct(page);
      await snap(page, `view-${vp.name}-zoom`);
      m.problems = problems;
      metrics[vp.name] = m;
      expect.soft(await overflowX(page), `${vp.name} overflow`).toBeLessThanOrEqual(1);
      expect.soft(m.minimapOverlapsStage, `${vp.name} minimapa sobre el escenario`).toBe(false);
      expect.soft(problems, `${vp.name} consola`).toEqual([]);
      await ctx.close();
    }
    dump("layout", metrics);
  });

  test("REVIEWUX visor 4v4: bots superpuestos al inicio (etiquetas/vidas), nombres «todos»", async ({ page }) => {
    test.setTimeout(240_000);
    const id = battle4v4();
    await page.setViewportSize({ width: 1366, height: 768 });
    await login(page, STAFF.email, STAFF.password);
    await openReplay(page, id, 0);
    await pause(page);
    await page.getByLabel("nombres sobre los bots").selectOption("all");
    await page.getByRole("button", { name: "Encajar mapa" }).click();
    await settled(page);
    await snap(page, "overlap-fit-all-names");
    for (const team of ["rojo", "azul"]) {
      const b = page.getByRole("button", { name: new RegExp(`^Bando ${team}`, "i") });
      if ((await b.count()) === 0) continue;
      await b.first().click();
      await settled(page);
      await snap(page, `overlap-team-${team}`);
    }
    // Máximo zoom sobre el primer bot.
    await page.getByTestId("bot-row").first().getByRole("button").click();
    for (let i = 0; i < 12; i++) await page.getByRole("button", { name: "Acercar" }).click();
    await settled(page);
    await snap(page, "overlap-maxzoom");
    // «sólo el seleccionado» y «oculta».
    await page.getByLabel("vida sobre los bots").selectOption("selected");
    await page.getByLabel("nombres sobre los bots").selectOption("auto");
    await page.getByRole("button", { name: "Encajar mapa" }).click();
    await settled(page);
    await snap(page, "overlap-fit-selected-only");
  });

  test("REVIEWUX visor: romper cámara (límites, rueda, pan, avance, seek, teclado, resize)", async ({ page }) => {
    test.setTimeout(420_000);
    const id = battle4v4();
    const problems = watchProblems(page);
    const r: Record<string, unknown> = {};
    // Viewport bajo para que la página SÍ tenga scroll vertical (si no, la prueba de rueda es vacía).
    await page.setViewportSize({ width: 1366, height: 620 });
    await login(page, STAFF.email, STAFF.password);
    await openReplay(page, id, 0);
    await ensureMinimap(page);
    const host = page.getByTestId("replay-canvas-host");
    r.scrollable = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    await page.evaluate(() => window.scrollTo(0, 60));
    const cb = (await canvasOf(page).boundingBox())!;
    const cx = cb.x + cb.width / 2;
    const cy = cb.y + Math.min(cb.height / 2, 200);
    const y0 = await page.evaluate(() => window.scrollY);
    // Rueda: 40 muescas hacia dentro.
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -240);
    await settled(page);
    r.wheelMaxPct = await pct(page);
    r.scrollAfterWheelIn = (await page.evaluate(() => window.scrollY)) - y0;
    for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 240);
    await settled(page);
    r.wheelMinPct = await pct(page);
    r.inViewAtMin = await miniAttr(page, "in-view");
    r.scrollAfterWheelOut = (await page.evaluate(() => window.scrollY)) - y0;
    expect.soft(r.scrollAfterWheelIn, "la rueda no desplaza la página (in)").toBe(0);
    expect.soft(r.scrollAfterWheelOut, "la rueda no desplaza la página (out)").toBe(0);
    expect.soft(r.inViewAtMin, "zoom mínimo con los 8 bots a la vista").toBe("8");
    await snap(page, "break-wheel-min");
    // Rueda en el BORDE del escenario.
    await page.mouse.move(cb.x + 4, cb.y + 4);
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -240);
    await settled(page);
    r.edgeZoomPct = await pct(page);
    r.edgeInView = await miniAttr(page, "in-view");
    await snap(page, "break-wheel-edge");

    // Pan exagerado: arrastrar 3 000 px hacia un lado. La vista no debe escaparse del mapa.
    await page.getByRole("button", { name: "Acercar" }).click();
    const bb = (await canvasOf(page).boundingBox())!;
    await page.mouse.move(bb.x + bb.width / 2, bb.y + 50);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) await page.mouse.move(bb.x + bb.width / 2 + 100 * i, bb.y + 50 + 40 * i);
    await page.mouse.up();
    await settled(page);
    r.viewAfterHugePan = await miniAttr(page, "view");
    r.worldSize = await mini(page).getAttribute("data-world");
    r.selectionAfterDrag = await page.evaluate(() => String(window.getSelection() ?? ""));
    await snap(page, "break-huge-pan");

    // Cámara manual + avance a 8×: la vista no se mueve sola.
    await page.getByRole("button", { name: "8×" }).click();
    const playB = page.getByRole("button", { name: "Reproducir", exact: true });
    if (await playB.isVisible()) await playB.click();
    const vManual = await miniAttr(page, "view");
    const pManual = await pct(page);
    const t0 = await tickOf(page);
    await expect.poll(() => tickOf(page), { timeout: 20_000 }).toBeGreaterThan(t0 + 200);
    r.manualSurvivesPlay = {
      mode: await mode(page),
      same: (await miniAttr(page, "view")) === vManual,
      pct: (await pct(page)) === pManual,
    };
    expect.soft(r.manualSurvivesPlay).toEqual({ mode: "manual", same: true, pct: true });
    // Seek con la línea de tiempo (teclado: End / Home).
    const tl = page.getByTestId("timeline");
    await tl.focus();
    await page.keyboard.press("Home");
    await expect.poll(() => tickOf(page), { timeout: 10_000 }).toBeLessThan(200);
    r.afterSeekHome = {
      mode: await mode(page),
      view: (await miniAttr(page, "view")) === vManual,
      pct: await pct(page),
    };
    // Teclas con el foco en la línea de tiempo: no deben tocar la cámara.
    const before = { m: await mode(page), p: await pct(page) };
    for (const k of ["1", "2", "g", "f", "+", "-", "c", "n"]) await page.keyboard.press(k);
    await page.waitForTimeout(600);
    r.keysOnTimeline = { before, after: { m: await mode(page), p: await pct(page) } };
    expect.soft(r.keysOnTimeline.after, "teclas sobre la línea de tiempo").toEqual(before);
    // Foco en el <select> de etiquetas.
    await page.getByLabel("nombres sobre los bots").focus();
    await page.keyboard.press("2");
    await page.keyboard.press("g");
    r.keysOnSelect = { m: await mode(page), p: await pct(page) };
    // Foco en body (clic en el título).
    await page.getByTestId("replay-title").click();
    await page.keyboard.press("3");
    r.keysOnBody = { m: await mode(page) };
    // Teclado EN el escenario.
    await host.focus();
    await page.keyboard.press("3");
    await expect.poll(() => mode(page)).toBe("follow");
    r.key3 = await page.getByTestId("camera-mode").textContent();
    await page.keyboard.press("+");
    await page.keyboard.press("+");
    await settled(page);
    r.keyPlusPct = await pct(page);
    await page.keyboard.press("f");
    await expect.poll(() => mode(page)).toBe("global");
    await page.keyboard.press("n");
    await settled(page);
    r.keyN = { m: await mode(page), p: await pct(page) };
    // ¿El foco de teclado del escenario es visible?
    r.stageFocusOutline = await host.evaluate(
      (e) => getComputedStyle(e).outlineStyle + " " + getComputedStyle(e).outlineColor,
    );

    // Seguir a un bot durante el avance: sigue en follow tras 10 s a 8×.
    await page.getByTestId("bot-row").nth(5).getByRole("button").click();
    const tF = await tickOf(page);
    await expect.poll(() => tickOf(page), { timeout: 20_000 }).toBeGreaterThan(tF + 300);
    r.followAfterPlay = { m: await mode(page), txt: await page.getByTestId("camera-mode").textContent() };
    await snap(page, "break-follow-after-play");
    // Pan tras seguir: pasa a libre.
    const bb2 = (await canvasOf(page).boundingBox())!;
    await page.mouse.move(bb2.x + 200, bb2.y + 100);
    await page.mouse.down();
    await page.mouse.move(bb2.x + 260, bb2.y + 140, { steps: 6 });
    await page.mouse.up();
    r.modeAfterPanFromFollow = await mode(page);

    // Minimapa: arrastrar SOBRE el minimapa (¿mueve algo? ¿selecciona texto?).
    const mb = (await mini(page).boundingBox())!;
    const v1 = await miniAttr(page, "view");
    await page.mouse.move(mb.x + mb.width * 0.2, mb.y + mb.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(mb.x + mb.width * 0.8, mb.y + mb.height * 0.8, { steps: 8 });
    await page.mouse.up();
    r.minimapDrag = { changed: (await miniAttr(page, "view")) !== v1, mode: await mode(page) };
    // Clic en una esquina del minimapa: la cámara no se sale del mapa.
    await page.mouse.click(mb.x + 1, mb.y + 1);
    await settled(page);
    r.minimapCornerView = await miniAttr(page, "view");
    // Tamaño del minimapa.
    const sizeSel = page.getByLabel("Tamaño del minimapa");
    r.minimapSizeOptions = (await sizeSel.count()) ? await sizeSel.locator("option").allTextContents() : null;

    // Resize a mitad de replay (reproduciendo): 1920 → 360 → 1024 → 1366.
    const resizes: Record<string, unknown> = {};
    for (const [w, h] of [
      [1920, 1080],
      [360, 800],
      [1024, 768],
      [430, 932],
      [1366, 768],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(800);
      const lay = await layout(page);
      const ratio = lay.canvas && lay.host ? { w: lay.canvas.w - lay.host.w, h: lay.canvas.h - lay.host.h } : null;
      resizes[`${w}x${h}`] = {
        overflowX: await overflowX(page),
        canvasMinusHost: ratio,
        buffer: lay.canvasBuffer,
        host: lay.host,
        minimap: lay.minimap,
        mode: await mode(page),
        pct: await pct(page),
        inView: await miniAttr(page, "in-view"),
      };
      expect.soft(await overflowX(page), `resize ${w}: overflow`).toBeLessThanOrEqual(1);
      expect.soft(ratio, `resize ${w}: canvas = host`).toEqual({ w: 0, h: 0 });
      await snap(page, `break-resize-${w}`);
    }
    await page.getByRole("button", { name: "Encajar mapa" }).click();
    await settled(page);
    r.afterResizeFitInView = await miniAttr(page, "in-view");
    r.resizes = resizes;
    r.problems = problems;
    dump("break-camera", r);
    expect.soft(problems).toEqual([]);
  });

  test("REVIEWUX visor en directo (ViewerPage) y 1v1", async ({ page }) => {
    test.setTimeout(240_000);
    const id = battle4v4();
    const problems = watchProblems(page);
    const r: Record<string, unknown> = {};
    await login(page, STAFF.email, STAFF.password);
    for (const [w, h] of [
      [1366, 768],
      [360, 800],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      await go(page, `#/viewer/${encodeURIComponent(id)}`);
      await expect(page.getByTestId("viewer-status")).toHaveAttribute("data-state", /.+/, { timeout: 30_000 });
      await page.waitForTimeout(3000);
      r[`viewer-${w}`] = {
        state: await page.getByTestId("viewer-status").getAttribute("data-state"),
        text: await page.getByTestId("viewer-status").textContent(),
        overflow: await overflowX(page),
        cameraBarVisible: await page
          .getByTestId("camera-mode")
          .isVisible()
          .catch(() => false),
      };
      await snap(page, `viewer-live-${w}`, true);
    }
    if (REPLAY_ID) {
      for (const [w, h] of [
        [1366, 768],
        [430, 932],
      ] as const) {
        await page.setViewportSize({ width: w, height: h });
        await openReplay(page, REPLAY_ID, 0);
        await pause(page);
        await ensureMinimap(page);
        r[`1v1-${w}`] = { dots: await miniAttr(page, "dots"), layout: await layout(page) };
        await snap(page, `view-1v1-${w}`);
      }
    }
    r.problems = problems;
    dump("viewer-1v1", r);
  });
});

test.describe("@fase1 REVIEWUX páginas", () => {
  test("REVIEWUX listas, detalle, menú y accesibilidad en 5 viewports", async ({ browser }) => {
    test.setTimeout(420_000);
    const id = battle4v4();
    const res: Record<string, unknown> = {};
    for (const vp of VPS) {
      const ctx = await ctxFor(browser, vp);
      const page = await ctx.newPage();
      const problems = watchProblems(page);
      await login(page, STAFF.email, STAFF.password);
      const m: Record<string, unknown> = {};
      for (const [name, hash] of [
        ["battles", "#/battles"],
        ["replays", "#/replays"],
        ["ranking", "#/ranking"],
        ["maps", "#/maps"],
        ["bots", "#/bots"],
        ["detail", `#/battles/${id}`],
      ] as const) {
        await go(page, hash);
        await page.waitForLoadState("networkidle").catch(() => undefined);
        await page.waitForTimeout(1200);
        m[name] = {
          overflowX: await overflowX(page),
          wideEls: await page.evaluate(() =>
            [...document.querySelectorAll("main *")]
              .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
              .slice(0, 5)
              .map((e) => `${e.tagName}.${(e as HTMLElement).className}`),
          ),
        };
        await snap(page, `page-${name}-${vp.name}`, true);
      }
      // Menú plegable.
      const toggle = page.getByTestId("nav-toggle");
      if (await toggle.isVisible()) {
        const a0 = await toggle.getAttribute("aria-expanded");
        await toggle.click();
        const a1 = await toggle.getAttribute("aria-expanded");
        await snap(page, `menu-open-${vp.name}`);
        // Navegar con el menú: ¿se cierra solo?
        await page.getByTestId("nav-menu").getByRole("link").nth(1).click();
        await page.waitForTimeout(500);
        const a2 = await toggle.getAttribute("aria-expanded");
        // Escape cierra?
        await toggle.click();
        await page.keyboard.press("Escape");
        const a3 = await toggle.getAttribute("aria-expanded");
        if (a3 === "true") await toggle.click();
        // Tab desde el toggle abierto entra en el menú?
        m.menu = {
          closed: a0,
          opened: a1,
          afterNavigate: a2,
          afterEscape: a3,
          controls: await toggle.getAttribute("aria-controls"),
        };
      } else m.menu = "sin toggle (escritorio)";
      m.contrast = await contrasts(page, ["nav a", "main h1, main h2", "main p", "button"]);
      m.problems = problems;
      res[vp.name] = m;
      expect.soft(problems, `${vp.name} consola`).toEqual([]);
      await ctx.close();
    }
    dump("pages", res);
  });
});

test.describe("@fase1 REVIEWUX mapas tablet", () => {
  test("REVIEWUX #/maps en 721-960 px con datos reales (ids largos)", async ({ page }) => {
    await login(page, STAFF.email, STAFF.password);
    const out: Record<string, unknown> = {};
    for (const w of [700, 721, 768, 820, 900, 960, 1024]) {
      await page.setViewportSize({ width: w, height: 1000 });
      await go(page, "#/maps");
      await page.waitForTimeout(1200);
      out[w] = await page.evaluate(() => {
        const t = document.querySelector("main table");
        const wide = [...document.querySelectorAll("main td, main th")]
          .map((e) => ({ r: Math.round(e.getBoundingClientRect().right), t: (e.textContent ?? "").slice(0, 40) }))
          .sort((a, b) => b.r - a.r)
          .slice(0, 3);
        return {
          cls: t?.className ?? null,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          tableW: t ? Math.round(t.getBoundingClientRect().width) : null,
          vw: window.innerWidth,
          wide,
        };
      });
      if (w === 768) await snap(page, "maps-768", true);
    }
    dump("maps-tablet", out);
  });
});

// ─────────────────────────────── editor ───────────────────────────────────────

async function toPage(page: Page, x: number, y: number) {
  const stage = page.getByTestId("editor-stage");
  await stage.scrollIntoViewIfNeeded();
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
const val = (page: Page, label: string) => page.getByLabel(label, { exact: true }).inputValue().then(Number);
const objs = (page: Page, kind?: string) =>
  page.locator(kind ? `[data-testid="editor-obj"][data-kind="${kind}"]` : '[data-testid="editor-obj"]');
const pal = (page: Page, name: string) => page.getByTestId("editor-palette").getByRole("button", { name, exact: true });

test.describe("@fase1 REVIEWUX editor", () => {
  test("REVIEWUX editor: undo/redo largo, deshacer tras guardar, límites, Nuevo, campos", async ({ page }) => {
    test.setTimeout(300_000);
    const problems = watchProblems(page);
    const r: Record<string, unknown> = {};
    test.info().setTimeout(300_000);
    const iv = setInterval(() => dump("editor-break", r), 2000);
    try {
      await page.setViewportSize({ width: 1366, height: 900 });
      await registerNewUser(page);
      await go(page, "#/maps/editor");
      await expect(page.getByTestId("editor-canvas")).toBeVisible();
      const mapId = `rev-${Date.now().toString(36)}`;
      await page.getByLabel("id del mapa").fill(mapId);
      await page.getByLabel("nombre del mapa").fill("Revisión UX");
      const base = await objs(page).count();
      r.baseObjects = base;
      // 12 cajas.
      for (let i = 0; i < 12; i++) {
        await pal(page, "Caja").click();
        const p = await toPage(page, 15 + i * 5, 15 + (i % 3) * 8);
        await page.mouse.click(p.x, p.y);
      }
      r.after12 = await objs(page).count();
      // Mover la última, 5 veces (5 entradas).
      for (let i = 0; i < 5; i++) {
        const p = await toPage(page, await val(page, "Posición X"), await val(page, "Posición Y"));
        await mouseDrag(page, p, { x: p.x + 15, y: p.y + 10 });
      }
      r.posAfterMoves = [await val(page, "Posición X"), await val(page, "Posición Y")];
      // Deshacer TODO con Ctrl+Z (17 entradas) + 5 de propina.
      await page
        .getByTestId("editor-stage")
        .click({ position: { x: 5, y: 5 } })
        .catch(() => undefined);
      for (let i = 0; i < 22; i++) await page.keyboard.press("Control+z");
      r.afterUndoAll = await objs(page).count();
      r.undoDisabled = await page.getByTestId("editor-undo").isDisabled();
      // Rehacer todo.
      for (let i = 0; i < 22; i++) await page.keyboard.press("Control+y");
      r.afterRedoAll = await objs(page).count();
      r.redoDisabled = await page.getByTestId("editor-redo").isDisabled();
      expect.soft(r.afterUndoAll, "undo total").toBe(base);
      expect.soft(r.afterRedoAll, "redo total").toBe(base + 12);
      // Deshacer 3 y crear algo: el futuro se descarta.
      for (let i = 0; i < 3; i++) await page.keyboard.press("Control+z");
      await pal(page, "Muro").click();
      const pw = await toPage(page, 50, 70);
      await page.mouse.click(pw.x, pw.y);
      r.redoAfterBranch = await page.getByTestId("editor-redo").isDisabled();

      // Ctrl+Z dentro del campo id: NO deshace el mapa.
      const nBefore = await objs(page).count();
      await page.getByLabel("id del mapa").click();
      await page.keyboard.press("End");
      await page.keyboard.type("x");
      await page.keyboard.press("Control+z");
      r.ctrlZInInput = {
        objectsSame: (await objs(page).count()) === nBefore,
        id: await page.getByLabel("id del mapa").inputValue(),
      };
      await page.getByLabel("id del mapa").fill(mapId);
      // Backspace con el foco en un botón de la paleta (¿borra el objeto seleccionado?).
      const selBefore = await objs(page).count();
      await pal(page, "Muro").focus();
      await page.keyboard.press("Escape");
      await page
        .getByTestId("editor-objects")
        .getByRole("button", { name: /^Muro 1/ })
        .click();
      await page.getByTestId("editor-save").focus();
      await page.keyboard.press("Backspace");
      r.backspaceOnButtonDeletes = (await objs(page).count()) < selBefore;
      if (r.backspaceOnButtonDeletes) await page.keyboard.press("Control+z");

      // Arrastrar un muro FUERA del mapa.
      await page
        .getByTestId("editor-objects")
        .getByRole("button", { name: /^Muro 1/ })
        .click();
      const wp = await toPage(page, await val(page, "Posición X"), await val(page, "Posición Y"));
      await mouseDrag(page, wp, { x: wp.x + 2000, y: wp.y + 2000 });
      r.wallOutside = {
        x: await val(page, "Posición X"),
        y: await val(page, "Posición Y"),
        issues: await page.getByTestId("editor-issue").allTextContents(),
      };
      await snap(page, "editor-wall-outside");
      await page.keyboard.press("Control+z");
      // Tirador este por detrás del oeste (anchura negativa).
      const h = (await page.getByTestId("editor-handle-e").boundingBox())!;
      const w0 = await val(page, "Anchura");
      await mouseDrag(page, { x: h.x + h.width / 2, y: h.y + h.height / 2 }, { x: h.x - 1500, y: h.y });
      r.negativeResize = { w0, w: await val(page, "Anchura"), x: await val(page, "Posición X") };
      expect.soft(await val(page, "Anchura"), "anchura > 0").toBeGreaterThan(0);
      await snap(page, "editor-negative-resize");
      await page.keyboard.press("Control+z");
      // Campo numérico con valores absurdos.
      await page.getByLabel("Anchura", { exact: true }).fill("-5");
      await page.getByLabel("Anchura", { exact: true }).blur();
      r.widthMinus5 = {
        v: await page.getByLabel("Anchura", { exact: true }).inputValue(),
        issues: await page.getByTestId("editor-issue").allTextContents(),
      };
      await page.getByLabel("Anchura", { exact: true }).fill("");
      await page.getByLabel("Anchura", { exact: true }).blur();
      r.widthEmpty = { v: await page.getByLabel("Anchura", { exact: true }).inputValue() };
      await snap(page, "editor-bad-number");
      for (let i = 0; i < 3; i++) await page.keyboard.press("Control+z");

      // Zoom del editor: límites.
      const stage = page.getByTestId("editor-stage");
      const zoomOf = async () => Number(await stage.getAttribute("data-zoom"));
      const c = await toPage(page, 50, 50);
      await page.mouse.move(c.x, c.y);
      for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -240);
      r.editorZoomMax = { z: await zoomOf(), label: await page.getByTestId("editor-zoom").textContent() };
      for (let i = 0; i < 60; i++) await page.mouse.wheel(0, 240);
      r.editorZoomMin = { z: await zoomOf(), label: await page.getByTestId("editor-zoom").textContent() };
      await snap(page, "editor-zoom-min");
      await page.getByRole("button", { name: "Encajar mapa" }).click();

      // Paleta → arrastrar al mapa (drag and drop con el ratón).
      const n0 = await objs(page, "hazard").count();
      const pb = (await pal(page, "Zona de daño").boundingBox())!;
      const tgt = await toPage(page, 70, 20);
      await mouseDrag(page, { x: pb.x + pb.width / 2, y: pb.y + pb.height / 2 }, tgt);
      r.paletteDragCreates = (await objs(page, "hazard").count()) > n0;
      r.kinds = await page.evaluate(() => [
        ...new Set(
          [...document.querySelectorAll('[data-testid="editor-obj"]')].map((e) => e.getAttribute("data-kind")),
        ),
      ]);

      // Guardar → Ctrl+Z → ¿se marca sin guardar? → recargar.
      await page.getByTestId("editor-save").click();
      await expect(page.getByTestId("editor-notice")).toContainText(`${mapId} v1`, { timeout: 20_000 });
      r.saveIssues = (await page.getByTestId("editor-error").count())
        ? await page.getByTestId("editor-error").textContent()
        : null;
      const countSaved = await objs(page).count();
      await page
        .getByTestId("editor-stage")
        .click({ position: { x: 3, y: 3 } })
        .catch(() => undefined);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+z");
      const countUndone = await objs(page).count();
      r.undoAfterSave = {
        countSaved,
        countUndone,
        publishDisabled: await page.getByTestId("editor-publish").isDisabled(),
        current: await page.getByTestId("editor-current").textContent(),
      };
      await page.waitForTimeout(600);
      await page.reload();
      await expect(page.getByTestId("editor-canvas")).toBeVisible();
      await page.waitForTimeout(1500);
      r.reloadAfterUndo = {
        count: await objs(page).count(),
        restored: await page
          .getByTestId("editor-restored")
          .isVisible()
          .catch(() => false),
        current: (await page.getByTestId("editor-current").count())
          ? await page.getByTestId("editor-current").textContent()
          : null,
      };
      expect.soft(r.reloadAfterUndo.count, "recarga conserva el deshacer sin guardar").toBe(countUndone);

      // «Nuevo» con cambios sin guardar: ¿pide confirmación? ¿se puede deshacer?
      let dialog = "";
      page.once("dialog", async (d) => {
        dialog = d.message();
        await d.dismiss();
      });
      await page.getByRole("button", { name: "Nuevo", exact: true }).click();
      await page.waitForTimeout(500);
      r.nuevoWithUnsaved = {
        dialog,
        count: await objs(page).count(),
        undoEnabled: !(await page.getByTestId("editor-undo").isDisabled()),
        draftLeft: await page.evaluate(() => window.localStorage.getItem("s9.mapEditor.draft.v1") !== null),
      };
      await snap(page, "editor-after-nuevo");
      r.problems = problems;
      expect.soft(problems).toEqual([]);
    } finally {
      clearInterval(iv);
      dump("editor-break", r);
    }
  });

  test("REVIEWUX editor: mapas existentes (mvp-arena-01/02, golden, procedural) abren y validan", async ({ page }) => {
    test.setTimeout(240_000);
    const problems = watchProblems(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await login(page, STAFF.email, STAFF.password);
    const lr = await page.request.post("/api/v1/auth/login", { data: STAFF });
    const auth = { Authorization: `Bearer ${((await lr.json()) as { accessToken: string }).accessToken}` };
    const list = await page.request.get("/api/v1/maps?limit=100", { headers: auth });
    const items = ((await list.json()) as { items: { mapId: string; version: number; state: string }[] }).items;
    const gen = await page.request.post("/api/v1/maps/generate", {
      headers: auth,
      data: { seed: `rev-${Date.now()}`, params: { widthM: 60, heightM: 40, modes: ["deathmatch"] } },
    });
    const g = gen.ok() ? ((await gen.json()) as { mapId: string; version: number }) : null;
    const targets = [...items.map((i) => ({ mapId: i.mapId, version: i.version }))];
    if (g) targets.push(g);
    const seen = new Set<string>();
    const res: Record<string, unknown> = { listed: items.map((i) => `${i.mapId} v${i.version} ${i.state}`) };
    for (const t of targets) {
      const key = `${t.mapId}@${t.version}`;
      if (seen.has(key) || seen.size >= 12) continue;
      seen.add(key);
      await go(page, `#/maps/editor?map=${encodeURIComponent(t.mapId)}&v=${t.version}`);
      await page.reload();
      await expect(page.getByTestId("editor-current")).toHaveText(`${t.mapId} v${t.version}`, { timeout: 20_000 });
      await page.waitForTimeout(800);
      res[key] = {
        objects: await objs(page).count(),
        ok: await page
          .getByTestId("editor-validation-ok")
          .isVisible()
          .catch(() => false),
        issues: (await page.getByTestId("editor-issue").allTextContents()).slice(0, 8),
        overflow: await overflowX(page),
      };
      await page.getByTestId("editor-stage").scrollIntoViewIfNeeded();
      await snap(page, `editor-open-${t.mapId.replace(/[^a-z0-9-]/gi, "_")}-v${t.version}`);
    }
    res.problems = problems;
    dump("editor-maps", res);
    expect.soft(problems).toEqual([]);
  });
});

// ───────────────────────── re-revisión (7d56f8a) ─────────────────────────────

const VPS2 = [
  ...VPS,
  { name: "t721", width: 721, height: 1000, touch: true },
  { name: "t768", width: 768, height: 1024, touch: true },
  { name: "t960", width: 960, height: 800, touch: true },
] as const;

/** Rectángulo del escenario frente a la tira del HUD y a la pantalla. */
async function stageVsHud(page: Page) {
  return page.evaluate(() => {
    const r = (el: Element | null) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const host = r(document.querySelector('[data-testid="replay-canvas-host"]'));
    const huds = [...document.querySelectorAll('[data-testid="hud"],[data-testid="hud-score"]')].map(r);
    const overl = huds.filter(
      (h) =>
        h &&
        host &&
        h.w > 0 &&
        h.h > 0 &&
        h.x < host.x + host.w &&
        host.x < h.x + h.w &&
        h.y < host.y + host.h &&
        host.y < h.y + h.h,
    );
    return {
      vh: window.innerHeight,
      scrollY: Math.round(window.scrollY),
      host,
      huds,
      hudOverStage: overl,
      visibleFrac: host ? Math.max(0, Math.min(window.innerHeight, host.y + host.h) - Math.max(0, host.y)) / host.h : 0,
      fps: [...document.querySelectorAll("canvas")].length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

test.describe("@fase1 REVIEWUX2 visor", () => {
  test("REVIEWUX2 escenario visible, HUD fuera del escenario y seguir+zoom en el borde (8 viewports)", async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    const id = battle4v4();
    expect(id).not.toBe("");
    const out: Record<string, unknown> = {};
    for (const vp of VPS2) {
      const ctx = await ctxFor(browser, vp as (typeof VPS)[number]);
      const page = await ctx.newPage();
      const problems = watchProblems(page);
      await login(page, STAFF.email, STAFF.password);
      await openReplay(page, id, 0);
      await pause(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByRole("button", { name: "Encajar mapa" }).click();
      await settled(page);
      const m: Record<string, unknown> = { atTop: await stageVsHud(page) };
      await snap(page, `r2-view-${vp.name}-fit`);
      // Seguir al bot 1 (aparece pegado a un canto del mapa en t=0) y acercar ×3.
      await page.getByTestId("bot-row").first().getByRole("button").click();
      for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Acercar" }).click();
      await settled(page);
      m.afterZoom = {
        mode: await mode(page),
        pct: await pct(page),
        text: await page.getByTestId("camera-mode").textContent(),
      };
      m.zoomLayout = await stageVsHud(page);
      await snap(page, `r2-view-${vp.name}-follow-zoom`);
      // Alejar dentro de seguir.
      await page.getByRole("button", { name: "Alejar" }).click();
      await settled(page);
      m.afterZoomOut = { mode: await mode(page), pct: await pct(page) };
      m.problems = problems;
      out[vp.name] = m;
      expect.soft((m.atTop as { overflowX: number }).overflowX, `${vp.name} overflow`).toBeLessThanOrEqual(1);
      expect
        .soft((m.atTop as { hudOverStage: unknown[] }).hudOverStage, `${vp.name} HUD sobre el escenario`)
        .toEqual([]);
      expect
        .soft((m.atTop as { visibleFrac: number }).visibleFrac, `${vp.name} escenario visible`)
        .toBeGreaterThan(0.95);
      expect.soft(problems, `${vp.name} consola`).toEqual([]);
      await ctx.close();
    }
    dump("r2-layout", out);
  });

  test("REVIEWUX2 «Más controles» con táctil en 360 y 430", async ({ browser }) => {
    test.setTimeout(240_000);
    const id = battle4v4();
    const out: Record<string, unknown> = {};
    for (const vp of [VPS[3], VPS[4]]) {
      const ctx = await ctxFor(browser, vp);
      const page = await ctx.newPage();
      const problems = watchProblems(page);
      await login(page, STAFF.email, STAFF.password);
      await openReplay(page, id, 0);
      const more = page.getByTestId("more-controls");
      const r: Record<string, unknown> = {
        visible: await more.isVisible(),
        expanded0: await more.getAttribute("aria-expanded"),
        vistaGlobalVisible0: await page.getByRole("button", { name: "Vista global" }).isVisible(),
        layout0: await stageVsHud(page),
      };
      const mb = (await more.boundingBox())!;
      await page.touchscreen.tap(mb.x + mb.width / 2, mb.y + mb.height / 2);
      await page.waitForTimeout(400);
      r.expanded1 = await more.getAttribute("aria-expanded");
      r.vistaGlobalVisible1 = await page.getByRole("button", { name: "Vista global" }).isVisible();
      r.layout1 = await stageVsHud(page);
      await snap(page, `r2-more-open-${vp.name}`);
      // Usar un control extra con el dedo: «Bando rojo».
      const side = page.getByTestId("camera-side").first();
      if (await side.isVisible()) {
        const sb = (await side.boundingBox())!;
        await page.touchscreen.tap(sb.x + sb.width / 2, sb.y + sb.height / 2);
        await expect.poll(() => mode(page)).toBe("team");
      }
      r.modeAfterSide = await mode(page);
      const mb2 = (await more.boundingBox())!;
      await page.touchscreen.tap(mb2.x + mb2.width / 2, mb2.y + mb2.height / 2);
      await page.waitForTimeout(400);
      r.expanded2 = await more.getAttribute("aria-expanded");
      r.moreSize = { w: Math.round(mb.width), h: Math.round(mb.height) };
      r.problems = problems;
      out[vp.name] = r;
      await snap(page, `r2-more-closed-${vp.name}`);
      expect.soft(r.expanded1).toBe("true");
      expect.soft(r.expanded2).toBe("false");
      expect.soft(problems).toEqual([]);
      await ctx.close();
    }
    dump("r2-more", out);
  });
});

test.describe("@fase1 REVIEWUX2 tablas y selector", () => {
  test("REVIEWUX2 tablas wide en 721/768/800/959/960/961/1024 y selector de batalla", async ({ page }) => {
    test.setTimeout(300_000);
    const problems = watchProblems(page);
    await login(page, STAFF.email, STAFF.password);
    const lr = await page.request.post("/api/v1/auth/login", { data: STAFF });
    const auth = { Authorization: `Bearer ${((await lr.json()) as { accessToken: string }).accessToken}` };
    // Mapa con id y nombre largos (dueño: organizer) para forzar la tabla de mapas.
    await page.request.post("/api/v1/maps/generate", {
      headers: auth,
      data: {
        seed: `rev2-${Date.now()}-con-una-semilla-muy-larga`,
        params: { widthM: 60, heightM: 40, modes: ["deathmatch"] },
      },
    });
    const bots = (await (await page.request.get("/api/v1/bots?mine=true&limit=5", { headers: auth })).json()) as {
      items?: { id: string }[];
    };
    const botId = bots.items?.[0]?.id;
    const routes: [string, string][] = [
      ["maps", "#/maps"],
      ["battles", "#/battles"],
      ["replays", "#/replays"],
      ["bots", "#/bots"],
      ["battle-new", "#/battles/new"],
    ];
    if (botId) routes.push(["bot-detail", `#/bots/${botId}`]);
    const out: Record<string, unknown> = {};
    for (const w of [721, 768, 800, 959, 960, 961, 1024]) {
      await page.setViewportSize({ width: w, height: 900 });
      const row: Record<string, unknown> = {};
      for (const [name, hash] of routes) {
        await go(page, hash);
        await page.waitForTimeout(1000);
        row[name] = await page.evaluate(() => ({
          o: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          culprits: [...document.querySelectorAll("main *")]
            .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
            .slice(0, 4)
            .map((e) => `${e.tagName}.${(e as HTMLElement).className}`),
        }));
        if ([721, 768, 960, 961].includes(w)) await snap(page, `r2-${name}-${w}`, true);
        expect.soft((row[name] as { o: number }).o, `${name} @${w}`).toBeLessThanOrEqual(1);
      }
      out[w] = row;
    }
    // Selector de batalla con la UI de elegibilidad de main: 360 y 1366.
    for (const [w, h] of [
      [360, 800],
      [1366, 900],
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      await go(page, "#/battles/new");
      await page.waitForTimeout(1500);
      out[`battle-new-${w}`] = {
        overflow: await overflowX(page),
        sides: await page.locator('[data-testid^="side-"], [data-testid^="team-side-"]').count(),
        notEligible: await page.locator('[data-testid^="version-not-eligible-"]').count(),
        selects: await page.locator("main select").count(),
      };
      await snap(page, `r2-battle-new-${w}`, true);
    }
    out.problems = problems;
    dump("r2-tables", out);
    expect.soft(problems).toEqual([]);
  });
});

test.describe("@fase1 REVIEWUX2 editor", () => {
  test("REVIEWUX2 «Nuevo» con diálogo: teclado, Esc, cancelar, descartar; borrado sólo en el lienzo", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const problems = watchProblems(page);
    const r: Record<string, unknown> = {};
    await page.setViewportSize({ width: 1366, height: 900 });
    await registerNewUser(page);
    await go(page, "#/maps/editor");
    await expect(page.getByTestId("editor-canvas")).toBeVisible();
    const base = await objs(page).count();
    // Sin cambios: «Nuevo» no pregunta.
    await page.getByRole("button", { name: "Nuevo", exact: true }).click();
    r.noChangesDialog = await page.getByTestId("editor-confirm-new").count();
    // Cambio: 2 cajas.
    for (const x of [30, 50]) {
      await pal(page, "Caja").click();
      const p = await toPage(page, x, 30);
      await page.mouse.click(p.x, p.y);
    }
    const withBoxes = await objs(page).count();
    const nuevo = page.getByRole("button", { name: "Nuevo", exact: true });
    // 1) Abrir con teclado (Enter) y cerrar con Esc.
    await nuevo.focus();
    await page.keyboard.press("Enter");
    const dlg = page.getByTestId("editor-confirm-new");
    await expect(dlg).toBeVisible();
    r.dialog = {
      role: await dlg.getAttribute("role"),
      expanded: await nuevo.getAttribute("aria-expanded"),
      focused: await page.evaluate(() => document.activeElement?.textContent ?? ""),
    };
    await snap(page, "r2-editor-nuevo-dialog");
    // Con el diálogo abierto: Ctrl+Z / Supr no deben tocar nada raro.
    await page.keyboard.press("Delete");
    r.deleteInDialog = (await objs(page).count()) === withBoxes;
    await page.keyboard.press("Escape");
    r.afterEsc = {
      open: await dlg.count(),
      count: await objs(page).count(),
      focusBack: await page.evaluate(() => document.activeElement?.textContent ?? ""),
    };
    // 2) Abrir, «Cancelar» con Enter (foco inicial).
    await nuevo.click();
    await expect(dlg).toBeVisible();
    await page.keyboard.press("Enter");
    r.afterCancelEnter = { open: await dlg.count(), count: await objs(page).count() };
    // 3) Abrir, Tab hasta «Descartar…» y confirmar.
    await nuevo.click();
    await expect(dlg).toBeVisible();
    await dlg.getByRole("button", { name: /Descartar/ }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    r.afterDiscard = {
      open: await dlg.count(),
      count: await objs(page).count(),
      draft: await page.evaluate(() => window.localStorage.getItem("s9.mapEditor.draft.v1")),
    };
    // Borrado: Supr con foco en un botón NO borra; en el lienzo sí.
    await pal(page, "Muro").click();
    const p = await toPage(page, 60, 40);
    await page.mouse.click(p.x, p.y);
    const n1 = await objs(page).count();
    await page.getByTestId("editor-save").focus();
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    r.deleteOnButton = (await objs(page).count()) < n1;
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press("Delete");
    r.deleteOnCanvas = (await objs(page).count()) < n1;
    await page.keyboard.press("Control+z");
    r.reselectAfterUndo = await page.locator('[data-testid="editor-obj"][data-selected="true"]').count();
    r.base = base;
    r.withBoxes = withBoxes;
    r.problems = problems;
    dump("r2-editor", r);
    expect.soft(r.afterEsc).toMatchObject({ open: 0, count: withBoxes });
    expect.soft(r.afterCancelEnter).toEqual({ open: 0, count: withBoxes });
    expect.soft((r.afterDiscard as { count: number }).count).toBe(base);
    expect.soft(r.deleteOnButton).toBe(false);
    expect.soft(r.deleteOnCanvas).toBe(true);
    expect.soft(problems).toEqual([]);
  });
});
