/**
 * UX-A · ONBOARDING en navegador real, contra la API real del entorno efímero
 * (sin mocks): visitante → portada → ayuda/glosario → registro → checklist de
 * primeros pasos (que cambia con el estado REAL tras crear un bot) → 404 con
 * navegación. Va en @fase1 (todo vivo); run.sh la recoge por la etiqueta.
 */
import { test, expect } from "@playwright/test";
import { go, registerNewUser, shot, watchProblems } from "./helpers.js";

test.describe("@fase1 Onboarding (UX-A)", () => {
  test("un visitante entiende qué es S9, lee la guía y sabe qué hacer después de registrarse", async ({
    page,
  }, info) => {
    const problems = watchProblems(page);

    // --- portada pública: qué es S9 + cómo empezar, junto al acceso -----------
    await page.goto("/");
    const landing = page.getByTestId("landing");
    await expect(landing).toBeVisible();
    await expect(landing).toContainText("arena de programación");
    await expect(page.getByLabel("email")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "principal" });
    await expect(nav.getByRole("link", { name: "Ayuda" })).toBeVisible();
    await shot(page, info, "onboarding-portada");

    // --- ayuda: recorrido, glosario y documentación ---------------------------
    await landing.getByRole("link", { name: /guía/ }).click();
    const help = page.getByTestId("help-page");
    await expect(help).toBeVisible();
    await expect(help.getByTestId("help-journey").locator("li")).toHaveCount(9);
    const glossary = help.getByTestId("help-glossary");
    for (const term of ["Runtime", "Loadout", "Estados de una versión", "Artifact", "Ruleset", "Equipo vs bando"]) {
      await expect(glossary.getByText(term, { exact: true })).toBeVisible();
    }
    await expect(help.getByTestId("help-docs").getByRole("link").first()).toHaveAttribute(
      "href",
      /^https:\/\/github\.com\/pjclavero\/s9-ai-arena\//,
    );
    await shot(page, info, "onboarding-ayuda");
    // #/docs (antes «Página no encontrada») es la misma guía.
    await go(page, "#/docs");
    await expect(page.getByTestId("help-page")).toBeVisible();
    await expect(page.getByTestId("not-found")).toHaveCount(0);

    // --- la barra existe también en las pantallas públicas (C-G10) -------------
    await nav.getByRole("link", { name: "Ranking" }).click();
    await expect(nav.getByRole("link", { name: "Ranking" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Inicio" })).toBeVisible();

    // --- registro → checklist de primeros pasos con el estado real -------------
    await registerNewUser(page); // vuelve a "/" y se registra por la UI real
    const steps = page.getByTestId("first-steps");
    await expect(steps).toBeVisible();
    await expect(steps.getByTestId("first-step-account")).toHaveAttribute("data-done", "true");
    await expect(steps.getByTestId("first-step-bot")).toHaveAttribute("data-done", "false");
    await expect(steps.getByTestId("first-steps-next")).toHaveText("Crea tu primer bot");
    await shot(page, info, "onboarding-checklist-nuevo");

    // El siguiente paso lleva a donde se hace; tras crear el bot, la checklist avanza.
    await steps.getByTestId("first-steps-progress").getByRole("link", { name: "Ir a Mis bots" }).click();
    await page.getByLabel("nuevo-bot").fill(`onb-${Date.now().toString(36)}`);
    await page.getByRole("button", { name: "Crear bot" }).click();
    await expect(page.getByTestId(/^bot-detail-link-/).first()).toBeVisible();
    await nav.getByRole("link", { name: "Inicio" }).click();
    await expect(steps.getByTestId("first-step-bot")).toHaveAttribute("data-done", "true");
    await expect(steps.getByTestId("first-steps-next")).toHaveText("Configura su equipamiento (loadout)");
    await shot(page, info, "onboarding-checklist-con-bot");

    // --- 404 con navegación de vuelta ------------------------------------------
    await go(page, "#/esto-tampoco-existe");
    const nf = page.getByTestId("not-found");
    await expect(nf).toBeVisible();
    await expect(nav).toBeVisible();
    await nf.getByRole("link", { name: "Ayuda" }).click();
    await expect(page.getByTestId("help-page")).toBeVisible();

    expect(problems).toEqual([]);
  });
});
