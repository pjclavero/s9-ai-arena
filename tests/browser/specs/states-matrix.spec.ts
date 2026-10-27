/**
 * UX-E · MATRIZ DE ESTADOS página × estado (fase 1, entorno aislado de run.sh).
 *
 * «Vacío», «éxito parcial», 403 y 404 son REALES: usuario recién registrado
 * contra la API real (sin batallas propias, sin rol admin, ids inexistentes).
 * 422, 409, 429, 500, 503, red caída, plazo vencido y sesión caducada no se
 * pueden provocar a voluntad en un entorno sano, así que SÓLO para esos se
 * sustituye la respuesta con `page.route` (lo legítimo para una matriz de
 * estados; no reemplaza el E2E real, que es golden-path).
 *
 * Qué se exige en TODAS las rutas y estados:
 *  - nada de «Cargando…» eterno;
 *  - ningún texto prohibido (undefined, null, [object Object], trazas, JSON crudo);
 *  - con la API fallando, la pantalla DICE que ha fallado (alerta o error
 *    clasificado), nunca una lista vacía muda.
 * El resultado de cada celda se vuelca en $S9_E2E_OUT/states-matrix.json.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { OUT, login } from "./helpers.js";
import { PANEL_ROUTES, PUBLIC_ROUTES, ZERO, forbiddenLines, mainText, showsError, visit } from "./ux-e-lib.js";

type Cell = {
  route: string;
  state: string;
  error: boolean;
  forbidden: string[];
  excerpt: string;
  kind?: string;
  stuckLoading?: boolean;
  known?: string;
};
/**
 * Una línea JSON por celda, escrita AL MOMENTO: si un test falla, Playwright
 * reinicia el worker y un volcado en afterAll perdería las celdas anteriores.
 */
const cells = {
  push(c: Cell) {
    mkdirSync(OUT, { recursive: true });
    appendFileSync(`${OUT}/states-matrix.jsonl`, JSON.stringify(c) + "\n");
  },
};

/**
 * Defectos YA asignados a páginas de otros carriles: la celda se registra pero
 * no se exige (se quita de aquí cuando el carril dueño lo corrija). Clave
 * `<ruta>|<estado>`; `*` = cualquier estado simulado de fallo.
 */
const KNOWN: Record<string, string> = {
  "#/maps/editor|*": "UX-C: MapEditorPage se queda en «Cargando…» para siempre si falla la lista de mapas",
  "#/bots|429": "UX-B: BotsPage no enseña el fallo de la lista de bots con 429/503/red",
  "#/bots|503": "UX-B: BotsPage no enseña el fallo de la lista de bots con 429/503/red",
  "#/bots|api-unavailable": "UX-B: BotsPage no enseña el fallo de la lista de bots con 429/503/red",
  [`#/viewer/${ZERO}|404`]: "UX-D: ViewerPage dice «no existe» sin role=alert y sigue pintando el HUD vacío",
};
function known(route: string, state: string): string | undefined {
  return KNOWN[`${route}|${state}`] ?? (state in SIMULATED ? KNOWN[`${route}|*`] : undefined);
}

/**
 * UNA cuenta para toda la matriz (alta por la API real): el alta tiene límite
 * de 30/min por IP y cada test hace login con ella (límite 60/min).
 */
const ACCOUNT = { email: `uxe-${randomUUID().slice(0, 8)}@example.internal`, password: `uxe-${randomUUID()}` };
test.beforeAll(async ({ request }) => {
  const r = await request.post("/api/v1/auth/register", {
    data: { email: ACCOUNT.email, password: ACCOUNT.password, displayName: "Piloto UX-E" },
  });
  expect([200, 201], `alta de la cuenta de la matriz: ${r.status()}`).toContain(r.status());
});
const enter = (page: Page) => login(page, ACCOUNT.email, ACCOUNT.password);

/** Peticiones de sesión/catálogo que NO se tocan: el objetivo es la página, no el arranque. */
function isSessionOrCatalog(url: string): boolean {
  return /\/api\/v1\/(auth\/|users\/me|catalog\/)/.test(url);
}

/** Estado simulado → cómo responde la API a las peticiones de la página. */
const SIMULATED: Record<string, (route: Route) => Promise<void>> = {
  "429": (r) =>
    r.fulfill({
      status: 429,
      contentType: "application/json",
      headers: { "Retry-After": "30" },
      body: JSON.stringify({ code: "too_many_requests", message: "Límite de peticiones superado" }),
    }),
  "500": (r) =>
    r.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ code: "internal", message: "Error interno" }),
    }),
  // 503 con HTML, como lo da un proxy delante de un servicio caído.
  "503": (r) => r.fulfill({ status: 503, contentType: "text/html", body: "<html><body>503</body></html>" }),
  "api-unavailable": (r) => r.abort("connectionrefused"),
};

async function record(page: Page, route: string, state: string, mustShowError: boolean) {
  const knownDefect = known(route, state);
  let stuckLoading = false;
  try {
    await visit(page, route, knownDefect ? 20_000 : 25_000);
  } catch (e) {
    if (!knownDefect) throw e;
    stuckLoading = true;
  }
  const text = await mainText(page);
  const error = await showsError(page);
  // Lectura instantánea (evaluate): `locator.getAttribute` ESPERA al elemento y
  // colgaba la celda entera cuando la pantalla no tiene error.
  const kind =
    (await page.evaluate(
      () => document.querySelector("main [data-error-kind]")?.getAttribute("data-error-kind") ?? null,
    )) ?? undefined;
  const cell: Cell = {
    route,
    state,
    error,
    forbidden: forbiddenLines(text),
    excerpt: text.slice(0, 300),
    kind,
    stuckLoading,
    known: knownDefect,
  };
  cells.push(cell);
  expect.soft(cell.forbidden, `${route} [${state}]: texto prohibido`).toEqual([]);
  if (mustShowError && !knownDefect)
    expect.soft(error, `${route} [${state}]: el fallo no se ve (¿lista vacía muda?)`).toBe(true);
}

/**
 * Rutas que no piden nada a la API con un usuario normal (no pueden fallar por
 * la API): Administración se oculta por rol y la 404 es local.
 */
const NO_API_FOR_USER = new Set(["#/admin", "#/ruta-que-no-existe"]);

test.describe("@fase1 UX-E matriz de estados", () => {
  test("vacío / 403 / 404 REALES: usuario nuevo en todas las rutas del panel", async ({ page }) => {
    test.setTimeout(240_000);
    await enter(page);
    for (const r of PANEL_ROUTES) {
      // 404 real en rutas con id inexistente, 403 real en las de admin, vacío en el resto.
      const state = r.includes(ZERO) ? "404" : /system|audit|roles|admin/.test(r) ? "403" : "empty";
      await record(page, r, state, state !== "empty");
    }
  });

  test("rutas públicas sin sesión: vacío/404 reales", async ({ page }) => {
    await page.goto("/");
    for (const r of PUBLIC_ROUTES) await record(page, r, r.includes(ZERO) ? "404" : "empty", r.includes(ZERO));
  });

  for (const [state, respond] of Object.entries(SIMULATED)) {
    test(`API con ${state}: cada pantalla del panel dice que ha fallado`, async ({ page }) => {
      test.setTimeout(240_000);
      await enter(page);
      await page.route("**/api/v1/**", (route) =>
        isSessionOrCatalog(route.request().url()) ? route.continue() : respond(route),
      );
      for (const r of PANEL_ROUTES) await record(page, r, state, !NO_API_FOR_USER.has(r));
    });
  }

  test("API con 429: el aviso dice cuánto esperar (Retry-After)", async ({ page }) => {
    await enter(page);
    await page.route("**/api/v1/**", (route) =>
      isSessionOrCatalog(route.request().url()) ? route.continue() : SIMULATED["429"](route),
    );
    await visit(page, "#/teams");
    await expect(page.locator("main [data-error-kind]").first()).toContainText("espera 30 s");
  });

  test("plazo vencido: la petición que no vuelve acaba en «El servidor tarda demasiado», no en Cargando eterno", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await enter(page);
    // La petición se queda colgada; el cliente aborta a los 15 s (API_TIMEOUT_MS).
    await page.route("**/api/v1/**", (route) =>
      isSessionOrCatalog(route.request().url()) ? route.continue() : undefined,
    );
    for (const r of ["#/teams", "#/battles"]) {
      await visit(page, r, 40_000);
      await expect(page.locator('main [data-error-kind="timeout"]').first()).toBeVisible();
      await record(page, r, "timeout", true);
    }
  });

  test("sesión caducada EN USO (refresh rechazado): vuelve al login con aviso, sin pantalla rota", async ({ page }) => {
    await enter(page);
    await page.route("**/api/v1/**", (route) => {
      const url = route.request().url();
      if (/\/auth\/refresh/.test(url) || !isSessionOrCatalog(url))
        return route.fulfill({ status: 401, contentType: "application/json", body: '{"message":"jwt expired"}' });
      return route.continue();
    });
    await page.evaluate(() => (window.location.hash = "#/teams"));
    await expect(page.getByTestId("session-notice")).toContainText("sesión ha caducado");
    await expect(page.getByLabel("email")).toBeVisible();
    cells.push({ route: "#/teams", state: "session-expired", error: true, forbidden: [], excerpt: "login + aviso" });
  });

  test("sesión con el refresh CAÍDO (502): NO se echa al usuario al login", async ({ page }) => {
    await enter(page);
    await page.route("**/api/v1/**", (route) => {
      const url = route.request().url();
      if (/\/auth\/refresh/.test(url))
        return route.fulfill({ status: 502, contentType: "text/html", body: "<html>502</html>" });
      if (!isSessionOrCatalog(url))
        return route.fulfill({ status: 401, contentType: "application/json", body: '{"message":"jwt expired"}' });
      return route.continue();
    });
    await visit(page, "#/teams");
    await expect(page.getByTestId("logout")).toBeVisible();
    await expect(page.locator('main [data-error-kind="unavailable"]').first()).toBeVisible();
    cells.push({ route: "#/teams", state: "refresh-502", error: true, forbidden: [], excerpt: "sigue en el panel" });
  });

  test("422 y 409 al crear un bot: título, mensaje y detalle por campo, sin JSON crudo", async ({ page }) => {
    await enter(page);
    const replies = [
      {
        status: 422,
        body: { code: "validation", message: "Datos no válidos", details: [{ path: "/name", message: "obligatorio" }] },
        expect: "name: obligatorio",
      },
      {
        status: 409,
        body: { code: "conflict", message: "Ya tienes un bot con ese nombre" },
        expect: "Ya tienes un bot",
      },
    ];
    for (const r of replies) {
      await page.unrouteAll();
      await page.route("**/api/v1/bots", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body) })
          : route.continue(),
      );
      await visit(page, "#/bots");
      await page.getByLabel("nuevo-bot").fill("AUDIT-UXE-bot");
      await page.getByRole("button", { name: "Crear bot" }).click();
      const err = page.getByTestId("create-bot-error");
      await expect(err).toContainText(r.expect);
      const text = await err.innerText();
      expect(forbiddenLines(text)).toEqual([]);
      cells.push({ route: "#/bots (crear)", state: String(r.status), error: true, forbidden: [], excerpt: text });
    }
  });
});
