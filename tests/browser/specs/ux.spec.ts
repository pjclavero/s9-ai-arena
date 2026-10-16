/**
 * FC-D (D1/D2/D8/D9) · Login, navegación, 404, estados y errores visibles en
 * navegador real contra la API real (fase 1: todo el entorno vivo).
 */
import { test, expect } from "@playwright/test";
import { go, login, registerNewUser, shot, watchProblems } from "./helpers.js";

test.describe("@fase1 UX y navegación", () => {
  test("login con contraseña incorrecta muestra el error real del servidor", async ({ page }, info) => {
    await page.goto("/");
    await page.getByLabel("email").fill("nadie@example.internal");
    await page.getByLabel("contraseña").fill("contraseña-incorrecta-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    const err = page.getByTestId("login-error");
    await expect(err).toBeVisible();
    await expect(err).not.toBeEmpty();
    await shot(page, info, "ux-login-error");
  });

  test("registro → panel; F5 conserva la sesión (cookie httpOnly)", async ({ page }, info) => {
    const problems = watchProblems(page);
    await registerNewUser(page);
    await expect(page.getByRole("navigation", { name: "principal" })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("logout")).toBeVisible();
    await shot(page, info, "ux-panel-tras-f5");
    expect(problems).toEqual([]);
  });

  test("ruta desconocida ⇒ página 404 con Volver; ya no cae en «Mis bots»", async ({ page }, info) => {
    await registerNewUser(page);
    await go(page, "#/battles");
    await expect(page.getByRole("heading", { name: "Batallas" })).toBeVisible();
    await go(page, "#/esto-no-existe");
    const nf = page.getByTestId("not-found");
    await expect(nf).toBeVisible();
    await expect(nf).toContainText("#/esto-no-existe");
    await shot(page, info, "ux-404");
    await nf.getByRole("button", { name: "Volver" }).click();
    await expect(page.getByRole("heading", { name: "Batallas" })).toBeVisible();
  });

  test("lista vacía de batallas es un estado vacío con siguiente paso, no una tabla muda", async ({ page }, info) => {
    await registerNewUser(page);
    await go(page, "#/battles");
    // La BD efímera puede tener batallas de otras specs: o hay filas, o hay estado vacío; nunca nada.
    await expect(page.getByTestId("battles-empty").or(page.getByTestId("battle-row").first())).toBeVisible();
    await shot(page, info, "ux-batallas");
  });

  test("un torneo inexistente da un error 404 clasificado, no una pantalla vacía", async ({ page }, info) => {
    await registerNewUser(page);
    await go(page, "#/tournaments/00000000-0000-4000-8000-000000000000");
    const alert = page.locator('[data-error-kind="notFound"]').first();
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("No existe");
    await shot(page, info, "ux-torneo-404");
  });

  test("una pantalla de admin para un usuario normal dice «No tienes permiso» (403 real)", async ({ page }, info) => {
    await registerNewUser(page);
    await go(page, "#/system");
    const alert = page.locator('[data-error-kind="forbidden"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("No tienes permiso");
    await shot(page, info, "ux-system-403");
  });

  test("bots, mapas y equipos cargan contra la API real sin estado de error", async ({ page }, info) => {
    const problems = watchProblems(page);
    await registerNewUser(page);
    await go(page, "#/bots");
    await expect(page.getByLabel("nuevo-bot")).toBeVisible();
    await page.getByLabel("nuevo-bot").fill("bot-e2e");
    await page.getByRole("button", { name: "Crear bot" }).click();
    await expect(page.getByText("bot-e2e").first()).toBeVisible();
    await shot(page, info, "ux-bots");
    await go(page, "#/maps");
    await expect(page.getByText("mvp-arena-01").first()).toBeVisible();
    await shot(page, info, "ux-mapas");
    await go(page, "#/teams");
    await expect(page.getByRole("heading").first()).toBeVisible();
    await expect(page.locator('[data-testid^="resource-error-"]')).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test("usuario semilla organizer entra y ve el panel", async ({ page }) => {
    const email = process.env.S9_E2E_DEV_EMAIL ?? "";
    const password = process.env.S9_E2E_DEV_PASSWORD ?? "";
    expect(email, "faltan credenciales semilla del entorno efímero").not.toBe("");
    expect(password).not.toBe("");
    await login(page, email, password);
    await expect(page.getByTestId("logout")).toBeVisible();
  });
});
