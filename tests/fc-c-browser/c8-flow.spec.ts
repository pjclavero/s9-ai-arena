/**
 * FC-C · C8 · Recorrido de navegador REAL (Chromium de la imagen oficial de
 * Playwright) contra API real + PostgreSQL real + SPA real (tests/fc-c-browser/serve.ts):
 *
 *   registro → bots (equipamiento/loadout guardado, código, validación, publicación)
 *   → equipo (crear, añadir bot) → mapa en el editor (crear, guardar, F5, reabrir,
 *   editar, guardar, publicar) → logout/login → todo recuperado → formulario de
 *   nueva batalla (modo, ruleset de la API, mapa propio, equipo, bots) → 202.
 *
 * Cada paso que dice "persiste" se comprueba también en BD (/__e2e/db/*, lectura).
 */
import { test, expect, type Page } from "@playwright/test";

const EMAIL = `fc-c-${Date.now()}@example.internal`;
const PASSWORD = "fc-c-e2e-password-largo!";
const MAP_ID = `fc-c-e2e-${Date.now().toString(36)}`;

async function register(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Crear cuenta" }).click();
  await page.getByLabel("nombre").fill("E2E C");
  await page.getByLabel("email").fill(EMAIL);
  await page.getByLabel("contraseña").fill(PASSWORD);
  await page.getByRole("button", { name: "Registrarse y entrar" }).click();
  await expect(page.getByTestId("logout")).toBeVisible();
}

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("email").fill(EMAIL);
  await page.getByLabel("contraseña").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByTestId("logout")).toBeVisible();
}

async function publishedBot(page: Page, name: string) {
  await page.goto("/#/bots");
  await page.getByLabel("nuevo-bot").fill(name);
  await page.getByRole("button", { name: "Crear bot" }).click();
  await page.getByRole("button", { name, exact: true }).click();
  // Equipamiento: el loadout del ejemplo del catálogo (artillero medio).
  await page.getByLabel("chasis").selectOption("chassis.medium@1");
  await page.getByLabel("slot-drive").selectOption("movement.tracks@1");
  await page.getByLabel("slot-power").selectOption("power.battery@1");
  await page.getByLabel("slot-sensor_a").selectOption("sensor.lidar360@1");
  await page.getByLabel("slot-turret_main").selectOption("weapon.cannon@1");
  await page.getByLabel("slot-armor_front").selectOption("armor.steel_front@1");
  // C4 · la UI dice la verdad sobre el efecto real del equipamiento
  await expect(page.getByTestId("effect-note")).toContainText("familia del chasis");
  await expect(page.getByTestId("effect-chassis")).toHaveAttribute("data-effect", "ACTIVE");
  await expect(page.getByTestId("effect-slot-turret_main")).toHaveAttribute("data-effect", "PARTIAL");
  await page.getByTestId("effect-detail-turret_main").locator("summary").click();
  await expect(page.getByTestId("effect-detail-turret_main")).toContainText("rangeM");
  await expect(page.getByTestId("effect-detail-turret_main")).toContainText("FUTURE");
  await page.getByTestId("save-loadout").click();
  await expect(page.getByTestId("saved")).toBeVisible();
  await page.getByLabel("codigo").fill("print('hola')");
  await page.getByRole("button", { name: "Subir como versión nueva" }).click();
  await page.getByRole("button", { name: "Enviar a validación v1" }).click();
  await page.getByRole("button", { name: "Publicar v1" }).click();
  await expect(page.getByTestId("version-row-1")).toContainText("published");
}

test("C8 · usuario → equipamiento → equipo → mapa → logout/login → nueva batalla 202", async ({ page, request }) => {
  test.setTimeout(240_000);
  await register(page);

  // --- bots con equipamiento guardado ------------------------------------
  await publishedBot(page, "e2e-rojo");
  await publishedBot(page, "e2e-azul");

  // --- equipo ------------------------------------------------------------
  await page.goto("/#/teams");
  await page.getByLabel("nuevo-equipo").fill("E2E Rojos");
  await page.getByRole("button", { name: "Crear equipo" }).click();
  const team = page.getByRole("region", { name: "equipo E2E Rojos" });
  await expect(team).toBeVisible();
  await team.getByLabel("añadir-bot-E2E Rojos").selectOption({ label: "e2e-rojo" });
  await team.getByRole("button", { name: "Añadir bot" }).click();
  await expect(team.getByText("e2e-rojo")).toBeVisible();

  // --- mapa: crear → guardar → F5 → reabrir → editar → guardar → publicar --
  await page.goto("/#/maps/editor");
  await page.getByLabel("id del mapa").fill(MAP_ID);
  await page.getByLabel("nombre del mapa").fill("Mapa E2E uno");
  await page.getByRole("button", { name: "Añadir wall" }).click();
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-notice")).toContainText(`${MAP_ID} v1`);
  expect(await (await request.get(`/__e2e/db/map/${MAP_ID}`)).json()).toEqual([
    { version: 1, state: "draft", name: "Mapa E2E uno" },
  ]);

  await page.reload(); // C3 · F5
  await expect(page.getByLabel("nombre del mapa")).toHaveValue("Mapa E2E uno");
  await expect(page.getByTestId("editor-current")).toHaveText(`${MAP_ID} v1`);

  await page.getByLabel("nombre del mapa").fill("Mapa E2E final");
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-notice")).toContainText(`${MAP_ID} v1`);
  await page.getByTestId("editor-publish").click();
  await expect(page.getByTestId("editor-notice")).toContainText("Publicado");
  expect(await (await request.get(`/__e2e/db/map/${MAP_ID}`)).json()).toEqual([
    { version: 1, state: "published", name: "Mapa E2E final" },
  ]);

  // --- logout / login: todo se recupera del servidor ---------------------
  await page.getByTestId("logout").click();
  await login(page);
  await page.goto("/#/maps");
  await expect(page.getByRole("cell", { name: new RegExp(`Mapa E2E final · ${MAP_ID} \\(tuyo\\)`) })).toBeVisible();
  await page.goto("/#/teams");
  await expect(page.getByRole("region", { name: "equipo E2E Rojos" }).getByText("e2e-rojo")).toBeVisible();

  // --- nueva batalla: TODO elegido en el formulario ----------------------
  await page.goto("/#/battles/new");
  await expect(page.getByLabel("modo")).toHaveValue("deathmatch");
  await expect(page.getByLabel("ruleset")).toHaveValue("deathmatch-mvp"); // id de la BD, servido por /rulesets
  await page.getByLabel("mapa").selectOption(`${MAP_ID}@1`);
  await page.getByLabel("equipo rojo").selectOption({ label: "E2E Rojos" });
  await page.getByLabel("bot rojo").selectOption({ label: "e2e-rojo (v1)" });
  await page.getByLabel("bot azul").selectOption({ label: "e2e-azul (v1)" });
  const created = page.waitForResponse((r) => r.url().endsWith("/api/v1/battles") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Crear batalla" }).click();
  const resp = await created;
  expect(resp.status()).toBe(202);
  await expect(page.getByText(/creada y encolada/)).toBeVisible();
  const battleId = (await resp.json()).id;
  const row = await (await request.get(`/__e2e/db/battle/${battleId}`)).json();
  expect(row).toMatchObject({ mode: "deathmatch", ruleset_id: "deathmatch-mvp", map_id: MAP_ID, map_version: 1 });
});
