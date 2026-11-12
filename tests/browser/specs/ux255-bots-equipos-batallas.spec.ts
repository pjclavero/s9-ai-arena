/**
 * #255 · E2E de navegador REAL (entorno aislado de run.sh, sin mocks) de:
 *  - B1-B2  la navegación ÚNICA del bot: [lista] | [menú de secciones | UNA sección],
 *           sin scroll como navegación;
 *  - B3-B4  la tarjeta única de visibilidad (bot + código por versión);
 *  - B5-B7  «Hacer públicos los bots que administras» en Equipos (permisos reales:
 *           sólo el dueño; parciales a la vista);
 *  - B8-B10 el bloque «Directo y retransmisión» de una batalla;
 *  - B11-B13 el layout en 1920×1080, 1440×900, 1280×720, 1024×768, 768×1024,
 *           390×844 y 360×640.
 *
 * Cuentas: U (capitana, dueña de A y B —builds REALES y publicadas— y de C, sin
 * versiones), M (miembro, dueño de MB), N (miembro sin bots), admin semilla.
 * Capturas en $S9_E2E_OUT/shots/ux255-*.png.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { REPLAY_ID, login, registerNewUser, shot, watchProblems } from "./helpers.js";
import { PublicApi, createBattle, pickBot, type Creds } from "./review-lib.js";
import { PY_STILL, expectVersionState, newBotWithLoadout, openBotSection, uploadAndSubmit } from "./uxb-helpers.js";
import { visit } from "./ux-e-lib.js";

const ADMIN_EMAIL = "admin@dev.arena.local";
const PASSWORD = process.env.S9_E2E_DEV_PASSWORD ?? "";
const STAMP = Date.now().toString(36);
const A = `u255-a-${STAMP}`;
const B = `u255-b-${STAMP}`;
const C = `u255-c-${STAMP}`;
const MB = `u255-mb-${STAMP}`;
const TEAM = `U255 ${STAMP}`;
const TEAM_SOLO = `U255 solo ${STAMP}`;

const VIEWPORTS = [
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "390x844", width: 390, height: 844 },
  { name: "360x640", width: 360, height: 640 },
] as const;

interface Who {
  creds: Creds;
  api: PublicApi;
  page: Page;
}
let U: Who;
let M: Who;
let N: Who;
const ID: Record<string, string> = {};
const TEAM_ID: Record<string, string> = {};
let liveBattle = "";

async function newPerson(browser: Browser, base: string): Promise<Who> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: base });
  const page = await ctx.newPage();
  const creds = await registerNewUser(page);
  const api = new PublicApi(page.request, creds);
  await api.login();
  return { creds, api, page };
}

async function botId(api: PublicApi, name: string): Promise<string> {
  const mine = (await api.ok("GET", "/bots?limit=100")).items as { id: string; name: string }[];
  const id = mine.find((b) => b.name === name)?.id;
  expect(id, `bot ${name}`).toBeTruthy();
  return id!;
}

async function hOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function box(page: Page, testId: string) {
  const b = await page.getByTestId(testId).first().boundingBox();
  expect(b, `caja de ${testId}`).toBeTruthy();
  return b!;
}

test.describe.configure({ mode: "serial" });

test.describe("@fase1 #255 Bots, Equipos y Batallas", () => {
  test("preparación: U con A y B publicadas (build REAL) y C; M con MB; N; equipos", async ({ browser, baseURL }) => {
    test.setTimeout(900_000);
    // Contextos propios (no el `page` del test): sobreviven entre los tests de la serie.
    U = await newPerson(browser, baseURL!);
    const { page, api } = U;
    for (const name of [A, B]) {
      await newBotWithLoadout(page, name);
      await uploadAndSubmit(page, 1, PY_STILL);
      await expectVersionState(page, 1, "validated");
      await page.getByRole("button", { name: "Publicar v1" }).click();
      await expect(page.getByTestId("version-row-1")).toContainText("published");
      ID[name] = await botId(api, name);
    }
    ID[C] = (await api.ok("POST", "/bots", { name: C })).id;
    M = await newPerson(browser, baseURL!);
    N = await newPerson(browser, baseURL!);
    ID[MB] = (await M.api.ok("POST", "/bots", { name: MB })).id;

    TEAM_ID.main = (await api.ok("POST", "/teams", { name: TEAM })).id;
    TEAM_ID.solo = (await api.ok("POST", "/teams", { name: TEAM_SOLO })).id;
    // Crear un equipo da el rol team_captain: el token nuevo lo lleva.
    await api.login();
    for (const who of [M, N]) await api.ok("POST", `/teams/${TEAM_ID.main}/members`, { email: who.creds.email });
    // Un bot pertenece como mucho a un equipo: A y B (de U) y MB (de M) en «main»; C en «solo».
    for (const n of [A, B]) await api.ok("POST", `/teams/${TEAM_ID.main}/bots`, { botId: ID[n] });
    await M.api.ok("POST", `/teams/${TEAM_ID.main}/bots`, { botId: ID[MB] });
    await api.ok("POST", `/teams/${TEAM_ID.solo}/bots`, { botId: ID[C] });
    for (const n of [A, B, C]) expect((await api.ok("GET", `/bots/${ID[n]}`)).visibility).toBe("private");
  });

  test("BOT_SECTION_SWITCH_NO_SCROLL · cambiar de sección no desplaza la página y lleva el foco al encabezado", async ({}, info) => {
    const page = U.page;
    const problems = watchProblems(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await visit(page, `#/bots/${ID[A]}`);
    await expect(page.getByTestId("bot-section")).toHaveAttribute("data-section", "resumen");
    const nav = page.getByRole("navigation", { name: `secciones de ${A}` });
    // Ninguna navegación por scroll en la página (la de antes: scrollIntoView).
    await page.evaluate(() => {
      (window as unknown as { __s9scrolls: number }).__s9scrolls = 0;
      const orig = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...a: unknown[]) {
        (window as unknown as { __s9scrolls: number }).__s9scrolls += 1;
        return orig.apply(this, a as []);
      };
      window.scrollTo(0, 0);
    });
    for (const [id, label] of [
      ["visibilidad", "Visibilidad"],
      ["equipamiento", "Equipamiento"],
      ["codigo", "Código"],
      ["versiones", "Versiones y build"],
      ["batallas", "Batallas"],
      ["replays", "Replays"],
      ["resumen", "Resumen"],
    ] as const) {
      await nav.getByRole("link", { name: label }).click();
      await expect(page.getByTestId("bot-section")).toHaveAttribute("data-section", id);
      await expect(page).toHaveURL(new RegExp(id === "resumen" ? `#/bots/${ID[A]}$` : `#/bots/${ID[A]}/${id}$`));
      await expect(nav.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
      expect(await page.evaluate(() => window.scrollY), `scrollY tras ${label}`).toBe(0);
      // El foco va al encabezado de la sección (anunciado por el lector de pantalla).
      await expect(page.locator("#bot-section-heading")).toBeFocused();
      await expect(page.locator("#bot-section-heading")).toHaveText(label);
      await expect(page.locator("#bot-section-heading")).toBeInViewport();
    }
    // Desde abajo (la sección «Código» es larga): el menú sigue a la vista (sticky) y
    // cambiar de sección NUNCA desplaza hacia otra parte de la página.
    await nav.getByRole("link", { name: "Código" }).click();
    await page.evaluate(() => window.scrollTo(0, 400));
    const before = await page.evaluate(() => window.scrollY);
    await expect(nav.getByRole("link", { name: "Visibilidad" })).toBeInViewport();
    await nav.getByRole("link", { name: "Visibilidad" }).click();
    await expect(page.getByTestId("bot-section")).toHaveAttribute("data-section", "visibilidad");
    expect(await page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(before);
    // Teclado: Tab llega al menú y Enter cambia de sección.
    await nav.getByRole("link", { name: "Equipamiento" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("bot-section")).toHaveAttribute("data-section", "equipamiento");
    expect(await page.evaluate(() => (window as unknown as { __s9scrolls: number }).__s9scrolls)).toBe(0);
    // F5 conserva bot y sección.
    await page.reload();
    await expect(page.getByTestId("bot-section")).toHaveAttribute("data-section", "equipamiento");
    await shot(page, info, "ux255-bot-section-switch-1280x720");
    expect(problems).toEqual([]);
  });

  test("BOT_SECTION_SINGLE_CONTENT · cada sección pinta SÓLO su contenido; nada duplicado", async ({}, info) => {
    const page = U.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    // Marcas de cada sección: en cada una aparece la suya y ninguna de las otras.
    const marks: Record<string, string> = {
      resumen: "bot-overview",
      visibilidad: "visibility-card",
      equipamiento: "save-loadout",
      codigo: "code-editor",
      versiones: "versions-card",
      batallas: "bot-battles",
      replays: "bot-replays",
    };
    for (const sec of Object.keys(marks)) {
      await visit(page, sec === "resumen" ? `#/bots/${ID[A]}` : `#/bots/${ID[A]}/${sec}`);
      await expect(page.getByTestId("bot-section")).toHaveCount(1);
      await expect(page.getByTestId("bot-section")).toHaveAttribute("data-section", sec);
      await expect(page.getByTestId(marks[sec])).toBeVisible();
      for (const [other, mark] of Object.entries(marks)) {
        if (other !== sec) await expect(page.getByTestId(mark), `${mark} en ${sec}`).toHaveCount(0);
      }
      // Un único menú de navegación del bot; ni subnavegación por anclas ni «detalle y versiones».
      await expect(page.getByTestId("bot-section-nav")).toHaveCount(1);
      await expect(page.getByText("detalle y versiones")).toHaveCount(0);
      await expect(page.locator("textarea")).toHaveCount(sec === "codigo" ? 1 : 0);
    }
    await shot(page, info, "ux255-bot-section-versiones-1440x900");
  });

  test("BOT_VISIBILITY_AND_CODE_GROUPED · bot y código juntos, independientes y con una sola fuente de verdad", async ({}, info) => {
    const page = U.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await visit(page, `#/bots/${ID[A]}/visibilidad`);
    const card = page.getByTestId("visibility-card");
    await expect(card.getByTestId("visibility-independence")).toContainText(
      "Hacer público el bot NO hace público automáticamente su código.",
    );
    await expect(card.getByTestId("visibility-independence")).toContainText(
      "Hacer público el código de una versión NO hace público el bot.",
    );
    await expect(card.getByTestId("visibility-quick")).toHaveText(/Bot ● Privado · Código v1 ● Privado/);
    // Acción rápida: la versión publicada, en la MISMA tarjeta.
    const quick = card.getByTestId("code-visibility-published");
    await expect(quick.getByTestId("code-visibility-1")).toBeVisible();
    // Bot → Público: el código NO cambia.
    await card.getByTestId("bot-visibility-public").click();
    await expect(card.getByTestId("visibility-quick")).toHaveText(/Bot ● Público · Código v1 ● Privado/);
    let v1 = (await U.api.ok("GET", `/bots/${ID[A]}/versions`))[0];
    expect(v1.codePublic).toBe(false);
    // Código v1 → Público: el bot NO cambia; volver a privado avisa.
    await quick.getByTestId("code-public-1").click();
    await expect(quick.getByTestId("code-private-warning-1")).toBeVisible();
    await expect(card.getByTestId("visibility-quick")).toHaveText(/Bot ● Público · Código v1 ● Público/);
    await shot(page, info, "ux255-visibilidad-agrupada-1440x900");
    await quick.getByTestId("code-private-1").click();
    await expect(card.getByTestId("visibility-quick")).toHaveText(/Código v1 ● Privado/);
    await card.getByTestId("bot-visibility-private").click();
    await expect(card.getByTestId("visibility-quick")).toHaveText(/Bot ● Privado/);
    v1 = (await U.api.ok("GET", `/bots/${ID[A]}/versions`))[0];
    expect(v1.codePublic).toBe(false);
    expect((await U.api.ok("GET", `/bots/${ID[A]}`)).visibility).toBe("private");
    // La tabla de versiones MUESTRA el estado del código, pero no es un segundo editor.
    await openBotSection(page, "versiones");
    await expect(page.getByTestId("code-cell-1")).toHaveText("privado");
    await expect(page.getByTestId("code-cell-1").getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("code-visibility-1")).toHaveCount(0);
  });

  test("BOT_VISIBILITY_SECURITY · sin ser dueño no hay controles y la API lo niega; nada se publica solo", async ({
    browser,
    baseURL,
  }, info) => {
    // A en «equipo»: M (miembro) lo ve, pero en sólo lectura.
    await U.api.ok("PATCH", `/bots/${ID[A]}`, { visibility: "team" });
    const page = M.page;
    await page.setViewportSize({ width: 1280, height: 720 });
    await visit(page, `#/bots/${ID[A]}/visibilidad`);
    await expect(page.getByTestId("bot-visibility-readonly")).toContainText("Equipo");
    await expect(page.getByTestId("bot-visibility-control")).toHaveCount(0);
    await expect(page.getByTestId("code-visibility-readonly-1")).toHaveText("Código de v1: privado");
    await expect(page.getByRole("button", { name: "Público" })).toHaveCount(0);
    await shot(page, info, "ux255-visibilidad-solo-lectura");
    // La API manda: ni la ficha ni el código de un bot ajeno.
    expect((await M.api.raw("PATCH", `/bots/${ID[A]}`, { visibility: "public" })).status).toBe(403);
    expect((await M.api.raw("PUT", `/bots/${ID[A]}/versions/1/code-visibility`, { codePublic: true })).status).toBe(
      403,
    );
    expect((await U.api.ok("GET", `/bots/${ID[A]}/versions`))[0].codePublic).toBe(false);
    // C (privado, sin equipo para M): ni siquiera existe para M.
    await visit(page, `#/bots/${ID[C]}`);
    await expect(page.getByTestId("bot-pane-missing")).toBeVisible();
    // Anónimo: el código privado de una versión publicada no se lee.
    const anon = await browser.newContext({ ignoreHTTPSErrors: true, baseURL });
    const src = await anon.request.get(`/api/v1/bots/${ID[A]}/versions/1/files`);
    expect([401, 403, 404]).toContain(src.status());
    await anon.close();
    await U.api.ok("PATCH", `/bots/${ID[A]}`, { visibility: "private" });
  });

  test("TEAM_BULK_PERMISSION_DENIED · un miembro sin bots propios no cambia nada; un ajeno, 403", async ({
    browser,
    baseURL,
  }, info) => {
    const page = N.page;
    await page.setViewportSize({ width: 1280, height: 720 });
    await visit(page, "#/teams");
    await page.getByTestId(`team-item-${TEAM}`).click();
    const bulk = page.getByTestId("team-bulk-public");
    await bulk.getByTestId("team-bulk-open").click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByTestId("team-bulk-denied")).toContainText(A);
    await expect(dlg.getByTestId("team-bulk-denied")).toContainText(MB);
    await expect(dlg.getByTestId("team-bulk-will")).toContainText("Ninguno");
    await expect(dlg.getByTestId("team-bulk-nothing")).toBeVisible();
    await expect(dlg.getByTestId("team-bulk-confirm")).toBeDisabled();
    await shot(page, info, "ux255-team-bulk-denegado");
    await dlg.getByTestId("team-bulk-cancel").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(bulk.getByTestId("team-bulk-open")).toBeFocused();
    // Aunque lo fuerce por la API: 0 cambios, todos `not_authorized`.
    const r = await N.api.ok("POST", `/teams/${TEAM_ID.main}/actions/publish-bots`, { dryRun: false });
    expect(r.summary.changed).toBe(0);
    expect(r.results.every((x: { outcome: string }) => x.outcome === "not_authorized")).toBe(true);
    // Un usuario que no es del equipo: 403.
    const out = await newPerson(browser, baseURL!);
    expect((await out.api.raw("POST", `/teams/${TEAM_ID.main}/actions/publish-bots`, { dryRun: true })).status).toBe(
      403,
    );
    await out.page.context().close();
    for (const n of [A, B, C]) expect((await U.api.ok("GET", `/bots/${ID[n]}`)).visibility).toBe("private");
    expect((await M.api.ok("GET", `/bots/${ID[MB]}`)).visibility).toBe("private");
  });

  test("TEAM_BULK_PUBLIC · previsualización, confirmación, código intacto por defecto", async ({}, info) => {
    const page = U.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await visit(page, "#/teams");
    await page.getByTestId(`team-item-${TEAM_SOLO}`).click();
    const bulk = page.getByTestId("team-bulk-public");
    await bulk.getByTestId("team-bulk-open").click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByTestId(`bulk-will-${C}`)).toContainText(`✓ ${C}`);
    await expect(dlg.getByTestId("team-bulk-untouched")).toContainText(
      "el código fuente, las versiones ni el equipamiento",
    );
    const code = dlg.getByTestId("team-bulk-include-code");
    await expect(code).not.toBeChecked();
    // La casilla del código es aparte y explícita; C no tiene versión publicada.
    await code.check();
    await expect(dlg.getByTestId(`bulk-will-${C}`)).toContainText("sin versión publicada");
    await code.uncheck();
    await shot(page, info, "ux255-team-bulk-preview");
    // Nada cambia hasta confirmar.
    expect((await U.api.ok("GET", `/bots/${ID[C]}`)).visibility).toBe("private");
    await dlg.getByTestId("team-bulk-confirm").click();
    const res = page.getByTestId("team-bulk-result");
    await expect(res).toContainText("1 bot pasa a público");
    await expect(res.getByTestId(`bulk-result-${C}`)).toHaveAttribute("data-outcome", "made_public");
    expect((await U.api.ok("GET", `/bots/${ID[C]}`)).visibility).toBe("public");
  });

  test("TEAM_BULK_PARTIAL_RESULT · la capitana cambia SÓLO sus bots; el de M queda intacto y se dice", async ({}, info) => {
    const page = U.page;
    await page.setViewportSize({ width: 1280, height: 720 });
    await visit(page, "#/teams");
    await page.getByTestId(`team-item-${TEAM}`).click();
    await page.getByTestId("team-bulk-open").click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByTestId(`bulk-will-${A}`)).toBeVisible();
    await expect(dlg.getByTestId(`bulk-will-${B}`)).toBeVisible();
    await expect(dlg.getByTestId(`bulk-denied-${MB}`)).toContainText(`✗ ${MB}`);
    await expect(dlg.getByTestId("team-bulk-denied")).toContainText("no eres su dueño");
    await dlg.getByTestId("team-bulk-confirm").click();
    const res = page.getByTestId("team-bulk-result");
    await expect(res).toContainText("2 bots pasan a público");
    await expect(res).toContainText("1 sin autorización: no se han tocado");
    await expect(res.getByTestId(`bulk-result-${MB}`)).toHaveAttribute("data-outcome", "not_authorized");
    await shot(page, info, "ux255-team-bulk-parcial");
    for (const n of [A, B]) {
      expect((await U.api.ok("GET", `/bots/${ID[n]}`)).visibility).toBe("public");
      // CODE_PUBLIC=UNCHANGED.
      expect((await U.api.ok("GET", `/bots/${ID[n]}/versions`))[0].codePublic).toBe(false);
    }
    expect((await M.api.ok("GET", `/bots/${ID[MB]}`)).visibility).toBe("private");
  });

  test("BATTLE_LIVE_AND_BROADCAST_GROUPED · un único bloque: directo para todos, retransmitir sólo admin", async ({
    browser,
    baseURL,
  }, info) => {
    test.setTimeout(300_000);
    const page = U.page;
    await page.setViewportSize({ width: 1280, height: 720 });
    await visit(page, "#/battles/new");
    await pickBot(page, "rojo", A);
    await pickBot(page, "azul", B);
    liveBattle = await createBattle(page);
    await visit(page, `#/battles/${liveBattle}`);
    const block = page.getByTestId("live-broadcast");
    await expect(block.getByRole("heading", { name: "Directo y retransmisión" })).toBeVisible();
    // «Ver en directo» vive en el bloque (no dentro del estado) en cuanto arranca.
    await expect(block.getByTestId("watch-live")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("battle-live-note").getByRole("link")).toHaveCount(0);
    await expect(page.getByTestId("broadcast-battle")).toHaveCount(0); // U no es admin
    await expect(page.getByTestId("live-broadcast")).toHaveCount(1);
    await shot(page, info, "ux255-batalla-directo-usuario");

    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL });
    const adm = await ctx.newPage();
    await login(adm, ADMIN_EMAIL, PASSWORD);
    await adm.setViewportSize({ width: 1280, height: 720 });
    await visit(adm, `#/battles/${liveBattle}`);
    const ab = adm.getByTestId("live-broadcast");
    await expect(ab.getByTestId("watch-live")).toBeVisible();
    // Primero el estado: si el botón no sale, el fallo muestra el motivo real.
    await expect(ab.getByTestId("broadcast-status")).toContainText("Se puede retransmitir");
    await expect(ab.getByTestId("broadcast-battle")).toBeVisible();
    await expect(ab.getByTestId("broadcast-status")).toContainText("no empieza a emitir hasta que pulses «Iniciar»");
    // Un solo «Retransmitir» en toda la página.
    await expect(adm.getByText("Retransmitir", { exact: true })).toHaveCount(1);
    await shot(adm, info, "ux255-batalla-directo-admin");
    await ctx.close();
  });

  test("BATTLE_BROADCAST_PRESELECTS_TARGET · RETRANSMITIR abre Streaming con la batalla elegida y no emite", async ({
    browser,
    baseURL,
  }, info) => {
    test.skip(!liveBattle, "sin batalla en directo");
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL });
    const adm = await ctx.newPage();
    const writes: string[] = [];
    adm.on("request", (r) => {
      if (r.method() !== "GET" && r.url().includes("/admin/streaming/")) writes.push(`${r.method()} ${r.url()}`);
    });
    await login(adm, ADMIN_EMAIL, PASSWORD);
    await visit(adm, `#/battles/${liveBattle}`);
    const status = (await U.api.ok("GET", `/battles/${liveBattle}`)).status;
    test.skip(status === "finished" || status === "failed", `la batalla ya terminó (${status})`);
    await adm.getByTestId("broadcast-battle").click();
    await expect(adm).toHaveURL(new RegExp(`#/streaming\\?battle=${liveBattle}`));
    await expect(adm.getByTestId("simple-destination")).toHaveValue(`battle:${liveBattle}`);
    await shot(adm, info, "ux255-retransmitir-preseleccion");
    expect(writes).toEqual([]);
    await ctx.close();
  });

  test("FINISHED_BATTLE_NO_FAKE_REPLAY · terminada: resultado, replay normal y NUNCA «Retransmitir replay»", async ({
    browser,
    baseURL,
  }, info) => {
    test.skip(!REPLAY_ID, "sin batalla terminada del golden en este entorno");
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL });
    const adm = await ctx.newPage();
    await login(adm, ADMIN_EMAIL, PASSWORD);
    await visit(adm, `#/battles/${REPLAY_ID}`);
    const block = adm.getByTestId("live-broadcast");
    await expect(block.getByTestId("replay-not-broadcastable")).toContainText(
      "Replay: no disponible para retransmisión",
    );
    await expect(block.getByTestId("battle-replay-link")).toHaveAttribute("href", `#/replay/${REPLAY_ID}?t=0`);
    await expect(adm.getByTestId("broadcast-battle")).toHaveCount(0);
    await expect(adm.getByTestId("broadcast-battle-blocked")).toHaveCount(0);
    await expect(adm.getByTestId("watch-live")).toHaveCount(0);
    await expect(adm.getByText(/Retransmitir replay/i)).toHaveCount(0);
    await expect(adm.getByRole("button", { name: /Retransmitir/ })).toHaveCount(0);
    await expect(adm.getByRole("link", { name: /Retransmitir/ })).toHaveCount(0);
    await block.getByTestId("show-result").click();
    await expect(adm.locator("#battle-stats-title")).toBeFocused();
    await shot(adm, info, "ux255-batalla-terminada-admin");
    await ctx.close();
  });

  test("DESKTOP_LAYOUT_WIDE · área útil ancha y lista pegada al inicio en 1920/1440/1280", async ({}, info) => {
    const page = U.page;
    const widths: Record<string, { area: number; list: number; pane: number }> = {};
    for (const vp of VIEWPORTS.slice(0, 3)) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await visit(page, `#/bots/${ID[A]}/versiones`);
      const md = await box(page, "bots-master-detail");
      const list = (await page.locator(".master-list").first().boundingBox())!;
      const pane = await box(page, "bot-pane");
      const nav = await box(page, "bot-section-nav");
      const sec = await box(page, "bot-section");
      widths[vp.name] = { area: md.width, list: list.width, pane: pane.width };
      // Lista pegada al inicio del área útil, panel a su derecha y mucho más ancho.
      expect(Math.abs(list.x - md.x), `${vp.name}: lista al inicio`).toBeLessThanOrEqual(1);
      expect(pane.x).toBeGreaterThan(list.x + list.width - 1);
      expect(pane.width, `${vp.name}: panel ≥ 3× lista`).toBeGreaterThanOrEqual(list.width * 3);
      // Menú de secciones vertical a la izquierda de la sección.
      expect(nav.x + nav.width, `${vp.name}: menú a la izquierda`).toBeLessThanOrEqual(sec.x + 1);
      expect(await hOverflow(page)).toBeLessThanOrEqual(1);
      await shot(page, info, `ux255-layout-${vp.name}`);
    }
    expect(widths["1920x1080"].area, "≥1600: ~1400-1500").toBeGreaterThanOrEqual(1400);
    expect(widths["1920x1080"].area).toBeLessThanOrEqual(1500);
    expect(widths["1440x900"].area, "1200-1599: 1100-1300").toBeGreaterThanOrEqual(1100);
    expect(widths["1440x900"].area).toBeLessThanOrEqual(1300);
    expect(widths["1280x720"].area).toBeGreaterThanOrEqual(1100);
    expect(widths["1280x720"].area).toBeLessThanOrEqual(1300);
    // Antes: 960 px en cualquier escritorio.
    expect(widths["1280x720"].pane).toBeGreaterThan(800);
  });

  test("TABLET_LAYOUT · 1024×768 y 768×1024: la lista se estrecha y las secciones pasan a pestañas encima", async ({}, info) => {
    const page = U.page;
    let prevList = Infinity;
    for (const vp of VIEWPORTS.slice(3, 5)) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await visit(page, `#/bots/${ID[A]}/codigo`);
      const list = (await page.locator(".master-list").first().boundingBox())!;
      const pane = await box(page, "bot-pane");
      const nav = await box(page, "bot-section-nav");
      const sec = await box(page, "bot-section");
      expect(pane.x, `${vp.name}: lista y panel lado a lado`).toBeGreaterThan(list.x + list.width - 1);
      expect(list.width).toBeLessThanOrEqual(prevList);
      prevList = list.width;
      expect(nav.y + nav.height, `${vp.name}: pestañas encima`).toBeLessThanOrEqual(sec.y + 1);
      const area = await page.getByLabel("codigo").boundingBox();
      expect(area!.x + area!.width).toBeLessThanOrEqual(vp.width);
      expect(await hOverflow(page)).toBeLessThanOrEqual(1);
      await shot(page, info, `ux255-layout-${vp.name}`);
    }
  });

  test("MOBILE_LAYOUT · 390×844 y 360×640: una sola columna, menú en pestañas, editor y botones a mano", async ({}, info) => {
    const page = U.page;
    for (const vp of VIEWPORTS.slice(5)) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await visit(page, `#/bots/${ID[A]}/codigo`);
      const list = (await page.locator(".master-list").first().boundingBox())!;
      const pane = await box(page, "bot-pane");
      expect(pane.y, `${vp.name}: panel debajo de la lista`).toBeGreaterThanOrEqual(list.y + list.height - 1);
      expect(pane.width).toBeGreaterThan(vp.width - 60);
      const nav = page.getByTestId("bot-section-nav");
      await nav.getByRole("link", { name: "Versiones y build" }).click();
      await expect(page.getByTestId("bot-section")).toHaveAttribute("data-section", "versiones");
      const navBox = (await nav.boundingBox())!;
      expect(navBox.x + navBox.width).toBeLessThanOrEqual(vp.width);
      // Objetivos táctiles del menú ≥ 44 px.
      const h = await nav.getByRole("link", { name: "Resumen" }).evaluate((a) => a.getBoundingClientRect().height);
      expect(h).toBeGreaterThanOrEqual(44);
      expect(await hOverflow(page)).toBeLessThanOrEqual(1);
      await shot(page, info, `ux255-layout-${vp.name}`);
    }
  });

  test("NO_HORIZONTAL_OVERFLOW · bot (todas las secciones), equipos con la confirmación abierta y batalla en las 7 resoluciones", async ({}, info) => {
    test.setTimeout(240_000);
    const page = U.page;
    const bad: string[] = [];
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const sec of ["", "visibilidad", "equipamiento", "codigo", "versiones", "batallas", "replays"]) {
        await visit(page, sec ? `#/bots/${ID[A]}/${sec}` : `#/bots/${ID[A]}`);
        const o = await hOverflow(page);
        if (o > 1) bad.push(`${vp.name} bot/${sec || "resumen"}: ${o}px`);
        // Botones y controles del contenido dentro de la pantalla (las pestañas del menú
        // desplazan DENTRO de su barra en móvil, por eso se miden aparte).
        const out = await page.evaluate((w) => {
          const els = Array.from(
            document.querySelectorAll<HTMLElement>(
              "[data-testid='bot-section'] button, [data-testid='bot-section'] textarea, [data-testid='bot-section'] select",
            ),
          );
          return els
            .filter((e) => e.offsetParent !== null && !e.closest("details:not([open])"))
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return r.right > w + 1 || r.left < -1;
            })
            .map((e) => e.textContent?.trim().slice(0, 30) || e.tagName);
        }, vp.width);
        if (out.length) bad.push(`${vp.name} bot/${sec || "resumen"}: fuera ${out.join(", ")}`);
      }
      await visit(page, "#/teams");
      await page.getByTestId(`team-item-${TEAM}`).click();
      await page.getByTestId("team-bulk-open").click();
      const dlg = page.getByRole("dialog");
      await expect(dlg.getByTestId("team-bulk-confirm")).toBeVisible();
      for (const t of ["team-bulk-confirm", "team-bulk-cancel"]) {
        const b = (await dlg.getByTestId(t).boundingBox())!;
        if (b.x < 0 || b.x + b.width > vp.width + 1) bad.push(`${vp.name} teams: ${t} fuera`);
      }
      const ot = await hOverflow(page);
      if (ot > 1) bad.push(`${vp.name} teams+confirmación: ${ot}px`);
      await shot(page, info, `ux255-teams-confirm-${vp.name}`);
      await dlg.getByTestId("team-bulk-cancel").click();
      if (liveBattle) {
        await visit(page, `#/battles/${liveBattle}`);
        const ob = await hOverflow(page);
        if (ob > 1) bad.push(`${vp.name} batalla: ${ob}px`);
      }
    }
    expect(bad).toEqual([]);
  });
});
